import * as vscode from 'vscode';
import { Contest, ContestFormData, ContestsProvider } from './contestsProvider';
// Панели хранятся в Map по ключу (id контеста или "__new__" для формы
// создания) — каждый onDidDispose проверяет, что удаляет именно свою
// запись, а не чужую (важно при быстром открытии настроек для A, потом B).
const panels = new Map<string, vscode.WebviewPanel>();
export async function openContestSettings(
  context: vscode.ExtensionContext,
  provider: ContestsProvider,
  existing?: Contest
) {
  const key = existing ? existing.id : '__new__';
  const prior = panels.get(key);
  if (prior) {
    prior.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel('ejudgeContestSettings', existing ? `Настройки: ${existing.label}` : 'Новый контест', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
  panels.set(key, panel);
  panel.webview.html = getFormHtml(existing);
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'save') {
      const data: ContestFormData = msg.data;
      if (!data.label?.trim() || !data.url?.trim()) {
        panel.webview.postMessage({ type: 'error', message: 'Название и URL обязательны.' });
        return;
      }
      if (existing) data.id = existing.id;
      const id = await provider.upsertContest(data);
      vscode.window.showInformationMessage(`Контест "${data.label}" сохранён.`);
      void provider.askMissingSecrets(id);
      panel.dispose();
    } else if (msg.type === 'cancel') {
      panel.dispose();
    }
  });
  panel.onDidDispose(() => {
    if (panels.get(key) === panel) panels.delete(key);
  });
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function getFormHtml(existing: Contest | undefined): string {
  const c = existing;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body{font-family:-apple-system,Segoe UI,sans-serif;background:#1e1e1e;color:#d4d4d4;padding:20px 24px;font-size:13px;}
  h2{font-size:16px;margin:0 0 16px;}
  label{display:block;margin:14px 0 4px;color:#ccc;font-size:12px;}
  input[type=text],input[type=password],input[type=number],select{
    width:100%;max-width:420px;padding:6px 8px;background:#3c3c3c;border:1px solid #555;color:#d4d4d4;border-radius:4px;
  }
  .hint{font-size:11px;color:#9a9a9a;margin-top:4px;max-width:420px;}
  .row{display:flex;align-items:center;gap:8px;margin-top:14px;}
  fieldset{margin-top:16px;border:1px solid #3c3c3c;border-radius:6px;padding:12px 14px;max-width:440px;}
  fieldset legend{color:#ccc;font-size:12px;}
  .actions{margin-top:22px;display:flex;gap:10px;}
  button{padding:7px 16px;border:none;border-radius:4px;cursor:pointer;font-size:13px;}
  button.primary{background:#0e639c;color:#fff;}
  button.secondary{background:#3c3c3c;color:#d4d4d4;}
  #error{color:#f48771;font-size:12px;margin-top:10px;display:none;}
</style>
</head>
<body>
  <h2>${existing ? 'Настройки контеста' : 'Новый контест'}</h2>

  <label>Название</label>
  <input type="text" id="label" value="${esc(c?.label || '')}" />

  <label>URL страницы входа ejudge</label>
  <input type="text" id="url" value="${esc(c?.url || '')}" />

  <div class="hint">Нужна ссылка на сам контест вида https://unicorn.ejudge.ru/ej/client?contest_id=562, а не на страницу регистрации.</div>

  <label>Регулярное выражение для групп задач (по названию)</label>
  <input type="text" id="groupRegex" value="${esc(c?.groupRegex || '')}" placeholder="например: ^(Лабораторная \\d+)" />
  <div class="hint">Задачи с одинаковым ключом попадают в одну группу. Ключ — первая группа захвата, а если её нет, то всё совпадение. Пусто или нет совпадений — плоский список. Порядок задач и групп авторский.</div>

  <label>Логин</label>
  <input type="text" id="login" value="${esc(c?.login || '')}" />
  <div class="hint">Пароль VS Code спросит отдельным полем ввода при сохранении и первом входе.</div>

  <div class="row">
    <input type="checkbox" id="useProxy" ${c?.proxy ? 'checked' : ''} />
    <label style="margin:0;">Использовать SOCKS5-прокси</label>
  </div>
  <div class="hint">Если сеть VM не достаёт до хоста ejudge напрямую, но есть прокси с доступом туда.</div>

  <fieldset id="proxyFields" style="${c?.proxy ? '' : 'display:none;'}">
    <legend>SOCKS5 proxy</legend>
    <label>Хост</label>
    <input type="text" id="proxyHost" value="${esc(c?.proxy?.host || '')}" />
    <label>Порт</label>
    <input type="number" id="proxyPort" value="${c?.proxy?.port || 1080}" />
    <label>Пользователь (опционально)</label>
    <input type="text" id="proxyUsername" value="${esc(c?.proxy?.username || '')}" />
    <div class="hint">Пароль VS Code спросит отдельным полем ввода при сохранении и первом входе.</div>
  </fieldset>
</fieldset>

  <div id="error"></div>

  <div class="actions">
    <button class="primary" id="saveBtn">Сохранить</button>
    <button class="secondary" id="cancelBtn">Отмена</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const useProxy = document.getElementById('useProxy');
  const proxyFields = document.getElementById('proxyFields');
  useProxy.addEventListener('change', () => {
    proxyFields.style.display = useProxy.checked ? '' : 'none';
  });

  document.getElementById('saveBtn').addEventListener('click', () => {
    const data = {
      label: document.getElementById('label').value,
      url: document.getElementById('url').value,
      groupRegex: document.getElementById('groupRegex').value.trim() || undefined,
      login: document.getElementById('login').value,
    };
    if (useProxy.checked) {
      data.proxyHost = document.getElementById('proxyHost').value;
      data.proxyPort = parseInt(document.getElementById('proxyPort').value, 10) || 1080;
      data.proxyUsername = document.getElementById('proxyUsername').value || undefined;
    }
    vscode.postMessage({ type: 'save', data });
  });

  document.getElementById('cancelBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'error') {
      const el = document.getElementById('error');
      el.textContent = msg.message;
      el.style.display = 'block';
    }
  });
</script>
</body>
</html>`;
}


