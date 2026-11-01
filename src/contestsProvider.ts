import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type {
  ProblemDetail,
  ProblemLanguage,
  ProblemLimit,
} from "./ejudgeParsers";
import { GistJsonStore } from "./gistSync";

export interface ContestProxy {
  host: string;
  port: number;
  username?: string;
}

export interface Contest {
  id: string;
  label: string;
  url: string;
  login: string;

  loginFieldName?: string;
  passwordFieldName?: string;
  fileFieldName?: string;
  submitButtonName?: string;

  proxy?: ContestProxy;

  // Регулярное выражение для группировки задач по названию. Задачи с одинаковым
  // ключом (первая группа захвата, а без неё — всё совпадение) попадают в одну группу.
  groupRegex?: string;
  // Ключи скрытых групп задач.
  hiddenGroups?: string[];
  // Время последнего изменения (мс) — по нему разрешаются конфликты при синхронизации.
  updatedAt?: number;
}

export interface CachedStatement {
  title: string;
  statementHtml: string;
  limits: ProblemLimit[];
  languages: ProblemLanguage[];
  fixedLanguageLabel?: string;
  savedAt: number;
}

// Payload от формы contestSettingsPanel.ts.
export interface ContestFormData {
  id?: string;
  label: string;
  url: string;
  login: string;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  groupRegex?: string;
}

interface StoreData {
  contests: Contest[];
  // id удалённого контеста -> время удаления (чтобы он не вернулся при синхронизации).
  deleted: Record<string, number>;
}

// Локальная копия лежит в globalState, общая — в секретном gist (без паролей).
// Пароли хранятся только в SecretStorage и никуда не синхронизируются.
const STORE_KEY = "ejudge.store";
const LEGACY_CONTESTS_KEY = "ejudge.contests";

const SECRET_PASSWORD = "ejudge.password.";
const SECRET_PROXY_PASSWORD = "ejudge.proxyPassword.";

const SYNC_DEBOUNCE_MS = 2000;
const PULL_THROTTLE_MS = 60000;

function emptyStore(): StoreData {
  return { contests: [], deleted: {} };
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );
}

// Копируем только известные поля — всё лишнее из старых версий отбрасывается.
function pickContest(c: any, hiddenGroups?: string[]): Contest {
  return {
    id: c.id,
    label: c.label,
    url: c.url,
    login: c.login,
    loginFieldName: c.loginFieldName,
    passwordFieldName: c.passwordFieldName,
    fileFieldName: c.fileFieldName,
    submitButtonName: c.submitButtonName,
    proxy: c.proxy,
    groupRegex: c.groupRegex,
    hiddenGroups: hiddenGroups ?? c.hiddenGroups,
    updatedAt: c.updatedAt
  };
}

function canonical(data: StoreData): string {
  return stable({ contests: data.contests, deleted: data.deleted });
}

function mergeStores(local: StoreData, remote: Partial<StoreData>): StoreData {
  const deleted: Record<string, number> = { ...(remote.deleted || {}) };
  for (const [id, time] of Object.entries(local.deleted))
    deleted[id] = Math.max(deleted[id] ?? 0, time);

  const byId = new Map<string, Contest>();
  for (const contest of [...(remote.contests || []), ...local.contests]) {
    const prev = byId.get(contest.id);
    if (!prev || (contest.updatedAt ?? 0) >= (prev.updatedAt ?? 0))
      byId.set(contest.id, contest);
  }
  for (const [id, time] of Object.entries(deleted)) {
    const contest = byId.get(id);
    if (contest && (contest.updatedAt ?? 0) <= time) byId.delete(id);
  }
  return { contests: Array.from(byId.values()), deleted };
}

export class ContestItem extends vscode.TreeItem {
  constructor(public readonly contest: Contest) {
    super(contest.label, vscode.TreeItemCollapsibleState.None);
    this.description = contest.login ? `(${contest.login})` : undefined;
    this.tooltip = contest.url;
    this.contextValue = "ejudgeContest";
    this.command = {
      command: "ejudge.itemClicked",
      title: "Ejudge item clicked",
      arguments: [contest.id],
    };
    this.iconPath = new vscode.ThemeIcon("link");
  }
}

export class ContestsProvider
  implements vscode.TreeDataProvider<ContestItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly gist: GistJsonStore;
  private syncTimer: NodeJS.Timeout | undefined;
  private syncing = false;
  private lastPull = 0;

  private readonly declinedPrompts = new Set<string>();
  private readonly pendingPrompts = new Map<string, Promise<string | undefined>>();
  private problemCache: Record<string, Record<string, CachedStatement>> = {};
  private problemCacheMtime = -1;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.gist = new GistJsonStore(context, log);
  }

  // Вызывать один раз при активации (то есть при загрузке VS Code или страницы code-server).
  async init(): Promise<void> {
    await this.migrateLegacy();
    void this.syncNow(false);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  // ---------- локальное хранилище (globalState) ----------

  private load(): StoreData {
    const raw = this.context.globalState.get<Partial<StoreData>>(STORE_KEY);
    // Копия, чтобы изменения не попадали в кеш globalState до update().
    return { ...emptyStore(), ...(raw ? JSON.parse(JSON.stringify(raw)) : {}) };
  }

  private async save(data: StoreData): Promise<void> {
    await this.context.globalState.update(STORE_KEY, data);
    this._onDidChangeTreeData.fire();
  }

  private async mutate(change: (data: StoreData) => void): Promise<void> {
    const data = this.load();
    change(data);
    await this.save(data);
  }

  private async migrateLegacy(): Promise<void> {
    const raw = this.context.globalState.get<any>(STORE_KEY);
    if (raw !== undefined) {
      // Данные предыдущей версии: скрытые группы лежали отдельно от контестов.
      if (raw.hiddenGroups) {
        const contests = (raw.contests || []).map((c: any) => pickContest(c, raw.hiddenGroups[c.id]));
        await this.context.globalState.update(STORE_KEY, { contests, deleted: raw.deleted || {} });
      }
      return;
    }
    // Самая первая версия хранила список контестов под отдельным ключом.
    const legacy = this.context.globalState.get<any[]>(LEGACY_CONTESTS_KEY, []);
    if (!legacy.length) return;
    await this.context.globalState.update(STORE_KEY, {
      contests: legacy.map((c) => pickContest(c)),
      deleted: {}
    });
  }

  // ---------- синхронизация с GitHub Gist ----------

  private scheduleSync() {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(
      () => void this.syncNow(false),
      SYNC_DEBOUNCE_MS,
    );
  }

  // interactive=true — по команде пользователя: покажет вход и итог.
  async syncNow(interactive: boolean): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const token = await this.gist.getToken(interactive);
      if (!token) {
        if (interactive)
          vscode.window.showWarningMessage(
            "Не выполнен вход в GitHub — синхронизация недоступна.",
          );
        return;
      }
      const remote = (await this.gist.read(token)) as
        | Partial<StoreData>
        | undefined;
      const local = this.load();
      if (
        !remote &&
        !local.contests.length &&
        !Object.keys(local.deleted).length
      )
        return;

      const merged = remote ? mergeStores(local, remote) : local;
      if (canonical(merged) !== canonical(local)) await this.save(merged);
      if (
        !remote ||
        canonical(merged) !==
          canonical({
            contests: remote.contests || [],
            deleted: remote.deleted || {},
          })
      ) {
        await this.gist.write(token, {
          version: 1,
          contests: merged.contests,
          deleted: merged.deleted,
        });
        this.log("gist: данные отправлены");
      }
      if (interactive)
        vscode.window.showInformationMessage("Контесты синхронизированы.");
    } catch (error: any) {
      this.log(`gist: ошибка синхронизации: ${error?.message || error}`);
      if (interactive)
        vscode.window.showErrorMessage(
          `Не удалось синхронизировать: ${error?.message || error}`,
        );
    } finally {
      this.syncing = false;
    }
  }

  // ---------- контесты ----------

  getContests(): Contest[] {
    return this.load().contests;
  }

  getContest(id: string): Contest | undefined {
    return this.getContests().find((c) => c.id === id);
  }

  // ---------- пароли (SecretStorage, не синхронизируются) ----------

  async getPassword(id: string): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_PASSWORD + id);
  }

  async getProxyPassword(id: string): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_PROXY_PASSWORD + id);
  }

  // ---------- скрытые группы задач ----------

  getHiddenGroups(contestId: string): string[] {
    return this.getContest(contestId)?.hiddenGroups || [];
  }

  async setGroupHidden(
    contestId: string,
    groupKey: string,
    hidden: boolean,
  ): Promise<void> {
    await this.mutate((data) => {
      const contest = data.contests.find((c) => c.id === contestId);
      if (!contest) return;
      const keys = new Set(contest.hiddenGroups || []);
      if (hidden) keys.add(groupKey);
      else keys.delete(groupKey);
      contest.hiddenGroups = Array.from(keys);
      contest.updatedAt = Date.now();
    });
  }

  // ---------- кеш задач (файл в globalStorageUri, не синхронизируется) ----------

  private get problemCacheFile(): string {
    return path.join(
      this.context.globalStorageUri.fsPath,
      "problem-cache.json",
    );
  }

  private loadProblemCache(): Record<string, Record<string, CachedStatement>> {
    let mtime = -1;
    try {
      mtime = fs.statSync(this.problemCacheFile).mtimeMs;
    } catch {
      this.problemCache = {};
      this.problemCacheMtime = -1;
      return this.problemCache;
    }
    if (mtime === this.problemCacheMtime) return this.problemCache;
    try {
      this.problemCache = JSON.parse(
        fs.readFileSync(this.problemCacheFile, "utf8"),
      );
      this.problemCacheMtime = mtime;
    } catch {
      // файл мог быть в момент записи другим экземпляром — оставляем прежний кеш
    }
    return this.problemCache;
  }

  private writeProblemCache(
    data: Record<string, Record<string, CachedStatement>>,
  ) {
    fs.mkdirSync(path.dirname(this.problemCacheFile), { recursive: true });
    const tmp = `${this.problemCacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.problemCacheFile);
    this.problemCacheMtime = -1;
  }

  getCachedProblem(
    contestId: string,
    key: string,
  ): CachedStatement | undefined {
    return this.loadProblemCache()[contestId]?.[key];
  }

  async saveCachedProblem(
    contestId: string,
    key: string,
    detail: ProblemDetail,
  ): Promise<void> {
    this.problemCacheMtime = -1;
    const data = this.loadProblemCache();
    const next: CachedStatement = {
      title: detail.title,
      statementHtml: detail.statementHtml,
      limits: detail.limits,
      languages: detail.languages,
      fixedLanguageLabel: detail.fixedLanguageLabel,
      savedAt: Date.now(),
    };
    const prev = data[contestId]?.[key];
    if (
      prev &&
      prev.title === next.title &&
      prev.statementHtml === next.statementHtml &&
      JSON.stringify(prev.limits) === JSON.stringify(next.limits) &&
      JSON.stringify(prev.languages) === JSON.stringify(next.languages)
    ) {
      return;
    }
    data[contestId] = { ...(data[contestId] || {}), [key]: next };
    this.writeProblemCache(data);
  }

  // Используется contestSettingsPanel.ts как для создания нового контеста
  // (data.id undefined), так и для обновления существующего. Пароли
  // перезаписываются только если пришло непустое значение — пустое поле
  // в форме не стирает сохранённый пароль.
  async upsertContest(data: ContestFormData): Promise<string> {
    const proxy: ContestProxy | undefined = data.proxyHost
      ? {
          host: data.proxyHost,
          port: data.proxyPort || 1080,
          username: data.proxyUsername || undefined,
        }
      : undefined;
    const groupRegex = data.groupRegex?.trim() || undefined;

    const id = data.id || `c${Date.now()}`;
    await this.mutate((store) => {
      const idx = store.contests.findIndex((c) => c.id === id);
      const next: Contest = {
        ...(idx >= 0 ? store.contests[idx] : {}),
        id,
        label: data.label,
        url: data.url,
        login: data.login,
        proxy,
        groupRegex,
        updatedAt: Date.now(),
      };
      if (idx >= 0) store.contests[idx] = next;
      else store.contests.push(next);
      delete store.deleted[id];
    });

    if (!proxy) await this.context.secrets.delete(SECRET_PROXY_PASSWORD + id);
    void this.syncNow(false);
    return id;
  }

  // Advanced, non-form flow: "Ejudge: Edit selectors" in the tree context menu.
  async editSelectors(item: ContestItem) {
    const contest = item.contest;
    const loginFieldName = await vscode.window.showInputBox({
      prompt: 'Имя поля логина (пусто = авто, по умолчанию "login")',
      value: contest.loginFieldName ?? "",
    });
    if (loginFieldName === undefined) return;
    const passwordFieldName = await vscode.window.showInputBox({
      prompt: 'Имя поля пароля (пусто = авто, по умолчанию "password")',
      value: contest.passwordFieldName ?? "",
    });
    if (passwordFieldName === undefined) return;
    const fileFieldName = await vscode.window.showInputBox({
      prompt:
        'Имя поля файла на странице отправки (пусто = авто, по умолчанию "file")',
      value: contest.fileFieldName ?? "",
    });
    if (fileFieldName === undefined) return;
    const submitButtonName = await vscode.window.showInputBox({
      prompt:
        'Имя кнопки входа (пусто = авто-подбор первой submit-кнопки, по умолчанию "action_2")',
      value: contest.submitButtonName ?? "",
    });
    if (submitButtonName === undefined) return;

    await this.mutate((store) => {
      const idx = store.contests.findIndex((c) => c.id === contest.id);
      if (idx < 0) return;
      store.contests[idx] = {
        ...store.contests[idx],
        loginFieldName: loginFieldName || undefined,
        passwordFieldName: passwordFieldName || undefined,
        fileFieldName: fileFieldName || undefined,
        submitButtonName: submitButtonName || undefined,
        updatedAt: Date.now(),
      };
    });
  }

  async deleteContest(item: ContestItem) {
    const confirm = await vscode.window.showWarningMessage(
      `Удалить контест "${item.contest.label}"?`,
      { modal: true },
      "Удалить",
    );
    if (confirm !== "Удалить") return;
    const id = item.contest.id;
    await this.mutate((store) => {
      store.contests = store.contests.filter((c) => c.id !== id);
      store.deleted[id] = Date.now();
    });
    await this.context.secrets.delete(SECRET_PASSWORD + id);
    await this.context.secrets.delete(SECRET_PROXY_PASSWORD + id);

    const cache = this.loadProblemCache();
    if (cache[id]) {
      delete cache[id];
      this.writeProblemCache(cache);
    }
    void this.syncNow(false);
  }

    async promptSecret(contest: Contest, kind: 'login' | 'proxy', force = false): Promise<string | undefined> {
    const key = `${kind}:${contest.id}`;
    if (!force && this.declinedPrompts.has(key)) return undefined;
    const pending = this.pendingPrompts.get(key);
    if (pending) return pending;

    const promise = (async () => {
      const proxy = contest.proxy;
      const value = await vscode.window.showInputBox({
        title: kind === 'login' ? `Пароль ejudge — ${contest.label}` : `Пароль прокси — ${contest.label}`,
        prompt: kind === 'login'
          ? `Пользователь: ${contest.login}`
          : `Прокси ${proxy?.host}:${proxy?.port}, пользователь: ${proxy?.username || '—'}`,
        password: true,
        ignoreFocusOut: true
      });
      if (!value) {
        this.declinedPrompts.add(key);
        return undefined;
      }
      this.declinedPrompts.delete(key);
      await this.context.secrets.store((kind === 'login' ? SECRET_PASSWORD : SECRET_PROXY_PASSWORD) + contest.id, value);
      return value;
    })().finally(() => this.pendingPrompts.delete(key));

    this.pendingPrompts.set(key, promise);
    return promise;
  }

  async getPasswordOrAsk(contest: Contest): Promise<string> {
    return (await this.getPassword(contest.id)) || (await this.promptSecret(contest, 'login')) || '';
  }

  async getProxyPasswordOrAsk(contest: Contest): Promise<string | undefined> {
    const stored = await this.getProxyPassword(contest.id);
    if (stored || !contest.proxy?.username) return stored;
    return this.promptSecret(contest, 'proxy');
  }

  // После сохранения настроек: спросить то, чего ещё нет.
  async askMissingSecrets(contestId: string): Promise<void> {
    const contest = this.getContest(contestId);
    if (!contest) return;
    if (!(await this.getPassword(contestId))) await this.promptSecret(contest, 'login', true);
    if (contest.proxy?.username && !(await this.getProxyPassword(contestId))) {
      await this.promptSecret(contest, 'proxy', true);
    }
  }

  // Команды из меню: спросить заново и заменить сохранённый пароль.
  async changeSecret(item: ContestItem, kind: 'login' | 'proxy'): Promise<void> {
    if (kind === 'proxy' && !item.contest.proxy) {
      vscode.window.showInformationMessage('У этого контеста не включён прокси.');
      return;
    }
    await this.promptSecret(item.contest, kind, true);
  }

  getTreeItem(element: ContestItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ContestItem[] {
    return this.getContests().map((c) => new ContestItem(c));
  }
}
