import * as vscode from 'vscode';
import { ContestsProvider, ContestItem } from './contestsProvider';
import { EjudgeProxy } from './proxyServer';
import { openContestPanel, reloadActiveContest, goBackActive, goForwardActive, getActiveContestId, onActiveContestChanged } from './contestPanel';
import { registerSubmitButtons } from './submitButtons';
import { openContestSettings } from './contestSettingsPanel';

const DOUBLE_CLICK_MS = 400;

// Для нового файла без имени (untitled) расширение берём по языку редактора.
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  c: 'c', cpp: 'cpp', python: 'py', java: 'java', kotlin: 'kt', go: 'go', rust: 'rs',
  javascript: 'js', typescript: 'ts', csharp: 'cs', pascal: 'pas', ruby: 'rb', haskell: 'hs', php: 'php'
};
const lastClick = new Map<string, number>();

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Ejudge');
  context.subscriptions.push(output);
  output.appendLine('[ejudge] extension activated');

  const provider = new ContestsProvider(context);
  await provider.init();
  context.subscriptions.push(provider);
  vscode.window.registerTreeDataProvider('ejudgeContests', provider);

  const proxy = new EjudgeProxy(provider, output);
  const port = await proxy.start();
  output.appendLine(`[ejudge] local proxy listening on 127.0.0.1:${port}`);
  context.subscriptions.push({ dispose: () => proxy.dispose() });

  // Дублирующие кнопки отправки решения: статус-бар и CodeLens над первой
  // строкой файла (кроме кнопки в тулбаре редактора из package.json).
  registerSubmitButtons(context, () => !!getActiveContestId(), onActiveContestChanged);

  context.subscriptions.push(
    vscode.commands.registerCommand('ejudge.addContest', () => openContestSettings(context, provider)),
    vscode.commands.registerCommand('ejudge.editContest', (item: ContestItem) =>
      openContestSettings(context, provider, item.contest)
    ),
    vscode.commands.registerCommand('ejudge.editSelectors', (item: ContestItem) => provider.editSelectors(item)),
    vscode.commands.registerCommand('ejudge.deleteContest', (item: ContestItem) => provider.deleteContest(item)),
    vscode.commands.registerCommand('ejudge.showLogs', () => output.show(true)),
    vscode.commands.registerCommand('ejudge.reloadContest', () => reloadActiveContest()),
    vscode.commands.registerCommand('ejudge.back', () => goBackActive()),
    vscode.commands.registerCommand('ejudge.forward', () => goForwardActive()),
    

    vscode.commands.registerCommand('ejudge.openContest', async (contestId: string) => {
      const contest = provider.getContest(contestId);
      if (!contest) return;
      output.appendLine(`[ejudge] opening contest panel: ${contest.label} (${contest.id})`);
      await openContestPanel(context, contest, port);
    }),

    // Tree items fire a command on every click; we distinguish single vs
    // double click manually since VS Code's TreeView only exposes single click.
    vscode.commands.registerCommand('ejudge.itemClicked', async (contestId: string) => {
      const now = Date.now();
      const prev = lastClick.get(contestId) || 0;
      lastClick.set(contestId, now);
      if (now - prev < DOUBLE_CLICK_MS) {
        lastClick.delete(contestId);
        await vscode.commands.executeCommand('ejudge.openContest', contestId);
      }
    }),

    // Кнопка рядом с "Run File" в тулбаре редактора — отправляет текущий
    // открытый файл в задачу, которая последней открывалась в активной
    // панели контеста. Спрашивает подтверждение, так как отправка решения
    // в ejudge необратима (тратит попытку/квоту).
    vscode.commands.registerCommand('ejudge.sendCurrentFileToContest', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Нет открытого файла.');
        return;
      }

      const contestId = getActiveContestId();
      if (!contestId) {
        vscode.window.showWarningMessage('Откройте панель контеста и нужную задачу, затем повторите.');
        return;
      }

      const contest = provider.getContest(contestId);
      if (!contest) {
        vscode.window.showWarningMessage('Контест не найден.');
        return;
      }

      // Отправляем то, что сейчас в редакторе (в том числе несохранённые правки и
      // новый файл без пути) — сохранять на диск для этого не нужно.
      const document = editor.document;
      let fileName: string;
      if (document.isUntitled) {
        const ext = LANGUAGE_EXTENSIONS[document.languageId];
        if (!ext) {
          vscode.window.showWarningMessage('Выберите язык файла (справа внизу в строке состояния) — иначе не определить язык решения.');
          return;
        }
        fileName = `solution.${ext}`;
      } else {
        fileName = document.uri.fsPath.split(/[\\/]/).pop() || 'solution.txt';
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Отправить файл "${fileName}" в контест "${contest.label}"? Это действие необратимо (тратит попытку отправки).`,
        { modal: true },
        'Отправить'
      );
      if (confirmed !== 'Отправить') return;

      const result = await proxy.submitContent(contestId, fileName, Buffer.from(document.getText(), 'utf8'));
      if (result.ok) {
        vscode.window.showInformationMessage(`✔ ${fileName}: ${result.message}`);
        // Перезагружаем панель контеста, чтобы сразу увидеть новую посылку
        // в таблице "Посылки" под условием задачи, а не только уведомление.
        await reloadActiveContest();
      } else {
        vscode.window.showErrorMessage(`✖ ${fileName}: ${result.message}`);
      }
    })
  );
}

export function deactivate() {}
