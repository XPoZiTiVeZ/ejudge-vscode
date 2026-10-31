import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { URL } from 'url';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ContestsProvider, Contest } from './contestsProvider';
import { CLIENT_SCRIPT } from './clientScript';
import {
  EJUDGE_PARSER,
  ContestInfo,
  extractReportText,
  isEjudgePage,
  ProblemDetail,
  ProblemLanguage,
  ProblemSummary,
  stripTagsPreserveLines
} from './ejudgeParsers';
import { renderContestPage } from './problemPageTemplate';
import type { ProblemGroup } from './problemPageTemplate';
import type { DotStatus } from './ejudgeParsers';

interface ContestSession {
  cookies: Map<string, string>;
  vscodeClient: boolean;
}

interface CachedProblem {
  detail: ProblemDetail;
  pageUrl: URL;
  // id задачи, которая была текущей на этой странице (по списку задач).
  problemId?: string;
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
const LEGACY_RENEGOTIATION_OPTIONS = crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION;

const KEEP_ALIVE_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 6,
  maxFreeSockets: 6
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
      secureOptions: LEGACY_RENEGOTIATION_OPTIONS
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
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c] as string));
}

function decompressStream(stream: NodeJS.ReadableStream, encoding: string): NodeJS.ReadableStream {
  switch (encoding.toLowerCase()) {
    case 'gzip':
      return stream.pipe(zlib.createGunzip());
    case 'deflate':
      return stream.pipe(zlib.createInflate());
    case 'br':
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
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '';
  const plainTitle = decodeHtmlEntities(title.replace(/<[^>]*>/g, '')).trim();
  const match = /Ошибка:\s*(.+)$/i.exec(plainTitle);
  return match ? match[1].trim() : null;
}

// Компилирует regex группировки задач из настроек контеста; при ошибке возвращает undefined.
function compileGroupRegex(source: string | undefined, onError: (message: string) => void): RegExp | undefined {
  const trimmed = source?.trim();
  if (!trimmed) return undefined;
  try {
    return new RegExp(trimmed, 'i');
  } catch (error: any) {
    onError(`некорректный regex групп "${trimmed}": ${error?.message || error}`);
    return undefined;
  }
}

function listStatus(item: ProblemSummary): DotStatus {
  return item.status === 'OK' ? 'ok' : item.status === 'WA' ? 'wa' : 'none';
}

export class EjudgeProxy {
  private readonly server: http.Server;
  private port = 0;
  private readonly sessions = new Map<string, ContestSession>();
  private readonly activeProblems = new Map<string, CachedProblem>();
  private readonly contestInfo = new Map<string, ContestInfo>();
  private readonly problemStatuses = new Map<string, Map<string, DotStatus>>();
  private readonly infoUrls = new Map<string, URL>();

  constructor(
    private readonly contests: ContestsProvider,
    private readonly output: vscode.OutputChannel
  ) {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  private log(message: string) {
    this.output.appendLine(`[ejudge] ${message}`);
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
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
      .join('; ');
  }

  private storeCookies(contestId: string, cookieHeaders: string[] | undefined) {
    if (!cookieHeaders) return;
    const cookies = this.getSession(contestId).cookies;
    for (const line of cookieHeaders) {
      const firstPart = line.split(';')[0];
      const equal = firstPart.indexOf('=');
      if (equal > 0) {
        cookies.set(firstPart.slice(0, equal).trim(), firstPart.slice(equal + 1).trim());
      }
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': (req.headers.origin as string) || '*',
        'access-control-allow-private-network': 'true',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': '*',
        'content-length': '0'
      });
      res.end();
      return;
    }

    try {
      const reqUrl = new URL(req.url || '/', 'http://internal');
      if (reqUrl.pathname.startsWith('/ejudge-api/')) {
        await this.handleApi(reqUrl, req, res);
        return;
      }

      if (reqUrl.pathname.startsWith('/proxy/')) {
        await this.handleProxy(reqUrl, req, res);
        return;
      }

      this.log(`404 fallback for path: ${reqUrl.pathname}`);
      res.writeHead(404).end('Not found');
    } catch (error: any) {
      this.log(`ERROR ${req.url}: ${error?.stack || error}`);
      if (!res.headersSent) res.writeHead(500).end(`Proxy error: ${error?.message || String(error)}`);
    }
  }

  private async getContestProxyCredentials(contest: Contest): Promise<ProxyCredentials | undefined> {
    if (!contest.proxy) return undefined;
    return { ...contest.proxy, password: await this.contests.getProxyPassword(contest.id) };
  }

  private async getAiProxyCredentials(contest: Contest): Promise<ProxyCredentials | undefined> {
    if (!contest.aiProxy) return undefined;
    return { ...contest.aiProxy, password: await this.contests.getAiProxyPassword(contest.id) };
  }

  private buildAgent(proxy: ProxyCredentials | undefined): http.Agent | https.Agent | undefined {
    if (!proxy) return undefined;
    const auth = proxy.username
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
      : '';
    const proxyUrl = `socks5h://${auth}${proxy.host}:${proxy.port}`;
    this.log(
      `SOCKS agent: proxy=${proxy.host}:${proxy.port}, ` +
      `username=${proxy.username || '<none>'}, ` +
      `password=${proxy.password ? '<set>' : '<empty>'}`
    );
    return new SocksProxyAgent(proxyUrl) as unknown as http.Agent | https.Agent;
  }

  private async fetchUpstream(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    proxy: ProxyCredentials | undefined,
    contestId: string
  ): Promise<FetchResult> {
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const proxyAgent = this.buildAgent(proxy);

    const cookie = this.getCookieHeader(contestId);
    if (cookie) headers.cookie = cookie;
    headers['accept-encoding'] = 'gzip, deflate, br';

    const options: https.RequestOptions = {
      method,
      headers,
      timeout: UPSTREAM_TIMEOUT_MS,
      agent: proxyAgent || (isHttps ? getHttpsAgent() : getHttpAgent()),
      family: 4
    };

    return new Promise<FetchResult>((resolve, reject) => {
      const upstreamReq = transport.request(url, options, (upstreamRes) => {
        this.storeCookies(contestId, upstreamRes.headers['set-cookie']);
        const decoded = decompressStream(upstreamRes, String(upstreamRes.headers['content-encoding'] || ''));
        const chunks: Buffer[] = [];
        decoded.on('data', (chunk) => chunks.push(chunk as Buffer));
        decoded.on('end', () => resolve({
          status: upstreamRes.statusCode || 200,
          headers: upstreamRes.headers,
          body: Buffer.concat(chunks)
        }));
        decoded.on('error', reject);
      });
      upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
      upstreamReq.on('error', reject);
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

  private makeTargetFromProxyRequest(reqUrl: URL, contest: Contest, realPath: string): URL {
    const base = new URL(contest.url);
    const target = new URL(realPath + reqUrl.search, base.origin);
    return this.inheritContestParams(target, contest);
  }

  private hasPasswordField(html: string, passwordFieldName: string): boolean {
    const escaped = passwordFieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `<input\\b[^>]*(?:name=["']${escaped}["'][^>]*type=["']?password|type=["']password["'][^>]*name=["']${escaped}["'])`,
      'i'
    ).test(html);
  }

  private extractLoginForm(html: string, passwordFieldName: string, submitButtonName: string): ParsedLoginForm | null {
    const passwordRe = new RegExp(`name=["']${passwordFieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
    const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
    let form: RegExpExecArray | null;

    while ((form = formRe.exec(html))) {
      if (!passwordRe.test(form[2])) continue;

      const action = /\baction=["']([^"']*)["']/i.exec(form[1])?.[1] || '';
      const fields: Record<string, string> = {};
      let chosenSubmit: { name: string; value: string } | undefined;

      for (const input of form[2].matchAll(/<input\b([^>]*)>/gi)) {
        const attrs = input[1];
        const name = /\bname=["']([^"']+)["']/i.exec(attrs)?.[1];
        if (!name) continue;
        const type = (/\btype=["']([^"']+)["']/i.exec(attrs)?.[1] || 'text').toLowerCase();
        const value = decodeHtmlEntities(/\bvalue=["']([^"']*)["']/i.exec(attrs)?.[1] || '');

        if (type === 'submit') {
          const candidate = { name, value };
          if (name === submitButtonName) chosenSubmit = candidate;
          else if (!chosenSubmit) chosenSubmit = candidate;
          continue;
        }

        if (type !== 'button' && type !== 'reset') fields[name] = value;
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
    password: string
  ): Promise<{ html: string; url: URL } | null> {
    const passwordFieldName = contest.passwordFieldName || 'password';
    const loginFieldName = contest.loginFieldName || 'login';
    const submitButtonName = contest.submitButtonName || 'action_2';

    if (!contest.login || !password) {
      this.log(`performServerSideLogin: пропущен — не заданы логин/пароль для контеста ${contestId}`);
      return null;
    }

    const proxy = await this.getContestProxyCredentials(contest);
    let html = initialHtml;
    let currentUrl = initialUrl;

    for (let attempt = 0; attempt < MAX_SERVER_LOGIN_ATTEMPTS; attempt++) {
      if (!this.hasPasswordField(html, passwordFieldName)) {
        this.log(`performServerSideLogin: поле пароля не найдено на ${currentUrl.pathname}, попытка ${attempt}`);
        return { html, url: currentUrl };
      }

      const form = this.extractLoginForm(html, passwordFieldName, submitButtonName);
      if (!form) {
        this.log(`performServerSideLogin: форма логина не распарсилась на ${currentUrl.pathname}`);
        return null;
      }

      form.fields[loginFieldName] = contest.login;
      form.fields[passwordFieldName] = password;
      const actionUrl = this.inheritContestParams(new URL(form.action || currentUrl.toString(), currentUrl), contest);
      const body = Buffer.from(new URLSearchParams(form.fields).toString());

      const result = await this.fetchUpstream(actionUrl, 'POST', {
        'content-type': 'application/x-www-form-urlencoded',
        origin: currentUrl.origin,
        referer: currentUrl.toString()
      }, body, proxy, contestId);

      this.log(`performServerSideLogin: POST ${actionUrl.pathname} -> HTTP ${result.status}${result.headers.location ? ', location=' + result.headers.location : ''}`);

      if (result.status >= 300 && result.status < 400 && result.headers.location) {
        currentUrl = this.inheritContestParams(new URL(String(result.headers.location), actionUrl), contest);
        const redirected = await this.fetchUpstream(currentUrl, 'GET', {}, undefined, proxy, contestId);
        html = redirected.body.toString('utf8');
      } else {
        html = result.body.toString('utf8');
        currentUrl = actionUrl;
      }
    }

    this.log(`performServerSideLogin: превышено число попыток (${MAX_SERVER_LOGIN_ATTEMPTS}) для контеста ${contestId}`);
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
    res: http.ServerResponse
  ): Promise<boolean> {
    if (!isEjudgePage(html)) return false;
    if (EJUDGE_PARSER.parseProblem(html)) return false;
    const problems = EJUDGE_PARSER.parseProblemList(html);
    if (!problems.length) return false;

    const info = EJUDGE_PARSER.parseContestInfo(html);
    if (info.participantName || info.serverTime || info.contestStartTime || info.duration) {
      this.contestInfo.set(contestId, info);
    }
    
    this.captureStatuses(contestId, problems);
    this.infoUrls.set(contestId, currentUrl);

    const first = this.firstShownProblem(contest, problems);
    const firstUrl = this.inheritContestParams(new URL(first.href, currentUrl), contest);
    const redirect = this.toRelativeProxyUrl(contestId, firstUrl, reqPath);
    this.log(`redirect root/info to first problem ${first.id}: ${redirect}`);
    res.writeHead(302, { location: redirect, 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  // Группировка по regex из настроек контеста (применяется к названию задачи).
  // Задачи с одинаковым ключом — одна группа; группа стоит там, где её первая задача,
  // порядок задач внутри группы авторский. Задачи без совпадения остаются отдельно.
  // Название группы — название первой задачи. Если ни одна группа не набралась
  // (regex пуст, невалиден или ничего не объединил) — возвращает [] (плоский список).
  private buildProblemGroups(contest: Contest, problems: ProblemSummary[]): ProblemGroup[] {
    const pattern = compileGroupRegex(contest.groupRegex, (message) => this.log(message));
    if (!pattern) return [];

    const hidden = new Set(this.contests.getHiddenGroups(contest.id));
    const groups: ProblemGroup[] = [];
    const byKey = new Map<string, ProblemGroup>();

    for (const item of problems) {
      const match = pattern.exec(item.name);
      if (!match) {
        groups.push({ key: `__solo:${item.id}`, name: item.name || item.id, hidden: false, collapsed: false, problems: [item] });
        continue;
      }
      const key = match.length > 1 ? (match[1] ?? '') : match[0];
      let group = byKey.get(key);
      if (!group) {
        group = { key, name: item.name || item.id, hidden: hidden.has(key), collapsed: true, problems: [] };
        byKey.set(key, group);
        groups.push(group);
      }
      group.problems.push(item);
    }

    if (!groups.some((group) => group.problems.length > 1)) return [];
    for (const group of groups) {
      if (group.problems.some((item) => item.status === 'CURRENT')) group.collapsed = false;
    }
    return groups;
  }

  private isBrowserReload(req: http.IncomingMessage): boolean {
    const cacheControl = String(req.headers['cache-control'] || '').toLowerCase();
    const pragma = String(req.headers.pragma || '').toLowerCase();
    return cacheControl.includes('max-age=0') || cacheControl.includes('no-cache') || pragma.includes('no-cache');
  }

  private captureStatuses(contestId: string, problems: ProblemSummary[]) {
    if (!problems.length) return;
    // На странице info нет «текущей» задачи; если она есть, обновляем только остальные.
    const hasCurrent = problems.some((item) => item.status === 'CURRENT');
    const snapshot = hasCurrent
      ? new Map(this.problemStatuses.get(contestId) ?? [])
      : new Map<string, DotStatus>();
    for (const item of problems) {
      if (item.status !== 'CURRENT') snapshot.set(item.id, listStatus(item));
    }
    this.problemStatuses.set(contestId, snapshot);
  }

  private async loadInfoStatuses(contest: Contest, contestId: string): Promise<void> {
    try {
      const proxy = await this.getContestProxyCredentials(contest);
      const base = new URL(contest.url);
      let url = this.infoUrls.get(contestId)
        ?? this.inheritContestParams(new URL(base.pathname + base.search, base.origin), contest);
      let result = await this.fetchUpstream(url, 'GET', {}, undefined, proxy, contestId);
      for (let i = 0; i < 5 && result.status >= 300 && result.status < 400 && result.headers.location; i++) {
        url = this.inheritContestParams(new URL(String(result.headers.location), url), contest);
        result = await this.fetchUpstream(url, 'GET', {}, undefined, proxy, contestId);
      }
      let html = result.body.toString('utf8');
      if (this.hasPasswordField(html, contest.passwordFieldName || 'password')) {
        const password = (await this.contests.getPassword(contestId)) || '';
        const login = await this.performServerSideLogin(contest, contestId, url, html, password);
        if (!login) return;
        html = login.html;
        this.infoUrls.set(contestId, login.url);
      }
      this.captureStatuses(contestId, EJUDGE_PARSER.parseProblemList(html));
    } catch (error: any) {
      this.log(`status snapshot failed: ${error?.message || error}`);
    }
  }

  private async ensureDotStatuses(contest: Contest, contestId: string, refresh: boolean): Promise<Map<string, DotStatus>> {
    if (refresh || !this.problemStatuses.has(contestId)) await this.loadInfoStatuses(contest, contestId);
    return this.problemStatuses.get(contestId) ?? new Map<string, DotStatus>();
  }

  // Первая показанная задача: задачи из скрытых групп пропускаем.
  private firstShownProblem(contest: Contest, problems: ProblemSummary[]): ProblemSummary {
    const hiddenIds = this.hiddenProblemIds(contest, problems);
    return problems.find((item) => !hiddenIds.has(item.id)) ?? problems[0];
  }

  // id задач, которые лежат в скрытых группах (скрыть можно только группу из нескольких задач).
  private hiddenProblemIds(contest: Contest, problems: ProblemSummary[]): Set<string> {
    const ids = new Set<string>();
    for (const group of this.buildProblemGroups(contest, problems)) {
      if (group.hidden && group.problems.length > 1) {
        for (const item of group.problems) ids.add(item.id);
      }
    }
    return ids;
  }

  private async handleProxy(reqUrl: URL, req: http.IncomingMessage, res: http.ServerResponse) {
    const pathParts = reqUrl.pathname.split('/').filter(Boolean);
    const contestId = pathParts[1];
    const contest = this.contests.getContest(contestId);

    if (!contest) {
      res.writeHead(404).end('Unknown contest id');
      return;
    }

    const session = this.getSession(contestId);
    if (reqUrl.searchParams.get('_client') === 'vscode') session.vscodeClient = true;
    const vscodeClient = session.vscodeClient;

    if (pathParts.length === 2) {
      this.activeProblems.delete(contestId);
      this.problemStatuses.delete(contestId);
      this.infoUrls.delete(contestId);
      const base = new URL(contest.url);
      const initial = this.inheritContestParams(new URL(base.pathname + base.search, base.origin), contest);
      const redirect = this.toRelativeProxyUrl(contestId, initial, reqUrl.pathname);
      res.writeHead(302, { location: redirect, 'cache-control': 'no-store' });
      res.end();
      return;
    }

    const realPath = `/${pathParts.slice(2).join('/')}`;
    const target = this.makeTargetFromProxyRequest(reqUrl, contest, realPath);
    const password = (await this.contests.getPassword(contestId)) || '';
    const bodyChunks: Buffer[] = [];
    for await (const chunk of req) bodyChunks.push(chunk as Buffer);
    const requestBody = bodyChunks.length ? Buffer.concat(bodyChunks) : undefined;

    const forwardHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (!value || ['host', 'connection', 'cookie', 'accept-encoding', 'content-length'].includes(lower)) continue;
      forwardHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
    }

    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const proxy = await this.getContestProxyCredentials(contest);
    const proxyAgent = this.buildAgent(proxy);
    const cookie = this.getCookieHeader(contestId);
    if (cookie) forwardHeaders.cookie = cookie;
    forwardHeaders['accept-encoding'] = 'gzip, deflate, br';
    if (requestBody) forwardHeaders['content-length'] = String(requestBody.length);

    const options: https.RequestOptions = {
      method: req.method,
      headers: forwardHeaders,
      timeout: UPSTREAM_TIMEOUT_MS,
      agent: proxyAgent || (isHttps ? getHttpsAgent() : getHttpAgent()),
      family: 4
    };

    const started = Date.now();
    const refreshStatuses = this.isBrowserReload(req);
    const upstreamReq = transport.request(target, options, (upstreamRes) => {
      this.storeCookies(contestId, upstreamRes.headers['set-cookie']);
      const status = upstreamRes.statusCode || 200;
      const contentType = String(upstreamRes.headers['content-type'] || '');
      const decoded = decompressStream(upstreamRes, String(upstreamRes.headers['content-encoding'] || ''));

      const responseHeaders: http.OutgoingHttpHeaders = { ...upstreamRes.headers };
      delete responseHeaders['set-cookie'];
      delete responseHeaders['content-security-policy'];
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-length'];
      delete responseHeaders['x-frame-options'];
      responseHeaders['cache-control'] = 'no-store, must-revalidate';
      responseHeaders['access-control-allow-origin'] = (req.headers.origin as string) || '*';
      responseHeaders['access-control-allow-private-network'] = 'true';

      if (status >= 300 && status < 400 && responseHeaders.location) {
        decoded.resume();
        const redirectTarget = this.inheritContestParams(new URL(String(responseHeaders.location), target), contest);
        const redirectPath = this.toRelativeProxyUrl(contestId, redirectTarget, reqUrl.pathname);
        this.log(`upstream redirect ${status} -> ${redirectPath}`);
        res.writeHead(302, { location: redirectPath, 'cache-control': 'no-store' });
        res.end();
        return;
      }

      if (reqUrl.searchParams.get('_raw') === '1') {
        const kind = reqUrl.searchParams.get('_kind');
        const chunks: Buffer[] = [];
        decoded.on('data', (chunk) => chunks.push(chunk as Buffer));
        decoded.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let text: string;
          if (!contentType.includes('text/html')) {
            text = raw;
          } else if (kind === 'report') {
            text = extractReportText(raw);
          } else {
            text = extractSourceText(raw);
          }
          res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end(text);
        });
        return;
      }

      if (!contentType.includes('text/html')) {
        res.writeHead(status, responseHeaders);
        decoded.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      decoded.on('data', (chunk) => chunks.push(chunk as Buffer));
      decoded.on('error', (error) => {
        this.log(`decompression error: ${String(error)}`);
        if (!res.headersSent) res.writeHead(502).end('Decompression error');
      });
      decoded.on('end', async () => {
        try {
          let html = Buffer.concat(chunks).toString('utf8');
          let pageUrl = target;

          if (status === 200 && this.hasPasswordField(html, contest.passwordFieldName || 'password')) {
            const login = await this.performServerSideLogin(contest, contestId, target, html, password);
            if (login) {
              html = login.html;
              pageUrl = login.url;
            }
          }

          if (status === 200 && await this.redirectInfoToFirstProblem(html, pageUrl, contest, contestId, reqUrl.pathname, res)) return;

          const info = EJUDGE_PARSER.parseContestInfo(html);
          if (info.participantName || info.serverTime || info.contestStartTime || info.duration) {
            const old = this.contestInfo.get(contestId);
            this.contestInfo.set(contestId, {
              participantName: info.participantName || old?.participantName || null,
              serverTime: info.serverTime || old?.serverTime || '',
              contestStartTime: info.contestStartTime || old?.contestStartTime || '',
              duration: info.duration || old?.duration || ''
            });
          }

          const proxiedPath = `/proxy/${contestId}${pageUrl.pathname}`;
          const outputHtml = await this.renderPage(html, contestId, contest, pageUrl, proxiedPath, vscodeClient, refreshStatuses)
          delete responseHeaders.location;
          res.writeHead(status, responseHeaders);
          res.end(outputHtml);
        } catch (error: any) {
          this.log(`render error: ${error?.stack || error}`);
          if (!res.headersSent) res.writeHead(500).end(`Render error: ${error?.message || String(error)}`);
        }
      });
    });

    upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
    upstreamReq.on('error', (error: Error) => {
      this.log(`upstream error after ${Date.now() - started}ms: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<html><body style="background:#1e1e1e;color:#eee;font-family:sans-serif;padding:24px"><h3>${escapeHtml(target.origin)}</h3><p>${escapeHtml(error.message)}</p></body></html>`);
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
    refreshStatuses: boolean
  ): Promise<string> {
    if (!isEjudgePage(html)) {
      return this.renderGeneric(html, contestId, contest, pageUrl.origin, currentProxiedPath, vscodeClient);
    }

    const parsedProblems = EJUDGE_PARSER.parseProblemList(html);
    const dotStatuses = await this.ensureDotStatuses(contest, contestId, refreshStatuses);
    const problems = parsedProblems.map((item) => ({
      ...item,
      dotStatus: dotStatuses.get(item.id) ?? ('none' as DotStatus)
    }));
    const problem = EJUDGE_PARSER.parseProblem(html);
    const submissions = EJUDGE_PARSER.parseSubmissions(html);
    const currentInfo = EJUDGE_PARSER.parseContestInfo(html);
    const cachedInfo = this.contestInfo.get(contestId);
    const contestInfo: ContestInfo = {
      participantName: currentInfo.participantName || cachedInfo?.participantName || null,
      serverTime: currentInfo.serverTime || cachedInfo?.serverTime || '',
      contestStartTime: currentInfo.contestStartTime || cachedInfo?.contestStartTime || '',
      duration: currentInfo.duration || cachedInfo?.duration || ''
    };

    const currentProblemId = problems.find((item) => item.status === 'CURRENT')?.id;
    if (problem) {
      this.activeProblems.set(contestId, { detail: problem, pageUrl, problemId: currentProblemId });
    }

    // Задачи и группы — в авторском порядке; группы строятся по regex из настроек контеста.
    const problemGroups = this.buildProblemGroups(contest, problems);

    const hrefBuilder = (item: ProblemSummary) => {
      const target = this.inheritContestParams(new URL(item.href, pageUrl), contest);
      return this.toRelativeProxyUrl(contestId, target, currentProxiedPath);
    };

    const formActionRewriter = (action: string) => {
      const target = this.inheritContestParams(new URL(action, pageUrl), contest);
      return this.toRelativeProxyUrl(contestId, target, currentProxiedPath);
    };

    const problemWithRewrittenStatement = problem
      ? { ...problem, statementHtml: this.rewriteHtmlAttributes(problem.statementHtml, contestId, contest, pageUrl.origin, currentProxiedPath) }
      : null;

    let rawContentHtml: string | undefined;
    if (!problem && !submissions.length) {
      const bodyMatch = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
      const bodyHtml = bodyMatch ? bodyMatch[1] : html;
      rawContentHtml = this.rewriteHtmlAttributes(bodyHtml, contestId, contest, pageUrl.origin, currentProxiedPath);
    }

    const clientScriptTag = `<script>window.__ejudgeContestId=${JSON.stringify(contestId)};</script><script>${CLIENT_SCRIPT}</script>`;

    let aiAnswerSaved = false;
    if (problem && !contest.hideAi) {
      const aiAnswer = this.contests.getAiAnswer(contestId, currentProblemId || problem.title);
      aiAnswerSaved = Boolean(aiAnswer?.code);
    }

    return renderContestPage({
      contestInfo,
      problems,
      problemGroups,
      problem: problemWithRewrittenStatement,
      submissions,
      rawContentHtml,
      hideAi: contest.hideAi,
      aiAnswerSaved,
      hrefBuilder,
      formActionRewriter,
      clientScriptTag
    }, vscodeClient);
  }

  private renderGeneric(
    html: string,
    contestId: string,
    contest: Contest,
    origin: string,
    currentProxiedPath: string,
    vscodeClient: boolean
  ): string {
    const rewrittenBase = this.rewriteHtmlAttributes(html, contestId, contest, origin, currentProxiedPath);
    const rewritten = vscodeClient
      ? rewrittenBase.replace(/<\/head>/i, `<style>${SCROLLBAR_CSS}</style></head>`)
      : rewrittenBase;
    const injection = vscodeClient
      ? `<script>window.__ejudgeContestId=${JSON.stringify(contestId)};</script><script>${CLIENT_SCRIPT}</script>`
      : '';
    const body = rewritten.replace(/<\/body>/i, `${injection}</body>`);
    return body !== rewritten ? body : `${rewritten}${injection}`;
  }

  // Возвращает ОТНОСИТЕЛЬНЫЙ путь от currentProxiedPath до target — без
  // ведущего "/". Используется и для ссылок внутри HTML, и (что важно) для
  // Location-заголовков редиректов, чтобы браузер резолвил их относительно
  // текущего адреса, сохраняя любой внешний префикс (например, code-server
  // добавляет свой /proxy/<port>/... поверх нашего собственного /proxy/...).
  private toRelativeProxyUrl(contestId: string, target: URL, currentProxiedPath: string): string {
    const destination = `/proxy/${contestId}${target.pathname}`;
    const from = currentProxiedPath.split('/').filter(Boolean);
    from.pop();
    const to = destination.split('/').filter(Boolean);

    let common = 0;
    while (common < from.length && common < to.length && from[common] === to[common]) common++;

    const relative = new Array(from.length - common).fill('..').concat(to.slice(common)).join('/');
    return relative + target.search;
  }

  private rewriteHtmlAttributes(html: string, contestId: string, contest: Contest, origin: string, currentProxiedPath: string): string {
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
  async submitContent(contestId: string, filename: string, file: Buffer): Promise<{ ok: boolean; message: string }> {
    const contest = this.contests.getContest(contestId);
    const cached = this.activeProblems.get(contestId);
    if (!contest) return { ok: false, message: 'Контест не найден.' };
    if (!cached) return { ok: false, message: 'Сначала откройте задачу в панели контеста.' };

    const { detail, pageUrl } = cached;
    const proxy = await this.getContestProxyCredentials(contest);
    if (!detail.submitAction || !detail.fileFieldName) return { ok: false, message: 'На странице задачи не найдена форма отправки.' };

    const boundary = `----ejudge${crypto.randomBytes(12).toString('hex')}`;
    const parts: Buffer[] = [];
    const push = (value: string) => parts.push(Buffer.from(value, 'utf8'));

    for (const [name, value] of Object.entries(detail.hiddenFields)) {
      push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    }

    if (detail.languages.length && detail.langFieldName) {
      const language = this.guessLanguage(filename, detail.languages);
      if (language) push(`--${boundary}\r\nContent-Disposition: form-data; name="${detail.langFieldName}"\r\n\r\n${language}\r\n`);
    }

    push(`--${boundary}\r\nContent-Disposition: form-data; name="${detail.fileFieldName}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    parts.push(file);
    push(`\r\n--${boundary}--\r\n`);

    const action = this.inheritContestParams(new URL(detail.submitAction, pageUrl), contest);

    try {
      const result = await this.fetchUpstream(action, 'POST', {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        origin: pageUrl.origin,
        referer: pageUrl.toString()
      }, Buffer.concat(parts), proxy, contestId);
      this.log(`submit response: HTTP ${result.status}`);
      const bodyText = result.body.toString('utf8');
      const submitError = extractSubmitError(bodyText);

      if (result.status >= 400 || submitError) {
        return { ok: false, message: submitError || `Ejudge HTTP ${result.status}.` };
      }
      return { ok: true, message: 'Отправлено.' };
    } catch (error: any) {
      return { ok: false, message: error?.message || String(error) };
    }
  }

  private guessLanguage(filename: string, languages: ProblemLanguage[]): string | undefined {
    const extension = filename.split('.').pop()?.toLowerCase();
    const hints: Record<string, string> = {
      cpp: 'g++', c: 'gcc', cc: 'g++', c11: 'gcc', c99: 'gcc',
      py: 'python', java: 'java', kt: 'kotlin', go: 'golang',
      js: 'javascript', ts: 'typescript', rs: 'rust'
    };
    const wanted = extension ? hints[extension] : undefined;
    if (!wanted) return languages[0]?.id;
    return languages.find((language) => language.name.toLowerCase().includes(wanted) || language.id === wanted)?.id
      ?? languages[0]?.id;
  }

  private async generateAiAnswer(contestId: string, languageName: string): Promise<{ ok: boolean; error?: string; filename?: string }> {
    const contest = this.contests.getContest(contestId);
    const cached = this.activeProblems.get(contestId);
    if (!contest) {
      return {
        ok: false,
        error: 'Контест не найден.'
      };
    }
    if (contest.hideAi) {
      return { ok: false, error: 'ИИ-функции отключены для этого контеста.' };
    }
    if (!cached) {
      return {
        ok: false,
        error: 'Сначала откройте страницу задачи в панели контеста.'
      };
    }
    const apiKey = await this.contests.getAiKey(contestId);
    if (!apiKey) {
      return {
        ok: false,
        error: 'Gemini API key не задан. Откройте настройки контеста и сохраните ключ.'
      };
    }
    const { detail } = cached;
    const selectedLanguage = languageName ||
      detail.fixedLanguageLabel ||
      detail.languages[0]?.name ||
      'не указан';
    const statement = stripTagsPreserveLines(detail.statementHtml)
      .trim()
      .slice(0, 30000);
    if (!statement) {
      return {
        ok: false,
        error: 'Не удалось извлечь условие задачи.'
      };
    }
    const limits = detail.limits
      .map((limit) => `${limit.label}: ${limit.value}`)
      .join('\n');
    const model = vscode.workspace
      .getConfiguration('ejudge.ai')
      .get<string>('model', 'gemini-3.5-flash-lite');
    const temperature = vscode.workspace
      .getConfiguration('ejudge.ai')
      .get<number>('temperature', 0.2);
    const prompt = [
      `Задача: ${detail.title}`,
      '',
      `Язык из формы ejudge: ${selectedLanguage}`,
      '',
      limits ? `Ограничения:\n${limits}` : '',
      '',
      'Условие:',
      statement
    ]
      .filter(Boolean)
      .join('\n');
    const systemInstruction = [
      'Ты опытный спортивный программист.',
      '',
      'Напиши полное корректное решение задачи.',
      'Язык передан пользователем отдельным полем "Язык из формы ejudge".',
      'Поле может содержать название компилятора, интерпретатора или платформы, например:',
      '- gcc - GNU C 16.2.1',
      '- g++ - GNU C++17',
      '- Python 3.12',
      '- OpenJDK 21',
      '- Kotlin',
      '',
      'Самостоятельно определи язык программирования и допустимый синтаксис по этому полю.',
      'Не используй возможности, которые могут отсутствовать в указанной версии языка.',
      '',
      'Строгие правила ответа:',
      '1. Верни только полный исходный код решения.',
      '2. Не используй Markdown.',
      '3. Не используй тройные обратные кавычки: ```.',
      '4. Не добавляй объяснений, рассуждений, заголовков, тестов или описания сложности.',
      '5. Не добавляй текст до исходного кода и после него.',
      '6. Программа должна читать входные данные из stdin и выводить результат в stdout.',
      '7. Не выводи приглашения, отладочную информацию или пояснения.',
      '8. По возможности не используй комментарии.',
      '9. Выбери алгоритм, подходящий под указанные ограничения.',
      '10. Первая строка ответа должна быть первой строкой исходного файла.',
      '11. Последняя строка ответа должна быть последней строкой исходного файла.'
    ].join('\n');
    const payload = {
      system_instruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature
      }
    };
    const aiProxy = await this.getAiProxyCredentials(contest);
    this.log(
      `Gemini proxy: ${aiProxy
        ? `${aiProxy.host}:${aiProxy.port}, username=${aiProxy.username || '<none>'}, password=${aiProxy.password ? '<set>' : '<empty>'}`
        : 'direct connection'}`
    );
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`);
    try {
      const response = await this.fetchUpstream(url, 'POST', {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey
      }, Buffer.from(JSON.stringify(payload), 'utf8'), aiProxy, contestId);
      const rawText = response.body.toString('utf8');
      let data: any;
      try {
        data = JSON.parse(rawText);
      } catch {
        return {
          ok: false,
          error: `Gemini вернул не-JSON ответ. HTTP ${response.status}: ` +
            rawText.slice(0, 300)
        };
      }
      if (response.status !== 200) {
        const message = data?.error?.message || rawText.slice(0, 500);
        if (response.status === 429) {
          return {
            ok: false,
            error: `Лимит Gemini исчерпан: ${message}`
          };
        }
        return {
          ok: false,
          error: `Gemini HTTP ${response.status}: ${message}`
        };
      }
      const code = (data?.candidates?.[0]?.content?.parts || [])
        .filter((part: any) => typeof part?.text === 'string')
        .map((part: any) => part.text)
        .join('');
      if (!code.trim()) {
        return {
          ok: false,
          error: `Gemini не вернул код. finishReason: ` +
            `${data?.candidates?.[0]?.finishReason || 'неизвестно'}`
        };
      }
      const problemKey = cached.problemId || detail.title;
      await this.contests.setAiAnswer(contestId, problemKey, {
        code,
        language: 'plaintext',
        extension: 'txt',
        title: detail.title,
        model,
        createdAt: Date.now()
      });
      this.log(`Gemini answer saved: ` +
        `contest=${contest.label}, ` +
        `problem=${problemKey}, ` +
        `ejudgeLanguage=${selectedLanguage}, ` +
        `model=${model}, ` +
        `chars=${code.length}`);
      return {
        ok: true,
        filename: `ai-${problemKey.replace(/[^\p{L}\p{N}]+/gu, '-')}.txt`
      };
    } catch (error: any) {
      this.log(`Gemini request error: ${error?.stack || error}`);
      return {
        ok: false,
        error: `Ошибка запроса к Gemini: ${error?.message || String(error)}`
      };
    }
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  // Ключ задачи, по которому хранится ответ ИИ: id текущей задачи или её название.
  private currentProblemKey(contestId: string): string | undefined {
    const cached = this.activeProblems.get(contestId);
    return cached ? cached.problemId || cached.detail.title : undefined;
  }

  private async handleApi(reqUrl: URL, req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (payload: unknown) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': (req.headers.origin as string) || '*',
        'access-control-allow-private-network': 'true'
      });
      res.end(JSON.stringify(payload));
    };

    if (reqUrl.pathname === '/ejudge-api/log' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (body) this.log(`webview[${String(body.level)}]: ${String(body.message)}`);
      send({ ok: true });
      return;
    }

    if (reqUrl.pathname === '/ejudge-api/ai-generate' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body) {
        send({ ok: false, error: 'Некорректное тело запроса к Gemini.' });
        return;
      }
      send(await this.generateAiAnswer(String(body.contest || ''), String(body.language || '')));
      return;
    }

    if (reqUrl.pathname === '/ejudge-api/ai-answer') {
      const contestId = reqUrl.searchParams.get('contest') || '';
      const problemKey = this.currentProblemKey(contestId);
      if (!problemKey) {
        send({ ok: false, error: 'Откройте задачу в панели контеста.' });
        return;
      }
      const answer = this.contests.getAiAnswer(contestId, problemKey);
      if (!answer) {
        send({ ok: false, error: 'Для этой задачи пока нет сохранённого ответа ИИ.' });
        return;
      }
      send({
        ok: true,
        code: answer.code,
        language: answer.language,
        filename: `ai-${problemKey.replace(/[^\p{L}\p{N}]+/gu, '-')}.${answer.extension}`
      });
      return;
    }

    if (reqUrl.pathname === '/ejudge-api/ai-clear' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const contestId = String(body?.contest || '');
      const problemKey = this.currentProblemKey(contestId);
      if (!problemKey) {
        send({ ok: false, error: 'Откройте задачу в панели контеста.' });
        return;
      }
      await this.contests.clearAiAnswer(contestId, problemKey);
      send({ ok: true });
      return;
    }

    if (reqUrl.pathname === '/ejudge-api/group-visibility' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const contestId = String(body?.contest || '');
      if (!body || !this.contests.getContest(contestId)) {
        send({ ok: false, error: 'Контест не найден.' });
        return;
      }
      await this.contests.setGroupHidden(contestId, String(body.key || ''), Boolean(body.hidden));
      send({ ok: true });
      return;
    }

    res.writeHead(404).end();
  }
}