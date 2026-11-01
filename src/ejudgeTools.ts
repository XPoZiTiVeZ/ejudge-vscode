import * as path from "path";
import * as vscode from "vscode";
import { EjudgeProxy } from "./proxyServer";
import { getActiveContestId, watchActiveContest } from "./contestPanel";

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(text),
  ]);
}

// Ошибки отдаём модели обычным текстом, чтобы она поняла, что исправить.
async function guarded(
  action: () => Promise<string>,
): Promise<vscode.LanguageModelToolResult> {
  try {
    return textResult(await action());
  } catch (error: any) {
    return textResult(`Ошибка: ${error?.message || String(error)}`);
  }
}

interface SubmitInput {
  file?: string;
  code?: string;
  fileName?: string;
}

async function resolveSource(
  input: SubmitInput,
): Promise<{ fileName: string; text: string }> {
  if (input.code) {
    const name = input.fileName?.trim();
    if (!name || !path.extname(name)) {
      throw new Error(
        "Для отправки кода укажите fileName с расширением языка, например solution.c.",
      );
    }
    return { fileName: path.basename(name), text: input.code };
  }
  let document: vscode.TextDocument;
  if (input.file) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const uri =
      path.isAbsolute(input.file) || !folder
        ? vscode.Uri.file(input.file)
        : vscode.Uri.joinPath(folder.uri, input.file);
    document = await vscode.workspace.openTextDocument(uri);
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error(
        "Нечего отправлять: передайте file (путь к файлу решения) либо code вместе с fileName (например solution.c).",
      );
    }
    document = editor.document;
  }
  if (document.isUntitled)
    throw new Error(
      "Сохраните файл с расширением языка или передайте code и fileName.",
    );
  return {
    fileName: path.basename(document.uri.fsPath),
    text: document.getText(),
  };
}

export function registerEjudgeTools(
  context: vscode.ExtensionContext,
  proxy: EjudgeProxy,
) {
  context.subscriptions.push(
    vscode.lm.registerTool<{ problem?: string }>("get_ejudge_problem", {
      invoke: (options) =>
        guarded(() =>
          proxy.describeProblem(getActiveContestId(), options.input.problem),
        ),
    }),
    vscode.lm.registerTool<Record<string, never>>("get_ejudge_last_submit", {
      invoke: () =>
        guarded(() => proxy.describeLastSubmit(getActiveContestId())),
    }),
    vscode.lm.registerTool<{ runId: string; kind: "source" | "report" }>(
      "get_ejudge_submission",
      {
        invoke: (options) =>
          guarded(() =>
            proxy.describeSubmission(
              getActiveContestId(),
              options.input.runId,
              options.input.kind,
            ),
          ),
      },
    ),
    vscode.lm.registerTool<Record<string, never>>("list_ejudge_problems", {
      invoke: () => guarded(() => proxy.describeProblems(getActiveContestId())),
    }),
    vscode.lm.registerTool<SubmitInput>("submit_ejudge_problem", {
      async prepareInvocation(options) {
        try {
          const target = proxy.getSubmitTarget(getActiveContestId());
          const source = await resolveSource(options.input);
          const message = new vscode.MarkdownString();
          message.appendMarkdown(
            `Файл **${source.fileName}** → контест **${target.contestLabel}**, задача **${target.problemTitle}**.\n\n` +
              "Отправка необратима и тратит попытку.\n\n",
          );
          message.appendCodeblock(
            source.text.split("\n").slice(0, 20).join("\n"),
          );
          return {
            invocationMessage: `Отправка ${source.fileName} в ejudge…`,
            confirmationMessages: {
              title: "Отправить решение в ejudge?",
              message,
            },
          };
        } catch {
          // Причину вернёт сам invoke, чтобы модель увидела её текстом.
          return { invocationMessage: "Подготовка отправки в ejudge…" };
        }
      },
      invoke: (options) =>
        guarded(async () => {
          const contestId = getActiveContestId();
          proxy.getSubmitTarget(contestId);
          const source = await resolveSource(options.input);
          const result = await proxy.submitContent(
            contestId as string,
            source.fileName,
            Buffer.from(source.text, "utf8"),
          );
          if (result.ok)
            await watchActiveContest();
          return result.ok
            ? `Отправлено: ${result.message}`
            : `Не отправлено: ${result.message}`;
        }),
    }),
  );
}
