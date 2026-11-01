import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import * as crypto from "crypto";
import * as zlib from "zlib";
import { URL } from "url";
import { SocksProxyAgent } from "socks-proxy-agent";
import { ContestsProvider, Contest } from "./contestsProvider";
import { CLIENT_SCRIPT } from "./clientScript";
import {
  EJUDGE_PARSER,
  ContestInfo,
  extractReportText,
  isEjudgePage,
  ProblemDetail,
  ProblemLanguage,
  ProblemSummary,
  stripTagsPreserveLines,
} from "./ejudgeParsers";
import { renderContestPage } from "./problemPageTemplate";
import type { ProblemGroup } from "./problemPageTemplate";
import type { DotStatus, SubmissionRow } from "./ejudgeParsers";

interface ContestSession {
  cookies: Map<string, string>;
  vscodeClient: boolean;
}

interface CachedProblem {
  detail: ProblemDetail;
  pageUrl: URL;
  // id задачи, которая была текущей на этой странице (по списку задач).
  problemId?: string;
  fromCache?: boolean;
}

// Учётные данные SOCKS5-прокси (контеста или Gemini) вместе с паролем из хранилища.
interface ProxyCredentials {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const UPSTREAM_TIMEOUT_MS = 15000;
// Стиль scrollbar для страниц "как есть" (режим renderGeneric). В нашем
// шаблоне он уже есть в CSS problemPageTemplate.ts.
const SCROLLBAR_CSS = `
::-webkit-scrollbar{width:12px;height:12px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background-color:rgba(140,140,140,.35);border:3px solid transparent;background-clip:padding-box;border-radius:10px}
::-webkit-scrollbar-thumb:hover{background-color:rgba(55,148,255,.65)}
::-webkit-scrollbar-thumb:active{background-color:rgba(55,148,255,.90)}
::-webkit-scrollbar-corner{background:transparent}
`;
const MAX_SERVER_LOGIN_ATTEMPTS = 3;
const LEGACY_RENEGOTIATION_OPTIONS =
  crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION;

const KEEP_ALIVE_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 6,
  maxFreeSockets: 6,
};

let directHttpAgent: http.Agent | undefined;
let directHttpsAgent: https.Agent | undefined;

function getHttpAgent(): http.Agent {
  if (!directHttpAgent) directHttpAgent = new http.Agent(KEEP_ALIVE_OPTIONS);
  return directHttpAgent;
}

function getHttpsAgent(): https.Agent {
  if (!directHttpsAgent) {
    directHttpsAgent = new https.Agent({
      ...KEEP_ALIVE_OPTIONS,
      secureOptions: LEGACY_RENEGOTIATION_OPTIONS,
    });
  }
  return directHttpsAgent;
}

interface FetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface ParsedLoginForm {
  action: string;
  fields: Record<string, string>;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string,
  );
}

function decompressStream(
  stream: NodeJS.ReadableStream,
  encoding: string,
): NodeJS.ReadableStream {
  switch (encoding.toLowerCase()) {
    case "gzip":
      return stream.pipe(zlib.createGunzip());
    case "deflate":
      return stream.pipe(zlib.createInflate());
    case "br":
      return stream.pipe(zlib.createBrotliDecompress());
    default:
      return stream;
  }
}

function extractSourceText(html: string): string {
  const pre = /<pre\b[^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  if (pre) return stripTagsPreserveLines(pre[1]);
  const bodyMatch = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return stripTagsPreserveLines(bodyMatch ? bodyMatch[1] : html);
}

function extractSubmitError(html: string): string | null {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "";
  const plainTitle = decodeHtmlEntities(title.replace(/<[^>]*>/g, "")).trim();
  const match = /Ошибка:\s*(.+)$/i.exec(plainTitle);
  return match ? match[1].trim() : null;
}

// Компилирует regex группировки задач из настроек контеста; при ошибке возвращает undefined.
function compileGroupRegex(
  source: string | undefined,
  onError: (message: string) => void,
): RegExp | undefined {
  const trimmed = source?.trim();
  if (!trimmed) return undefined;
  try {
    return new RegExp(trimmed, "i");
  } catch (error: any) {
    onError(
      `некорректный regex групп "${trimmed}": ${error?.message || error}`,
    );
    return undefined;
  }
}

function hasProblemContent(
  detail: ProblemDetail | null,
): detail is ProblemDetail {
  return (
    !!detail && stripTagsPreserveLines(detail.statementHtml).trim().length >= 20
  );
}

function truncateText(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n… (обрезано, всего ${text.length} символов)`
    : text;
}

function listStatus(item: ProblemSummary): DotStatus {
  return item.status === "OK" ? "ok" : item.status === "WA" ? "wa" : "none";
}

export class EjudgeProxy {
  private readonly server: http.Server;
  private port = 0;
  private readonly sessions = new Map<string, ContestSession>();
  private readonly activeProblems = new Map<string, CachedProblem>();
  private readonly contestInfo = new Map<string, ContestInfo>();
  private readonly problemStatuses = new Map<string, Map<string, DotStatus>>();
  private readonly infoUrls = new Map<string, URL>();
  private readonly lastLists = new Map<
    string,
    { problems: ProblemSummary[]; pageUrl: URL }
  >();

  constructor(
    private readonly contests: ContestsProvider,
    private readonly output: vscode.OutputChannel,
  ) {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  private log(message: string) {
    this.output.appendLine(`[ejudge] ${message}`);
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    return this.port;
  }

  dispose() {
    this.server.close();
    directHttpAgent?.destroy();
    directHttpsAgent?.destroy();
  }

  private getSession(contestId: string): ContestSession {
    let session = this.sessions.get(contestId);
    if (!session) {
      session = { cookies: new Map(), vscodeClient: false };
      this.sessions.set(contestId, session);
    }
    return session;
  }

  private getCookieHeader(contestId: string): string {
    return Array.from(this.getSession(contestId).cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  private storeCookies(contestId: string, cookieHeaders: string[] | undefined) {
    if (!cookieHeaders) return;
    const cookies = this.getSession(contestId).cookies;
    for (const line of cookieHeaders) {
      const firstPart = line.split(";")[0];
      const equal = firstPart.indexOf("=");
      if (equal > 0) {
        cookies.set(
          firstPart.slice(0, equal).trim(),
          firstPart.slice(equal + 1).trim(),
        );
      }
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": (req.headers.origin as string) || "*",
        "access-control-allow-private-network": "true",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "*",
        "content-length": "0",
      });
      res.end();
      return;
    }

    try {
      const reqUrl = new URL(req.url || "/", "http://internal");
      if (reqUrl.pathname.startsWith("/ejudge-api/")) {
        await this.handleApi(reqUrl, req, res);
        return;
      }

      if (reqUrl.pathname.startsWith("/proxy/")) {
        await this.handleProxy(reqUrl, req, res);
        return;
      }

      this.log(`404 fallback for path: ${reqUrl.pathname}`);
      res.writeHead(404).end("Not found");
    } catch (error: any) {
      this.log(`ERROR ${req.url}: ${error?.stack || error}`);
      if (!res.headersSent)
        res
          .writeHead(500)
          .end(`Proxy error: ${error?.message || String(error)}`);
    }
  }

  private async getContestProxyCredentials(
    contest: Contest,
  ): Promise<ProxyCredentials | undefined> {
    if (!contest.proxy) return undefined;
    return {
      ...contest.proxy,
      password: await this.contests.getProxyPasswordOrAsk(contest),
    };
  }

  private buildAgent(
    proxy: ProxyCredentials | undefined,
  ): http.Agent | https.Agent | undefined {
    if (!proxy) return undefined;
    const auth = proxy.username
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || "")}@`
      : "";
    const proxyUrl = `socks5h://${auth}${proxy.host}:${proxy.port}`;
    this.log(
      `SOCKS agent: proxy=${proxy.host}:${proxy.port}, ` +
        `username=${proxy.username || "<none>"}, ` +
        `password=${proxy.password ? "<set>" : "<empty>"}`,
    );
    return new SocksProxyAgent(proxyUrl) as unknown as http.Agent | https.Agent;
  }

  private async fetchUpstream(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    proxy: ProxyCredentials | undefined,
    contestId: string,
  ): Promise<FetchResult> {
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const proxyAgent = this.buildAgent(proxy);

    const cookie = this.getCookieHeader(contestId);
    if (cookie) headers.cookie = cookie;
    headers["accept-encoding"] = "gzip, deflate, br";

    const options: https.RequestOptions = {
      method,
      headers,
      timeout: UPSTREAM_TIMEOUT_MS,
      agent: proxyAgent || (isHttps ? getHttpsAgent() : getHttpAgent()),
      family: 4,
    };

    return new Promise<FetchResult>((resolve, reject) => {
      const upstreamReq = transport.request(url, options, (upstreamRes) => {
        this.storeCookies(contestId, upstreamRes.headers["set-cookie"]);
        const decoded = decompressStream(
          upstreamRes,
          String(upstreamRes.headers["content-encoding"] || ""),
        );
        const chunks: Buffer[] = [];
        decoded.on("data", (chunk) => chunks.push(chunk as Buffer));
        decoded.on("end", () =>
          resolve({
            status: upstreamRes.statusCode || 200,
            headers: upstreamRes.headers,
            body: Buffer.concat(chunks),
          }),
        );
        decoded.on("error", reject);
      });
      upstreamReq.on("timeout", () =>
        upstreamReq.destroy(new Error("upstream timeout")),
      );
      upstreamReq.on("error", reject);
      if (body?.length) upstreamReq.write(body);
      upstreamReq.end();
    });
  }

  private inheritContestParams(target: URL, contest: Contest): URL {
    const base = new URL(contest.url);
    for (const [key, value] of base.searchParams.entries()) {
      if (!target.searchParams.has(key)) target.searchParams.set(key, value);
    }
    return target;
  }

  private makeTargetFromProxyRequest(
    reqUrl: URL,
    contest: Contest,
    realPath: string,
  ): URL {
    const base = new URL(contest.url);
    const target = new URL(realPath + reqUrl.search, base.origin);
    return this.inheritContestParams(target, contest);
  }

  private hasPasswordField(html: string, passwordFieldName: string): boolean {
    const escaped = passwordFieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `<input\\b[^>]*(?:name=["']${escaped}["'][^>]*type=["']?password|type=["']password["'][^>]*name=["']${escaped}["'])`,
      "i",
    ).test(html);
  }

  private extractLoginForm(
    html: string,
    passwordFieldName: string,
    submitButtonName: string,
  ): ParsedLoginForm | null {
    const passwordRe = new RegExp(
      `name=["']${passwordFieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
      "i",
    );
    const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
    let form: RegExpExecArray | null;

    while ((form = formRe.exec(html))) {
      if (!passwordRe.test(form[2])) continue;

      const action = /\baction=["']([^"']*)["']/i.exec(form[1])?.[1] || "";
      const fields: Record<string, string> = {};
      let chosenSubmit: { name: string; value: string } | undefined;

      for (const input of form[2].matchAll(/<input\b([^>]*)>/gi)) {
        const attrs = input[1];
        const name = /\bname=["']([^"']+)["']/i.exec(attrs)?.[1];
        if (!name) continue;
        const type = (
          /\btype=["']([^"']+)["']/i.exec(attrs)?.[1] || "text"
        ).toLowerCase();
        const value = decodeHtmlEntities(
          /\bvalue=["']([^"']*)["']/i.exec(attrs)?.[1] || "",
        );

        if (type === "submit") {
          const candidate = { name, value };
          if (name === submitButtonName) chosenSubmit = candidate;
          else if (!chosenSubmit) chosenSubmit = candidate;
          continue;
        }

        if (type !== "button" && type !== "reset") fields[name] = value;
      }

      if (chosenSubmit) fields[chosenSubmit.name] = chosenSubmit.value;
      return { action: decodeHtmlEntities(action), fields };
    }

    return null;
  }

  private async performServerSideLogin(
    contest: Contest,
    contestId: string,
    initialUrl: URL,
    initialHtml: string,
    password: string,
  ): Promise<{ html: string; url: URL } | null> {
    const passwordFieldName = contest.passwordFieldName || "password";
    const loginFieldName = contest.loginFieldName || "login";
    const submitButtonName = contest.submitButtonName || "action_2";

    if (!contest.login || !password) {
      this.log(
        `performServerSideLogin: пропущен — не заданы логин/пароль для контеста ${contestId}`,
      );
      return null;
    }

    const proxy = await this.getContestProxyCredentials(contest);
    let html = initialHtml;
    let currentUrl = initialUrl;

    for (let attempt = 0; attempt < MAX_SERVER_LOGIN_ATTEMPTS; attempt++) {
      if (!this.hasPasswordField(html, passwordFieldName)) {
        this.log(
          `performServerSideLogin: поле пароля не найдено на ${currentUrl.pathname}, попытка ${attempt}`,
        );
        return { html, url: currentUrl };
      }

      const form = this.extractLoginForm(
        html,
        passwordFieldName,
        submitButtonName,
      );
      if (!form) {
        this.log(
          `performServerSideLogin: форма логина не распарсилась на ${currentUrl.pathname}`,
        );
        return null;
      }

      form.fields[loginFieldName] = contest.login;
      form.fields[passwordFieldName] = password;
      const actionUrl = this.inheritContestParams(
        new URL(form.action || currentUrl.toString(), currentUrl),
        contest,
      );
      const body = Buffer.from(new URLSearchParams(form.fields).toString());

      const result = await this.fetchUpstream(
        actionUrl,
        "POST",
        {
          "content-type": "application/x-www-form-urlencoded",
          origin: currentUrl.origin,
          referer: currentUrl.toString(),
        },
        body,
        proxy,
        contestId,
      );

      this.log(
        `performServerSideLogin: POST ${actionUrl.pathname} -> HTTP ${result.status}${result.headers.location ? ", location=" + result.headers.location : ""}`,
      );

      if (
        result.status >= 300 &&
        result.status < 400 &&
        result.headers.location
      ) {
        currentUrl = this.inheritContestParams(
          new URL(String(result.headers.location), actionUrl),
          contest,
        );
        const redirected = await this.fetchUpstream(
          currentUrl,
          "GET",
          {},
          undefined,
          proxy,
          contestId,
        );
        html = redirected.body.toString("utf8");
      } else {
        html = result.body.toString("utf8");
        currentUrl = actionUrl;
      }
    }

    this.log(
      `performServerSideLogin: превышено число попыток (${MAX_SERVER_LOGIN_ATTEMPTS}) для контеста ${contestId}`,
    );
    return { html, url: currentUrl };
  }

  // ВАЖНО: Location всегда должен быть ОТНОСИТЕЛЬНЫМ путём (без ведущего
  // "/"), а не абсолютным "/proxy/...". Абсолютный путь резолвится браузером
  // от корня ТЕКУЩЕГО ORIGIN — на десктопном VS Code это не страшно (там
  // прокси открыт прямо на http://127.0.0.1:port/), но на code-server сам
  // code-server оборачивает наш адрес в свой собственный префикс вида
  // /proxy/<port>/... — абсолютный редирект этот префикс стирает, и браузер
  // уходит мимо прокси. Относительный путь браузер резолвит относительно
  // ТЕКУЩЕГО адреса (вместе с чужим префиксом), поэтому используем тот же
  // toRelativeProxyUrl, что и для ссылок внутри страницы.
  private async redirectInfoToFirstProblem(
    html: string,
    currentUrl: URL,
    contest: Contest,
    contestId: string,
    reqPath: string,
    res: http.ServerResponse,
  ): Promise<boolean> {
    if (!isEjudgePage(html)) return false;
    if (EJUDGE_PARSER.parseProblem(html)) return false;
    const problems = EJUDGE_PARSER.parseProblemList(html);
    if (!problems.length) return false;

    const info = EJUDGE_PARSER.parseContestInfo(html);
    if (
      info.participantName ||
      info.serverTime ||
      info.contestStartTime ||
      info.duration
    ) {
      this.contestInfo.set(contestId, info);
    }

    this.captureStatuses(contestId, problems);
    this.infoUrls.set(contestId, currentUrl);

    const first = this.firstShownProblem(contest, problems);
    const firstUrl = this.inheritContestParams(
      new URL(first.href, currentUrl),
      contest,
    );
    const redirect = this.toRelativeProxyUrl(contestId, firstUrl, reqPath);
    this.log(`redirect root/info to first problem ${first.id}: ${redirect}`);
    res.writeHead(302, { location: redirect, "cache-control": "no-store" });
    res.end();
    return true;
  }

  // Группировка по regex из настроек контеста (применяется к названию задачи).
  // Задачи с одинаковым ключом — одна группа; группа стоит там, где её первая задача,
  // порядок задач внутри группы авторский. Задачи без совпадения остаются отдельно.
  // Название группы — название первой задачи. Если ни одна группа не набралась
  // (regex пуст, невалиден или ничего не объединил) — возвращает [] (плоский список).
  private buildProblemGroups(
    contest: Contest,
    problems: ProblemSummary[],
  ): ProblemGroup[] {
    const pattern = compileGroupRegex(contest.groupRegex, (message) =>
      this.log(message),
    );
    if (!pattern) return [];

    const hidden = new Set(this.contests.getHiddenGroups(contest.id));
    const groups: ProblemGroup[] = [];
    const byKey = new Map<string, ProblemGroup>();

    for (const item of problems) {
      const match = pattern.exec(item.name);
      if (!match) {
        groups.push({
          key: `__solo:${item.id}`,
          name: item.name || item.id,
          hidden: false,
          collapsed: false,
          problems: [item],
        });
        continue;
      }
      const key = match.length > 1 ? (match[1] ?? "") : match[0];
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          name: item.name || item.id,
          hidden: hidden.has(key),
          collapsed: true,
          problems: [],
        };
        byKey.set(key, group);
        groups.push(group);
      }
      group.problems.push(item);
    }

    if (!groups.some((group) => group.problems.length > 1)) return [];
    for (const group of groups) {
      if (group.problems.some((item) => item.status === "CURRENT"))
        group.collapsed = false;
    }
    return groups;
  }

  private isBrowserReload(req: http.IncomingMessage): boolean {
    const cacheControl = String(
      req.headers["cache-control"] || "",
    ).toLowerCase();
    const pragma = String(req.headers.pragma || "").toLowerCase();
    return (
      cacheControl.includes("max-age=0") ||
      cacheControl.includes("no-cache") ||
      pragma.includes("no-cache")
    );
  }

  private captureStatuses(contestId: string, problems: ProblemSummary[]) {
    if (!problems.length) return;
    // На странице info нет «текущей» задачи; если она есть, обновляем только остальные.
    const hasCurrent = problems.some((item) => item.status === "CURRENT");
    const snapshot = hasCurrent
      ? new Map(this.problemStatuses.get(contestId) ?? [])
      : new Map<string, DotStatus>();
    for (const item of problems) {
      if (item.status !== "CURRENT") snapshot.set(item.id, listStatus(item));
    }
    this.problemStatuses.set(contestId, snapshot);
  }

  private async loadInfoStatuses(
    contest: Contest,
    contestId: string,
  ): Promise<void> {
    try {
      const proxy = await this.getContestProxyCredentials(contest);
      const base = new URL(contest.url);
      let url =
        this.infoUrls.get(contestId) ??
        this.inheritContestParams(
          new URL(base.pathname + base.search, base.origin),
          contest,
        );
      let result = await this.fetchUpstream(
        url,
        "GET",
        {},
        undefined,
        proxy,
        contestId,
      );
      for (
        let i = 0;
        i < 5 &&
        result.status >= 300 &&
        result.status < 400 &&
        result.headers.location;
        i++
      ) {
        url = this.inheritContestParams(
          new URL(String(result.headers.location), url),
          contest,
        );
        result = await this.fetchUpstream(
          url,
          "GET",
          {},
          undefined,
          proxy,
          contestId,
        );
      }
      let html = result.body.toString("utf8");
      if (
        this.hasPasswordField(html, contest.passwordFieldName || "password")
      ) {
        const password = await this.contests.getPasswordOrAsk(contest);
        const login = await this.performServerSideLogin(
          contest,
          contestId,
          url,
          html,
          password,
        );
        if (!login) return;
        html = login.html;
        this.infoUrls.set(contestId, login.url);
      }
      this.captureStatuses(contestId, EJUDGE_PARSER.parseProblemList(html));
    } catch (error: any) {
      this.log(`status snapshot failed: ${error?.message || error}`);
    }
  }

  private async ensureDotStatuses(
    contest: Contest,
    contestId: string,
    refresh: boolean,
  ): Promise<Map<string, DotStatus>> {
    if (refresh || !this.problemStatuses.has(contestId))
      await this.loadInfoStatuses(contest, contestId);
    return this.problemStatuses.get(contestId) ?? new Map<string, DotStatus>();
  }

  // Первая показанная задача: задачи из скрытых групп пропускаем.
  private firstShownProblem(
    contest: Contest,
    problems: ProblemSummary[],
  ): ProblemSummary {
    const hiddenIds = this.hiddenProblemIds(contest, problems);
    return problems.find((item) => !hiddenIds.has(item.id)) ?? problems[0];
  }

  // id задач, которые лежат в скрытых группах (скрыть можно только группу из нескольких задач).
  private hiddenProblemIds(
    contest: Contest,
    problems: ProblemSummary[],
  ): Set<string> {
    const ids = new Set<string>();
    for (const group of this.buildProblemGroups(contest, problems)) {
      if (group.hidden && group.problems.length > 1) {
        for (const item of group.problems) ids.add(item.id);
      }
    }
    return ids;
  }

  private async handleProxy(
    reqUrl: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const pathParts = reqUrl.pathname.split("/").filter(Boolean);
    const contestId = pathParts[1];
    const contest = this.contests.getContest(contestId);

    if (!contest) {
      res.writeHead(404).end("Unknown contest id");
      return;
    }

    const session = this.getSession(contestId);
    if (reqUrl.searchParams.get("_client") === "vscode")
      session.vscodeClient = true;
    const vscodeClient = session.vscodeClient;

    if (pathParts.length === 2) {
      this.activeProblems.delete(contestId);
      this.problemStatuses.delete(contestId);
      this.infoUrls.delete(contestId);
      const base = new URL(contest.url);
      const initial = this.inheritContestParams(
        new URL(base.pathname + base.search, base.origin),
        contest,
      );
      const redirect = this.toRelativeProxyUrl(
        contestId,
        initial,
        reqUrl.pathname,
      );
      res.writeHead(302, { location: redirect, "cache-control": "no-store" });
      res.end();
      return;
    }

    const realPath = `/${pathParts.slice(2).join("/")}`;
    const target = this.makeTargetFromProxyRequest(reqUrl, contest, realPath);
    const bodyChunks: Buffer[] = [];
    for await (const chunk of req) bodyChunks.push(chunk as Buffer);
    const requestBody = bodyChunks.length
      ? Buffer.concat(bodyChunks)
      : undefined;

    const forwardHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (
        !value ||
        [
          "host",
          "connection",
          "cookie",
          "accept-encoding",
          "content-length",
        ].includes(lower)
      )
        continue;
      forwardHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
    }

    const isHttps = target.protocol === "https:";
    const transport = isHttps ? https : http;
    const proxy = await this.getContestProxyCredentials(contest);
    const proxyAgent = this.buildAgent(proxy);
    const cookie = this.getCookieHeader(contestId);
    if (cookie) forwardHeaders.cookie = cookie;
    forwardHeaders["accept-encoding"] = "gzip, deflate, br";
    if (requestBody)
      forwardHeaders["content-length"] = String(requestBody.length);

    const options: https.RequestOptions = {
      method: req.method,
      headers: forwardHeaders,
      timeout: UPSTREAM_TIMEOUT_MS,
      agent: proxyAgent || (isHttps ? getHttpsAgent() : getHttpAgent()),
      family: 4,
    };

    const started = Date.now();
    const refreshStatuses = this.isBrowserReload(req);
    const upstreamReq = transport.request(target, options, (upstreamRes) => {
      this.storeCookies(contestId, upstreamRes.headers["set-cookie"]);
      const status = upstreamRes.statusCode || 200;
      const contentType = String(upstreamRes.headers["content-type"] || "");
      const decoded = decompressStream(
        upstreamRes,
        String(upstreamRes.headers["content-encoding"] || ""),
      );

      const responseHeaders: http.OutgoingHttpHeaders = {
        ...upstreamRes.headers,
      };
      delete responseHeaders["set-cookie"];
      delete responseHeaders["content-security-policy"];
      delete responseHeaders["content-encoding"];
      delete responseHeaders["content-length"];
      delete responseHeaders["x-frame-options"];
      responseHeaders["cache-control"] = "no-store, must-revalidate";
      responseHeaders["access-control-allow-origin"] =
        (req.headers.origin as string) || "*";
      responseHeaders["access-control-allow-private-network"] = "true";

      if (status >= 300 && status < 400 && responseHeaders.location) {
        decoded.resume();
        const redirectTarget = this.inheritContestParams(
          new URL(String(responseHeaders.location), target),
          contest,
        );
        const redirectPath = this.toRelativeProxyUrl(
          contestId,
          redirectTarget,
          reqUrl.pathname,
        );
        this.log(`upstream redirect ${status} -> ${redirectPath}`);
        res.writeHead(302, {
          location: redirectPath,
          "cache-control": "no-store",
        });
        res.end();
        return;
      }

      if (reqUrl.searchParams.get("_raw") === "1") {
        const kind = reqUrl.searchParams.get("_kind");
        const chunks: Buffer[] = [];
        decoded.on("data", (chunk) => chunks.push(chunk as Buffer));
        decoded.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let text: string;
          if (!contentType.includes("text/html")) {
            text = raw;
          } else if (kind === "report") {
            text = extractReportText(raw);
          } else {
            text = extractSourceText(raw);
          }
          res.writeHead(status, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(text);
        });
        return;
      }

      if (!contentType.includes("text/html")) {
        res.writeHead(status, responseHeaders);
        decoded.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      decoded.on("data", (chunk) => chunks.push(chunk as Buffer));
      decoded.on("error", (error) => {
        this.log(`decompression error: ${String(error)}`);
        if (!res.headersSent) res.writeHead(502).end("Decompression error");
      });
      decoded.on("end", async () => {
        try {
          let html = Buffer.concat(chunks).toString("utf8");
          let pageUrl = target;

          if (
            status === 200 &&
            this.hasPasswordField(html, contest.passwordFieldName || "password")
          ) {
            const password = await this.contests.getPasswordOrAsk(contest);
            const login = await this.performServerSideLogin(
              contest,
              contestId,
              target,
              html,
              password,
            );
            if (login) {
              html = login.html;
              pageUrl = login.url;
            }
          }

          if (
            status === 200 &&
            (await this.redirectInfoToFirstProblem(
              html,
              pageUrl,
              contest,
              contestId,
              reqUrl.pathname,
              res,
            ))
          )
            return;

          const info = EJUDGE_PARSER.parseContestInfo(html);
          if (
            info.participantName ||
            info.serverTime ||
            info.contestStartTime ||
            info.duration
          ) {
            const old = this.contestInfo.get(contestId);
            this.contestInfo.set(contestId, {
              participantName:
                info.participantName || old?.participantName || null,
              serverTime: info.serverTime || old?.serverTime || "",
              contestStartTime:
                info.contestStartTime || old?.contestStartTime || "",
              duration: info.duration || old?.duration || "",
            });
          }

          const proxiedPath = `/proxy/${contestId}${pageUrl.pathname}`;
          const outputHtml = await this.renderPage(
            html,
            contestId,
            contest,
            pageUrl,
            proxiedPath,
            vscodeClient,
            refreshStatuses,
          );
          delete responseHeaders.location;
          res.writeHead(status, responseHeaders);
          res.end(outputHtml);
        } catch (error: any) {
          this.log(`render error: ${error?.stack || error}`);
          if (!res.headersSent)
            res
              .writeHead(500)
              .end(`Render error: ${error?.message || String(error)}`);
        }
      });
    });

    upstreamReq.on("timeout", () =>
      upstreamReq.destroy(new Error("upstream timeout")),
    );
    upstreamReq.on("error", (error: Error) => {
      this.log(
        `upstream error after ${Date.now() - started}ms: ${error.message}`,
      );
      if (!res.headersSent) {
        res.writeHead(504, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(
          `<html><body style="background:#1e1e1e;color:#eee;font-family:sans-serif;padding:24px"><h3>${escapeHtml(target.origin)}</h3><p>${escapeHtml(error.message)}</p></body></html>`,
        );
      }
    });

    if (requestBody?.length) upstreamReq.write(requestBody);
    upstreamReq.end();
  }

  private async renderPage(
    html: string,
    contestId: string,
    contest: Contest,
    pageUrl: URL,
    currentProxiedPath: string,
    vscodeClient: boolean,
    refreshStatuses: boolean,
  ): Promise<string> {
    if (!isEjudgePage(html)) {
      return this.renderGeneric(
        html,
        contestId,
        contest,
        pageUrl.origin,
        currentProxiedPath,
        vscodeClient,
      );
    }

    const parsedProblems = EJUDGE_PARSER.parseProblemList(html);
    const dotStatuses = await this.ensureDotStatuses(
      contest,
      contestId,
      refreshStatuses,
    );
    const problems = parsedProblems.map((item) => ({
      ...item,
      dotStatus: dotStatuses.get(item.id) ?? ("none" as DotStatus),
    }));
    this.lastLists.set(contestId, { problems, pageUrl });
    const submissions = EJUDGE_PARSER.parseSubmissions(html);
    const currentInfo = EJUDGE_PARSER.parseContestInfo(html);
    const cachedInfo = this.contestInfo.get(contestId);
    const contestInfo: ContestInfo = {
      participantName:
        currentInfo.participantName || cachedInfo?.participantName || null,
      serverTime: currentInfo.serverTime || cachedInfo?.serverTime || "",
      contestStartTime:
        currentInfo.contestStartTime || cachedInfo?.contestStartTime || "",
      duration: currentInfo.duration || cachedInfo?.duration || "",
    };

    const currentProblemId = problems.find(
      (item) => item.status === "CURRENT",
    )?.id;
    let problem = EJUDGE_PARSER.parseProblem(html);
    const problemKey = pageUrl.searchParams.get("prob_id") || "";
    let cachedAt: number | undefined;
    if (hasProblemContent(problem)) {
      if (problemKey)
        await this.contests.saveCachedProblem(contestId, problemKey, problem);
    } else if (problemKey) {
      // Задача пустая (например, закрыт доступ) — показываем последнюю сохранённую копию.
      const cached = this.contests.getCachedProblem(contestId, problemKey);
      if (cached) {
        problem = {
          title: cached.title,
          statementHtml: cached.statementHtml,
          limits: cached.limits,
          languages: cached.languages,
          fixedLanguageLabel: cached.fixedLanguageLabel,
          hiddenFields: {},
        };
        cachedAt = cached.savedAt;
      }
    }
    if (problem) {
      this.activeProblems.set(contestId, {
        detail: problem,
        pageUrl,
        problemId: currentProblemId,
        fromCache: cachedAt !== undefined,
      });
    }

    // Задачи и группы — в авторском порядке; группы строятся по regex из настроек контеста.
    const problemGroups = this.buildProblemGroups(contest, problems);

    const hrefBuilder = (item: ProblemSummary) => {
      const target = this.inheritContestParams(
        new URL(item.href, pageUrl),
        contest,
      );
      return this.toRelativeProxyUrl(contestId, target, currentProxiedPath);
    };

    const formActionRewriter = (action: string) => {
      const target = this.inheritContestParams(
        new URL(action, pageUrl),
        contest,
      );
      return this.toRelativeProxyUrl(contestId, target, currentProxiedPath);
    };

    const problemWithRewrittenStatement = problem
      ? {
          ...problem,
          statementHtml: this.rewriteHtmlAttributes(
            problem.statementHtml,
            contestId,
            contest,
            pageUrl.origin,
            currentProxiedPath,
          ),
        }
      : null;

    let rawContentHtml: string | undefined;
    if (!problem && !submissions.length) {
      const bodyMatch = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
      const bodyHtml = bodyMatch ? bodyMatch[1] : html;
      rawContentHtml = this.rewriteHtmlAttributes(
        bodyHtml,
        contestId,
        contest,
        pageUrl.origin,
        currentProxiedPath,
      );
    }

    const clientScriptTag = `<script>window.__ejudgeContestId=${JSON.stringify(contestId)};</script><script>${CLIENT_SCRIPT}</script>`;

    return renderContestPage(
      {
        contestInfo,
        problems,
        problemGroups,
        problem: problemWithRewrittenStatement,
        submissions,
        rawContentHtml,
        hrefBuilder,
        formActionRewriter,
        clientScriptTag,
        cachedAt,
      },
      vscodeClient,
    );
  }

  private renderGeneric(
    html: string,
    contestId: string,
    contest: Contest,
    origin: string,
    currentProxiedPath: string,
    vscodeClient: boolean,
  ): string {
    const rewrittenBase = this.rewriteHtmlAttributes(
      html,
      contestId,
      contest,
      origin,
      currentProxiedPath,
    );
    const rewritten = vscodeClient
      ? rewrittenBase.replace(
          /<\/head>/i,
          `<style>${SCROLLBAR_CSS}</style></head>`,
        )
      : rewrittenBase;
    const injection = vscodeClient
      ? `<script>window.__ejudgeContestId=${JSON.stringify(contestId)};</script><script>${CLIENT_SCRIPT}</script>`
      : "";
    const body = rewritten.replace(/<\/body>/i, `${injection}</body>`);
    return body !== rewritten ? body : `${rewritten}${injection}`;
  }

  // Возвращает ОТНОСИТЕЛЬНЫЙ путь от currentProxiedPath до target — без
  // ведущего "/". Используется и для ссылок внутри HTML, и (что важно) для
  // Location-заголовков редиректов, чтобы браузер резолвил их относительно
  // текущего адреса, сохраняя любой внешний префикс (например, code-server
  // добавляет свой /proxy/<port>/... поверх нашего собственного /proxy/...).
  private toRelativeProxyUrl(
    contestId: string,
    target: URL,
    currentProxiedPath: string,
  ): string {
    const destination = `/proxy/${contestId}${target.pathname}`;
    const from = currentProxiedPath.split("/").filter(Boolean);
    from.pop();
    const to = destination.split("/").filter(Boolean);

    let common = 0;
    while (
      common < from.length &&
      common < to.length &&
      from[common] === to[common]
    )
      common++;

    const relative = new Array(from.length - common)
      .fill("..")
      .concat(to.slice(common))
      .join("/");
    return relative + target.search;
  }

  private rewriteHtmlAttributes(
    html: string,
    contestId: string,
    contest: Contest,
    origin: string,
    currentProxiedPath: string,
  ): string {
    const attrRe = /\b(href|src|action|formaction)(\s*=\s*)(["'])([^"']*)\3/gi;
    return html.replace(attrRe, (whole, name, equals, quote, raw) => {
      if (!raw || /^(javascript|mailto|data):/i.test(raw)) return whole;
      try {
        const target = this.inheritContestParams(new URL(raw, origin), contest);
        if (target.origin !== origin) return whole;
        return `${name}${equals}${quote}${this.toRelativeProxyUrl(contestId, target, currentProxiedPath)}${quote}`;
      } catch {
        return whole;
      }
    });
  }

  // Отправка содержимого из памяти — для несохранённых правок и новых
  // файлов без пути (untitled): на диск ничего писать не нужно.
  async submitContent(
    contestId: string,
    filename: string,
    file: Buffer,
  ): Promise<{ ok: boolean; message: string }> {
    const contest = this.contests.getContest(contestId);
    const cached = this.activeProblems.get(contestId);
    if (!contest) return { ok: false, message: "Контест не найден." };
    if (!cached)
      return {
        ok: false,
        message: "Сначала откройте задачу в панели контеста.",
      };

    const { detail, pageUrl } = cached;
    if (cached.fromCache) {
      return {
        ok: false,
        message:
          "Задача сейчас недоступна — показана копия из кеша, отправка невозможна.",
      };
    }
    const proxy = await this.getContestProxyCredentials(contest);
    if (!detail.submitAction || !detail.fileFieldName)
      return {
        ok: false,
        message: "На странице задачи не найдена форма отправки.",
      };

    const boundary = `----ejudge${crypto.randomBytes(12).toString("hex")}`;
    const parts: Buffer[] = [];
    const push = (value: string) => parts.push(Buffer.from(value, "utf8"));

    for (const [name, value] of Object.entries(detail.hiddenFields)) {
      push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      );
    }

    if (detail.languages.length && detail.langFieldName) {
      const language = this.guessLanguage(filename, detail.languages);
      if (language)
        push(
          `--${boundary}\r\nContent-Disposition: form-data; name="${detail.langFieldName}"\r\n\r\n${language}\r\n`,
        );
    }

    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${detail.fileFieldName}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    parts.push(file);
    push(`\r\n--${boundary}--\r\n`);

    const action = this.inheritContestParams(
      new URL(detail.submitAction, pageUrl),
      contest,
    );

    try {
      const result = await this.fetchUpstream(
        action,
        "POST",
        {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          origin: pageUrl.origin,
          referer: pageUrl.toString(),
        },
        Buffer.concat(parts),
        proxy,
        contestId,
      );
      this.log(`submit response: HTTP ${result.status}`);
      const bodyText = result.body.toString("utf8");
      const submitError = extractSubmitError(bodyText);

      if (result.status >= 400 || submitError) {
        return {
          ok: false,
          message: submitError || `Ejudge HTTP ${result.status}.`,
        };
      }
      return { ok: true, message: "Отправлено." };
    } catch (error: any) {
      return { ok: false, message: error?.message || String(error) };
    }
  }

  private guessLanguage(
    filename: string,
    languages: ProblemLanguage[],
  ): string | undefined {
    const extension = filename.split(".").pop()?.toLowerCase();
    const hints: Record<string, string> = {
      cpp: "g++",
      c: "gcc",
      cc: "g++",
      c11: "gcc",
      c99: "gcc",
      py: "python",
      java: "java",
      kt: "kotlin",
      go: "golang",
      js: "javascript",
      ts: "typescript",
      rs: "rust",
    };
    const wanted = extension ? hints[extension] : undefined;
    if (!wanted) return languages[0]?.id;
    return (
      languages.find(
        (language) =>
          language.name.toLowerCase().includes(wanted) ||
          language.id === wanted,
      )?.id ?? languages[0]?.id
    );
  }

  private async readJsonBody(
    req: http.IncomingMessage,
  ): Promise<Record<string, unknown> | undefined> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async handleApi(
    reqUrl: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const send = (payload: unknown) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": (req.headers.origin as string) || "*",
        "access-control-allow-private-network": "true",
      });
      res.end(JSON.stringify(payload));
    };

    if (reqUrl.pathname === "/ejudge-api/log" && req.method === "POST") {
      const body = await this.readJsonBody(req);
      if (body)
        this.log(`webview[${String(body.level)}]: ${String(body.message)}`);
      send({ ok: true });
      return;
    }

    if (
      reqUrl.pathname === "/ejudge-api/group-visibility" &&
      req.method === "POST"
    ) {
      const body = await this.readJsonBody(req);
      const contestId = String(body?.contest || "");
      if (!body || !this.contests.getContest(contestId)) {
        send({ ok: false, error: "Контест не найден." });
        return;
      }
      await this.contests.setGroupHidden(
        contestId,
        String(body.key || ""),
        Boolean(body.hidden),
      );
      send({ ok: true });
      return;
    }

    res.writeHead(404).end();
  }

  private requireActive(contestId: string | undefined): {
    contest: Contest;
    contestId: string;
    cached: CachedProblem;
  } {
    if (!contestId)
      throw new Error("Откройте панель контеста и нужную задачу.");
    const contest = this.contests.getContest(contestId);
    if (!contest) throw new Error("Контест не найден.");
    const cached = this.activeProblems.get(contestId);
    if (!cached) throw new Error("Откройте задачу в панели контеста.");
    return { contest, contestId, cached };
  }

  // Скачивает страницу (с переходами и повторным входом, если сессия истекла).
  private async fetchPageHtml(
    contest: Contest,
    contestId: string,
    startUrl: URL,
  ): Promise<{ html: string; url: URL }> {
    const proxy = await this.getContestProxyCredentials(contest);
    const load = async (target: URL) => {
      let url = target;
      let result = await this.fetchUpstream(
        url,
        "GET",
        {},
        undefined,
        proxy,
        contestId,
      );
      for (
        let i = 0;
        i < 5 &&
        result.status >= 300 &&
        result.status < 400 &&
        result.headers.location;
        i++
      ) {
        url = this.inheritContestParams(
          new URL(String(result.headers.location), url),
          contest,
        );
        result = await this.fetchUpstream(
          url,
          "GET",
          {},
          undefined,
          proxy,
          contestId,
        );
      }
      return { html: result.body.toString("utf8"), url };
    };
    let page = await load(startUrl);
    if (
      this.hasPasswordField(page.html, contest.passwordFieldName || "password")
    ) {
      const password = await this.contests.getPasswordOrAsk(contest);
      const login = await this.performServerSideLogin(
        contest,
        contestId,
        page.url,
        page.html,
        password,
      );
      if (!login)
        throw new Error(
          "Не удалось войти в ejudge — проверьте логин и пароль в настройках контеста.",
        );
      page = await load(startUrl);
    }
    return page;
  }

  getSubmitTarget(contestId: string | undefined): {
    contestLabel: string;
    problemTitle: string;
  } {
    const { contest, cached } = this.requireActive(contestId);
    if (cached.fromCache)
      throw new Error("Задача сейчас недоступна — отправка невозможна.");
    return { contestLabel: contest.label, problemTitle: cached.detail.title };
  }

  async describeProblem(
    contestId: string | undefined,
    problemName?: string,
  ): Promise<string> {
    const { contest, contestId: id, cached } = this.requireActive(contestId);
    let pageUrl = cached.pageUrl;
    if (problemName) {
      const item = this.lastLists
        .get(id)
        ?.problems.find((p) => p.id === problemName || p.name === problemName);
      if (!item)
        throw new Error(
          `Задача "${problemName}" не найдена в списке контеста.`,
        );
      pageUrl = this.inheritContestParams(
        new URL(item.href, cached.pageUrl),
        contest,
      );
    }
    const page = await this.fetchPageHtml(contest, id, pageUrl);

    let problem = EJUDGE_PARSER.parseProblem(page.html);
    const key = page.url.searchParams.get("prob_id") || "";
    let note = "";
    if (hasProblemContent(problem)) {
      if (key) await this.contests.saveCachedProblem(id, key, problem);
    } else {
      const copy = key ? this.contests.getCachedProblem(id, key) : undefined;
      if (!copy)
        throw new Error(
          "Условие задачи сейчас недоступно, сохранённой копии нет.",
        );
      problem = {
        title: copy.title,
        statementHtml: copy.statementHtml,
        limits: copy.limits,
        languages: copy.languages,
        fixedLanguageLabel: copy.fixedLanguageLabel,
        hiddenFields: {},
      };
      note = `\n(Задача сейчас недоступна — показана сохранённая копия от ${new Date(copy.savedAt).toLocaleString("ru-RU")}.)\n`;
    }

    const limits = problem.limits
      .map((l) => `- ${l.label}: ${l.value}`)
      .join("\n");
    const languages = problem.languages.length
      ? problem.languages.map((l) => l.name).join(", ")
      : problem.fixedLanguageLabel || "не указан";
    const statement = truncateText(
      stripTagsPreserveLines(problem.statementHtml).trim(),
      30000,
    );

    const rows = EJUDGE_PARSER.parseSubmissions(page.html)
      .sort((a, b) => Number(a.id) - Number(b.id))
      .slice(-10);
    const table = rows.length
      ? "| № | Время | Результат | Тесты | Баллы |\n|---|---|---|---|---|\n" +
        rows
          .map(
            (r) =>
              `| ${r.id} | ${r.time} | ${r.result || "—"} | ${r.tests || "—"} | ${r.score || "—"} |`,
          )
          .join("\n")
      : "Посылок пока нет.";

    return [
      `# ${problem.title}${note}`,
      `Ограничения:\n${limits || "—"}`,
      `Языки: ${languages}`,
      `Условие:\n${statement}`,
      `Последние посылки:\n${table}`,
    ].join("\n\n");
  }

  private async formatSubmission(
    contest: Contest,
    contestId: string,
    pageUrl: URL,
    row: SubmissionRow,
    kinds: Array<"source" | "report">,
  ): Promise<string> {
    const parts = [
      `Посылка ${row.id}: ${row.time}, результат: ${row.result || "—"}${row.resultCode ? ` (${row.resultCode})` : ""}, ` +
        `тесты: ${row.tests || "—"}, баллы: ${row.score || "—"}`,
    ];
    const proxy = await this.getContestProxyCredentials(contest);
    for (const kind of kinds) {
      const title = kind === "source" ? "Исходник" : "Протокол";
      const link = row.links.find((l) => l.kind === kind);
      if (!link) {
        parts.push(`${title}: ссылка не найдена.`);
        continue;
      }
      const url = this.inheritContestParams(
        new URL(link.href, pageUrl),
        contest,
      );
      const result = await this.fetchUpstream(
        url,
        "GET",
        {},
        undefined,
        proxy,
        contestId,
      );
      const raw = result.body.toString("utf8");
      const text =
        kind === "report" ? extractReportText(raw) : extractSourceText(raw);
      parts.push(`${title}:\n${truncateText(text, 20000)}`);
    }
    return parts.join("\n\n");
  }

  async describeLastSubmit(contestId: string | undefined): Promise<string> {
    const { contest, contestId: id, cached } = this.requireActive(contestId);
    const page = await this.fetchPageHtml(contest, id, cached.pageUrl);
    const rows = EJUDGE_PARSER.parseSubmissions(page.html);
    if (!rows.length) return "Для этой задачи ещё нет посылок.";
    const last = rows.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
    return this.formatSubmission(contest, id, page.url, last, [
      "source",
      "report",
    ]);
  }

  async describeSubmission(
    contestId: string | undefined,
    runId: string,
    kind: "source" | "report",
  ): Promise<string> {
    const { contest, contestId: id, cached } = this.requireActive(contestId);
    const page = await this.fetchPageHtml(contest, id, cached.pageUrl);
    const row = EJUDGE_PARSER.parseSubmissions(page.html).find(
      (r) => r.id === String(runId),
    );
    if (!row)
      throw new Error(
        `Посылка ${runId} не найдена среди посылок открытой задачи.`,
      );
    return this.formatSubmission(contest, id, page.url, row, [kind]);
  }

  async describeProblems(contestId: string | undefined): Promise<string> {
    if (!contestId) throw new Error("Откройте панель контеста.");
    const contest = this.contests.getContest(contestId);
    const list = this.lastLists.get(contestId);
    if (!contest || !list) throw new Error("Откройте страницу контеста.");
    const statuses = await this.ensureDotStatuses(contest, contestId, true);
    const labels: Record<DotStatus, string> = {
      ok: "принята",
      wa: "есть неуспешные попытки",
      none: "нет статуса",
    };
    const line = (item: ProblemSummary) =>
      `- ${item.id} — ${labels[statuses.get(item.id) ?? "none"]}${item.status === "CURRENT" ? " ← открыта" : ""}`;

    const groups = this.buildProblemGroups(contest, list.problems);
    const body = groups.length
      ? groups
          .map((group) =>
            group.problems.length === 1
              ? line(group.problems[0])
              : `Группа ${group.name}${group.hidden ? " (скрыта пользователем)" : ""}:\n${group.problems.map(line).join("\n")}`,
          )
          .join("\n")
      : list.problems.map(line).join("\n");

    const info = this.contestInfo.get(contestId);
    const header = info
      ? `Время на сервере: ${info.serverTime || "—"}, начало: ${info.contestStartTime || "—"}, длительность: ${info.duration || "—"}\n\n`
      : "";
    return `${header}${body}`;
  }
}
