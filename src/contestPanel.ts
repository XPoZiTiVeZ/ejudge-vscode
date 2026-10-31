import * as vscode from 'vscode';
import { Contest } from './contestsProvider';

interface PanelInfo {
  panel: vscode.WebviewPanel;
  contest: Contest;
  port: number;
}

const panels = new Map<string, PanelInfo>();
let activeContestId: string | undefined;

// Нужен кнопкам отправки решения (submitButtons.ts): они показываются, пока
// открыта хотя бы одна панель контеста.
const activeContestEmitter = new vscode.EventEmitter<void>();
export const onActiveContestChanged = activeContestEmitter.event;

function setActiveContest(id: string | undefined) {
  if (activeContestId === id) return;
  activeContestId = id;
  activeContestEmitter.fire();
}

export async function openContestPanel(context: vscode.ExtensionContext, contest: Contest, port: number) {
  const existing = panels.get(contest.id);
  if (existing) {
    existing.panel.reveal(vscode.ViewColumn.Beside);
    setActiveContest(contest.id);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'ejudgeContest',
    contest.label,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  await renderPanel(panel, contest, port, true);

  // Шапка (getShellHtml) не может сама выполнить fetch/открытие файла —
  // ей приходит сообщение из iframe (clientScript.ts, тот же самый origin
  // что и сама задача) через postMessage, а она пересылает его сюда, в
  // extension host, через acquireVsCodeApi().
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.command === 'open-source') {
      try {
        const doc = await vscode.workspace.openTextDocument({
          content: String(msg.content ?? ''),
          language: String(msg.language || 'plaintext')
        });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
      } catch (error: any) {
        vscode.window.showErrorMessage(`Не удалось открыть исходник: ${error?.message || String(error)}`);
      }
    }
  });

  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) setActiveContest(contest.id);
  });

  panels.set(contest.id, { panel, contest, port });
  if (panel.active || !activeContestId) setActiveContest(contest.id);
  panel.onDidDispose(() => {
    panels.delete(contest.id);
    if (activeContestId === contest.id) {
      // Если открыта другая панель контеста — переключаемся на неё.
      setActiveContest(panels.keys().next().value as string | undefined);
    }
  });
}

async function renderPanel(panel: vscode.WebviewPanel, contest: Contest, port: number, resetLogin = false) {
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port}/`));
  const base = external.toString().replace(/\/+$/, '');
  // "_client=vscode" — маркер для proxyServer.ts: страница открыта внутри
  // webview VS Code, значит можно инжектить клиентский скрипт (кастомный
  // выбор файла, перехват "Исходник"/"Протокол"). Без этого параметра
  // (обычный браузер) прокси отдаёт чисто HTML+CSS без единого script.
  const params = resetLogin ? 'reset_login=1&_client=vscode' : '_client=vscode';
  const iframeSrc = `${base}/proxy/${contest.id}?${params}`;
  panel.webview.html = getShellHtml(iframeSrc);
}

export function getActiveContestId(): string | undefined {
  return activeContestId;
}

export async function goBackActive() {
  const info = activeContestId ? panels.get(activeContestId) : undefined;
  if (info) info.panel.webview.postMessage({ action: 'back' });
}

export async function goForwardActive() {
  const info = activeContestId ? panels.get(activeContestId) : undefined;
  if (info) info.panel.webview.postMessage({ action: 'forward' });
}

export async function reloadActiveContest() {
  const info = activeContestId ? panels.get(activeContestId) : undefined;
  if (!info) {
    vscode.window.showInformationMessage('Нет открытой панели контеста.');
    return;
  }
  info.panel.webview.postMessage({ action: 'reload' });
}

function getShellHtml(iframeSrc: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;height:100%;background:#1e1e1e}
  iframe{width:100%;height:100vh;border:none;display:block}
</style>
</head>
<body>
<iframe id="ejudgeFrame" src="${iframeSrc}"></iframe>
<script>
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById('ejudgeFrame');

  // Команды back/forward/reload от extension host — раньше здесь пытались
  // напрямую дёргать frame.contentWindow.history/location, но браузер
  // блокирует такой доступ между разными origin (эта панель — на своём
  // origin, iframe — на http://127.0.0.1:PORT). Теперь просим сам iframe
  // выполнить действие через postMessage — там правильный origin.
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.action) {
      frame.contentWindow.postMessage({ ejudgeShellAction: msg.action }, '*');
      return;
    }

    // Сообщения ОТ iframe (clientScript.ts) — например, запрос открыть
    // исходник посылки как файл в соседней вкладке VS Code.
    if (msg.type === 'ejudge-open-source') {
      vscode.postMessage({
        command: 'open-source',
        filename: msg.filename,
        content: msg.content,
        language: msg.language
      });
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    frame.contentWindow.postMessage(
      { ejudgeShellAction: event.key === 'ArrowRight' ? 'nextProblem' : 'prevProblem' },
      '*'
    );
  });
</script>
</body>
</html>`;
}
