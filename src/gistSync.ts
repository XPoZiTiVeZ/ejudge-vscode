import * as vscode from "vscode";

const API = "https://api.github.com";
const FILE_NAME = "ejudge-vscode.json";
const DESCRIPTION = "ejudge-vscode: контесты (без паролей)";
const GIST_ID_KEY = "ejudge.gistId";
const MAX_LIST_PAGES = 5;

// Хранит один JSON-файл в секретном gist пользователя.
export class GistJsonStore {
  private gistId: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
  ) {
    this.gistId = context.globalState.get<string>(GIST_ID_KEY);
  }

  // interactive=false — без окон и значков; true — запросит вход, если его нет.
  async getToken(interactive: boolean): Promise<string | undefined> {
    const options: vscode.AuthenticationGetSessionOptions = interactive
      ? { createIfNone: true }
      : { silent: true };
    const session = await vscode.authentication.getSession(
      "github",
      ["gist"],
      options,
    );
    return session?.accessToken;
  }

  private async setGistId(id: string | undefined) {
    this.gistId = id;
    await this.context.globalState.update(GIST_ID_KEY, id);
  }

  private async request(
    token: string,
    method: string,
    url: string,
    body?: unknown,
  ): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${API}${url}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "ejudge-vscode",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(
          `GitHub ${response.status}: ${(await response.text()).slice(0, 200)}`,
        );
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchGist(token: string): Promise<any | undefined> {
    if (this.gistId) {
      const gist = await this.request(token, "GET", `/gists/${this.gistId}`);
      if (gist?.files?.[FILE_NAME]) return gist;
      await this.setGistId(undefined);
    }
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const list = await this.request(
        token,
        "GET",
        `/gists?per_page=100&page=${page}`,
      );
      if (!Array.isArray(list) || !list.length) break;
      const found = list.find((gist: any) => gist?.files?.[FILE_NAME]);
      if (found) {
        await this.setGistId(found.id);
        return this.request(token, "GET", `/gists/${found.id}`);
      }
      if (list.length < 100) break;
    }
    return undefined;
  }

  async read(token: string): Promise<unknown | undefined> {
    const gist = await this.fetchGist(token);
    const content = gist?.files?.[FILE_NAME]?.content;
    if (typeof content !== "string") return undefined;
    try {
      return JSON.parse(content);
    } catch {
      this.log("gist: не удалось разобрать JSON, файл будет перезаписан");
      return undefined;
    }
  }

  async write(token: string, data: unknown): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    if (this.gistId) {
      const updated = await this.request(
        token,
        "PATCH",
        `/gists/${this.gistId}`,
        { files: { [FILE_NAME]: { content } } },
      );
      if (updated) return;
      await this.setGistId(undefined);
    }
    const created = await this.request(token, "POST", "/gists", {
      description: DESCRIPTION,
      public: false,
      files: { [FILE_NAME]: { content } },
    });
    if (created?.id) await this.setGistId(created.id);
  }
}
