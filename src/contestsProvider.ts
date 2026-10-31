import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  // Отдельный SOCKS5-прокси для запросов к Gemini.
  aiProxy?: ContestProxy;

  // Скрыть ИИ-кнопки на странице задачи.
  hideAi?: boolean;
  // Регулярное выражение для группировки задач по названию. Задачи с одинаковым
  // ключом (первая группа захвата, а без неё — всё совпадение) попадают в одну группу.
  groupRegex?: string;
}

export interface AiAnswer {
  code: string;
  language: string;
  extension: string;
  title: string;
  model: string;
  createdAt: number;
}

// Payload от формы contestSettingsPanel.ts.
export interface ContestFormData {
  id?: string;
  label: string;
  url: string;
  login: string;
  password?: string;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  hideAi?: boolean;
  groupRegex?: string;
  aiApiKey?: string;
  aiProxyHost?: string;
  aiProxyPort?: number;
  aiProxyUsername?: string;
  aiProxyPassword?: string;
}

interface ContestSecrets {
  password?: string;
  proxyPassword?: string;
  aiKey?: string;
  aiProxyPassword?: string;
}

interface StoreData {
  version: 1;
  contests: Contest[];
  secrets: Record<string, ContestSecrets>;
  // contestId -> ключ задачи -> ответ ИИ.
  aiAnswers: Record<string, Record<string, AiAnswer>>;
  // contestId -> ключи скрытых групп задач.
  hiddenGroups: Record<string, string[]>;
}

// Всё хранится в одном файле на хосте (для code-server — на сервере), поэтому
// настройки видны из любого браузера и любого окна. Файл содержит пароли и ключи
// в открытом виде, поэтому создаётся с правами 0600.

// Ключи старого хранилища (globalState / SecretStorage) — только для миграции.
const LEGACY_CONTESTS_KEY = 'ejudge.contests';
const LEGACY_AI_ANSWERS_KEY = 'ejudge.aiAnswers';

function resolveStorePath(context: vscode.ExtensionContext): string {
  if (process.env.EJUDGE_STORE_PATH) return process.env.EJUDGE_STORE_PATH;
  // code-server (веб-интерфейс): общий файл в домашней папке сервера,
  // чтобы настройки были видны из любого браузера.
  if (vscode.env.uiKind === vscode.UIKind.Web) {
    return path.join(os.homedir(), '.config', 'ejudge-vscode', 'store.json');
  }
  // Обычный VS Code: папка, которую VS Code выделяет расширению на этой машине.
  return path.join(context.globalStorageUri.fsPath, 'store.json');
}

function emptyStore(): StoreData {
  return { version: 1, contests: [], secrets: {}, aiAnswers: {}, hiddenGroups: {} };
}

export class ContestItem extends vscode.TreeItem {
  constructor(public readonly contest: Contest) {
    super(contest.label, vscode.TreeItemCollapsibleState.None);
    this.description = contest.login ? `(${contest.login})` : undefined;
    this.tooltip = contest.url;
    this.contextValue = 'ejudgeContest';
    this.command = {
      command: 'ejudge.itemClicked',
      title: 'Ejudge item clicked',
      arguments: [contest.id]
    };
    this.iconPath = new vscode.ThemeIcon('link');
  }
}

export class ContestsProvider implements vscode.TreeDataProvider<ContestItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  private readonly storeFile: string;
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cache: StoreData = emptyStore();
  private cacheMtime = -1;
  private watcher: fs.FSWatcher | undefined;
  private watchTimer: NodeJS.Timeout | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.storeFile = resolveStorePath(context);
  }
  // Вызывать один раз при активации: миграция из старого хранилища и слежение за файлом.
  async init(): Promise<void> {
    await this.migrateLegacy();
    this.startWatching();
  }

  dispose(): void {
    this.watcher?.close();
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this._onDidChangeTreeData.dispose();
  }

  // ---------- файловое хранилище ----------

  private load(): StoreData {
    let mtime = -1;
    try {
      mtime = fs.statSync(this.storeFile).mtimeMs;
    } catch {
      this.cache = emptyStore();
      this.cacheMtime = -1;
      return this.cache;
    }
    if (mtime === this.cacheMtime) return this.cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storeFile, 'utf8')) as Partial<StoreData>;
      this.cache = { ...emptyStore(), ...parsed };
      this.cacheMtime = mtime;
    } catch {
      // Файл мог быть в момент записи другим инстансом — оставляем прежний кэш.
    }
    return this.cache;
  }

  // Читает свежие данные, применяет изменение и атомарно записывает файл.
  private mutate(change: (data: StoreData) => void): void {
    this.cacheMtime = -1;
    const data = this.load();
    change(data);
    fs.mkdirSync(path.dirname(this.storeFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.storeFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.storeFile);
    this.cacheMtime = -1;
    this._onDidChangeTreeData.fire();
  }

  private startWatching() {
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true, mode: 0o700 });
      this.watcher = fs.watch(path.dirname(this.storeFile), (_event, name) => {
        if (name && name !== path.basename(this.storeFile)) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.cacheMtime = -1;
          this._onDidChangeTreeData.fire();
        }, 200);
      });
    } catch {
      // Слежение необязательно: данные всё равно перечитываются при каждом обращении.
    }
  }

  private async migrateLegacy(): Promise<void> {
    if (fs.existsSync(this.storeFile)) return;
    const legacy = this.context.globalState.get<Contest[]>(LEGACY_CONTESTS_KEY, []);
    const answers = this.context.globalState.get<StoreData['aiAnswers']>(LEGACY_AI_ANSWERS_KEY, {});
    if (!legacy.length && !Object.keys(answers).length) return;

    const secrets: Record<string, ContestSecrets> = {};
    for (const contest of legacy) {
      secrets[contest.id] = {
        password: await this.context.secrets.get(`ejudge.password.${contest.id}`),
        proxyPassword: await this.context.secrets.get(`ejudge.proxyPassword.${contest.id}`),
        aiKey: await this.context.secrets.get(`ejudge.aiKey.${contest.id}`),
        aiProxyPassword: await this.context.secrets.get(`ejudge.aiProxyPassword.${contest.id}`)
      };
    }
    this.mutate((data) => {
      data.contests = legacy.map((c) => {
        const { ejudgeVersion: _ignored, ...rest } = c as Contest & { ejudgeVersion?: string };
        return rest;
      });
      data.secrets = secrets;
      data.aiAnswers = answers;
    });
  }

  // ---------- контесты ----------

  getContests(): Contest[] {
    return this.load().contests;
  }

  getContest(id: string): Contest | undefined {
    return this.getContests().find((c) => c.id === id);
  }

  // ---------- секреты ----------

  async getPassword(id: string): Promise<string | undefined> {
    return this.load().secrets[id]?.password;
  }

  async getProxyPassword(id: string): Promise<string | undefined> {
    return this.load().secrets[id]?.proxyPassword;
  }

  async getAiKey(id: string): Promise<string | undefined> {
    return this.load().secrets[id]?.aiKey;
  }

  async getAiProxyPassword(id: string): Promise<string | undefined> {
    return this.load().secrets[id]?.aiProxyPassword;
  }

  // ---------- ответы ИИ ----------

  getAiAnswer(contestId: string, problemKey: string): AiAnswer | undefined {
    return this.load().aiAnswers[contestId]?.[problemKey];
  }

  async setAiAnswer(contestId: string, problemKey: string, answer: AiAnswer): Promise<void> {
    this.mutate((data) => {
      data.aiAnswers[contestId] = { ...(data.aiAnswers[contestId] || {}), [problemKey]: answer };
    });
  }

  async clearAiAnswer(contestId: string, problemKey: string): Promise<void> {
    this.mutate((data) => {
      if (data.aiAnswers[contestId]) delete data.aiAnswers[contestId][problemKey];
    });
  }

  // ---------- скрытые группы задач ----------

  getHiddenGroups(contestId: string): string[] {
    return this.load().hiddenGroups[contestId] || [];
  }

  async setGroupHidden(contestId: string, groupKey: string, hidden: boolean): Promise<void> {
    this.mutate((data) => {
      const keys = new Set(data.hiddenGroups[contestId] || []);
      if (hidden) keys.add(groupKey);
      else keys.delete(groupKey);
      data.hiddenGroups[contestId] = Array.from(keys);
    });
  }

  // Используется contestSettingsPanel.ts как для создания нового контеста
  // (data.id undefined), так и для обновления существующего. Секреты
  // перезаписываются только если пришло непустое значение — пустое поле
  // в форме не стирает сохранённый секрет.
  async upsertContest(data: ContestFormData): Promise<string> {
    const proxy: ContestProxy | undefined = data.proxyHost
      ? { host: data.proxyHost, port: data.proxyPort || 1080, username: data.proxyUsername || undefined }
      : undefined;
    const aiProxy: ContestProxy | undefined = data.aiProxyHost
      ? { host: data.aiProxyHost, port: data.aiProxyPort || 1080, username: data.aiProxyUsername || undefined }
      : undefined;
    const groupRegex = data.groupRegex?.trim() || undefined;
    const hideAi = data.hideAi ? true : undefined;

    const id = data.id || `c${Date.now()}`;
    this.mutate((store) => {
      const idx = store.contests.findIndex((c) => c.id === id);
      const next: Contest = {
        ...(idx >= 0 ? store.contests[idx] : {}),
        id,
        label: data.label,
        url: data.url,
        login: data.login,
        proxy,
        aiProxy,
        hideAi,
        groupRegex
      };
      if (idx >= 0) store.contests[idx] = next;
      else store.contests.push(next);

      const secrets: ContestSecrets = store.secrets[id] || {};
      if (data.password) secrets.password = data.password;
      if (data.proxyPassword) secrets.proxyPassword = data.proxyPassword;
      if (data.aiApiKey) secrets.aiKey = data.aiApiKey;
      if (data.aiProxyPassword) secrets.aiProxyPassword = data.aiProxyPassword;
      if (!proxy) delete secrets.proxyPassword;
      if (!aiProxy) delete secrets.aiProxyPassword;
      store.secrets[id] = secrets;
    });
    return id;
  }

  // Advanced, non-form flow: "Ejudge: Edit selectors" in the tree context menu.
  async editSelectors(item: ContestItem) {
    const contest = item.contest;
    const loginFieldName = await vscode.window.showInputBox({
      prompt: 'Имя поля логина (пусто = авто, по умолчанию "login")',
      value: contest.loginFieldName ?? ''
    });
    if (loginFieldName === undefined) return;
    const passwordFieldName = await vscode.window.showInputBox({
      prompt: 'Имя поля пароля (пусто = авто, по умолчанию "password")',
      value: contest.passwordFieldName ?? ''
    });
    if (passwordFieldName === undefined) return;
    const fileFieldName = await vscode.window.showInputBox({
      prompt: 'Имя поля файла на странице отправки (пусто = авто, по умолчанию "file")',
      value: contest.fileFieldName ?? ''
    });
    if (fileFieldName === undefined) return;
    const submitButtonName = await vscode.window.showInputBox({
      prompt: 'Имя кнопки входа (пусто = авто-подбор первой submit-кнопки, по умолчанию "action_2")',
      value: contest.submitButtonName ?? ''
    });
    if (submitButtonName === undefined) return;

    this.mutate((store) => {
      const idx = store.contests.findIndex((c) => c.id === contest.id);
      if (idx < 0) return;
      store.contests[idx] = {
        ...store.contests[idx],
        loginFieldName: loginFieldName || undefined,
        passwordFieldName: passwordFieldName || undefined,
        fileFieldName: fileFieldName || undefined,
        submitButtonName: submitButtonName || undefined
      };
    });
  }

  async deleteContest(item: ContestItem) {
    const confirm = await vscode.window.showWarningMessage(
      `Удалить контест "${item.contest.label}"?`,
      { modal: true },
      'Удалить'
    );
    if (confirm !== 'Удалить') return;
    const id = item.contest.id;
    this.mutate((store) => {
      store.contests = store.contests.filter((c) => c.id !== id);
      delete store.secrets[id];
      delete store.aiAnswers[id];
      delete store.hiddenGroups[id];
    });
  }

  getTreeItem(element: ContestItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ContestItem[] {
    return this.getContests().map((c) => new ContestItem(c));
  }
}
