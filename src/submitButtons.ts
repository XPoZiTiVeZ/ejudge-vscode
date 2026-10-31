import * as vscode from 'vscode';

const SEND_COMMAND = 'ejudge.sendCurrentFileToContest';

// Расширения файлов и языки редактора, для которых показывается CodeLens.
// Статус-бар показывается для любого файла (сохранённого или нового).
const SOURCE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'py', 'java', 'kt', 'go', 'rs',
  'js', 'ts', 'cs', 'pas', 'pp', 'rb', 'hs', 'php'
]);
const SOURCE_LANGUAGES = new Set([
  'c', 'cpp', 'python', 'java', 'kotlin', 'go', 'rust', 'javascript',
  'typescript', 'csharp', 'pascal', 'ruby', 'haskell', 'php'
]);

// Отправка работает и для несохранённых правок, и для нового файла без
// пути (untitled) — поэтому допускаются обе схемы.
function isSendable(document: vscode.TextDocument): boolean {
  return document.uri.scheme === 'file' || document.uri.scheme === 'untitled';
}

function isSourceDocument(document: vscode.TextDocument): boolean {
  if (!isSendable(document)) return false;
  if (document.uri.scheme === 'untitled') return SOURCE_LANGUAGES.has(document.languageId);
  const ext = document.uri.fsPath.split('.').pop()?.toLowerCase() || '';
  return SOURCE_EXTENSIONS.has(ext);
}

// Кнопка в тулбаре редактора (editor/title в package.json) зависит от
// when-условий VS Code и бывает скрыта. Поэтому отправка дублируется:
//  - в статус-баре справа;
//  - CodeLens над первой строкой файла — прямо в редакторе.
// Обе кнопки показываются, пока открыта панель контеста.
export function registerSubmitButtons(
  context: vscode.ExtensionContext,
  hasOpenContest: () => boolean,
  onContestChanged: vscode.Event<void>
) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  status.command = SEND_COMMAND;
  status.text = '$(cloud-upload) Отправить в ejudge';
  status.tooltip = 'Отправить текущий файл (в том числе несохранённый) в задачу, открытую в панели контеста';

  const lensChanged = new vscode.EventEmitter<void>();
  const lensProvider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
      if (!hasOpenContest() || !isSourceDocument(document)) return [];
      return [
        new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: '$(cloud-upload) Отправить в ejudge',
          tooltip: 'Отправить текущий файл (в том числе несохранённый) в задачу, открытую в панели контеста',
          command: SEND_COMMAND
        })
      ];
    }
  };

  const update = () => {
    const editor = vscode.window.activeTextEditor;
    const visible = hasOpenContest() && !!editor && isSendable(editor.document);
    if (visible) status.show();
    else status.hide();
    lensChanged.fire();
  };

  context.subscriptions.push(
    status,
    lensChanged,
    vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'untitled' }], lensProvider),
    vscode.window.onDidChangeActiveTextEditor(update),
    // Срабатывает и при смене языка у нового файла.
    vscode.workspace.onDidOpenTextDocument(() => lensChanged.fire()),
    onContestChanged(update)
  );

  update();
}
