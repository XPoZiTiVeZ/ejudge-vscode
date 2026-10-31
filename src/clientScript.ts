// Client-side script, который прокси добавляет в страницу, когда она
// открыта внутри webview VS Code (в URL был _client=vscode).
//
// Что делает:
// - выполняет команды панели (назад/вперёд/обновить);
// - перехватывает клики по ссылкам "Исходник"/"Протокол" в таблице посылок и
//   открывает текст как файл в соседней вкладке VS Code;
// - кнопки ИИ: сгенерировать / открыть ответ / стереть ответ;
// - скрытие и показ групп задач в списке;
// - показывает сообщение, если серверный логин не удался.
export const CLIENT_SCRIPT = String.raw`
(function () {
  var CONTEST_ID = window.__ejudgeContestId;

  function apiUrl(path) {
    var marker = '/proxy/' + CONTEST_ID + '/';
    var full = window.location.pathname;
    var idx = full.indexOf(marker);
    var prefix = idx >= 0 ? full.slice(0, idx) : '';
    return prefix + path;
  }

  function log(level, message) {
    try {
      fetch(apiUrl('/ejudge-api/log'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: level, message: message })
      });
    } catch (e) { /* ignore */ }
  }

  function postJson(path, payload) {
    return fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (error) {
          throw new Error('Расширение вернуло некорректный JSON. HTTP ' + response.status + ': ' + (text || '<пустой ответ>'));
        }
        if (!response.ok || !data || !data.ok) {
          throw new Error((data && data.error) || ('Запрос к расширению завершился с HTTP ' + response.status));
        }
        return data;
      });
    });
  }

  // ---------- back / forward / reload из родительской панели ----------
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || !msg.ejudgeShellAction) return;
    if (msg.ejudgeShellAction === 'back') history.back();
    else if (msg.ejudgeShellAction === 'forward') history.forward();
    else if (msg.ejudgeShellAction === 'reload') location.reload();
    else if (msg.ejudgeShellAction === 'prevProblem') stepProblem(-1);
    else if (msg.ejudgeShellAction === 'nextProblem') stepProblem(1);
  });

  function showPageMessage(text, isError) {
    var old = document.getElementById('__ejudge_message');
    if (old) old.remove();

    var message = document.createElement('div');
    message.id = '__ejudge_message';
    message.textContent = text;
    message.style.cssText =
      'position:fixed;right:18px;bottom:18px;z-index:2147483647;' +
      'max-width:min(520px,calc(100vw - 36px));padding:11px 14px;' +
      'border-radius:6px;font-family:var(--vscode-font-family,sans-serif);' +
      'font-size:13px;line-height:1.4;box-shadow:0 6px 24px rgba(0,0,0,.45);' +
      'background:' + (isError ? '#5a1d1d' : '#1e4a28') + ';' +
      'color:#eee;border:1px solid ' + (isError ? '#f48771' : '#89d185') + ';';

    document.documentElement.appendChild(message);
    setTimeout(function () {
      if (message.parentNode) message.remove();
    }, 10000);
  }

  // ---------- ссылки посылок ("Исходник"/"Протокол"): открыть как файл ----------
  // data-kind говорит proxyServer.ts, как превращать HTML в текст:
  // 'source'/'generic' — искать <pre> с кодом (иначе взять весь body),
  // 'report' — разбирать блок div.l14 (статус + сводка + таблица тестов).
  // Параметры _raw=1&_kind=... просят прокси вернуть text/plain вместо страницы.
  function openLinkAsFile(link) {
    var href = link.getAttribute('href');
    var kind = link.getAttribute('data-kind') || 'source';
    var runId = link.getAttribute('data-run-id') || 'run';
    var sep = href.indexOf('?') === -1 ? '?' : '&';
    var namePrefix = kind === 'report' ? 'report' : kind === 'source' ? 'run' : 'view';
    fetch(href + sep + '_raw=1&_kind=' + kind)
      .then(function (r) { return r.text(); })
      .then(function (text) {
        window.parent.postMessage({ type: 'ejudge-open-source', filename: namePrefix + '-' + runId + '.txt', content: text }, '*');
      })
      .catch(function (e) {
        log('error', 'open-as-file failed: ' + e);
        showPageMessage('Не удалось получить содержимое: ' + e, true);
      });
  }

  function patchRunLinks() {
    document.querySelectorAll('a.run-link').forEach(function (link) {
      if (link.dataset.ejudgePatched) return;
      link.dataset.ejudgePatched = '1';
      link.addEventListener('click', function (e) {
        e.preventDefault();
        openLinkAsFile(link);
      });
    });
  }

  // ---------- Gemini: одна кнопка (создать / открыть) + кнопка стирания ----------
  var languageMenu = null;

  function closeLanguageMenu() {
    if (languageMenu) { languageMenu.remove(); languageMenu = null; }
  }

  function openAiAnswer() {
    fetch(apiUrl('/ejudge-api/ai-answer?contest=' + encodeURIComponent(CONTEST_ID)))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { showPageMessage(data.error || 'Нет сохранённого ответа ИИ.', true); return; }
        window.parent.postMessage({
          type: 'ejudge-open-source',
          filename: data.filename || 'ai-solution.txt',
          content: data.code || '',
          language: data.language || 'plaintext'
        }, '*');
      })
      .catch(function (e) { log('error', 'open AI answer failed: ' + e); showPageMessage('Не удалось открыть ответ ИИ: ' + e, true); });
  }

  function generateAiAnswer(button, languageName) {
    closeLanguageMenu();
    var oldText = button.textContent;
    var oldTitle = button.title;
    button.disabled = true;
    button.textContent = '…';
    button.title = 'Gemini генерирует решение…';

    postJson('/ejudge-api/ai-generate', { contest: CONTEST_ID, language: languageName })
      .then(function () {
        // Перезагрузка нужна, чтобы кнопка перешла в режим "открыть".
        location.reload();
      })
      .catch(function (error) {
        log('error', 'AI generate failed: ' + error);
        showPageMessage('Не удалось сгенерировать решение: ' + error.message, true);
        button.disabled = false;
        button.textContent = oldText;
        button.title = oldTitle;
      });
  }

  // Выбор языка из списка, который ejudge показывает в форме отправки.
  // Если язык один (или фиксированный) — выбирается сразу.
  function showLanguageMenu(button, languages) {
    closeLanguageMenu();
    languageMenu = document.createElement('div');
    languageMenu.style.cssText =
      'position:absolute;z-index:2147483000;min-width:220px;max-height:50vh;overflow:auto;' +
      'background:#252526;color:#eee;border:1px solid #555;border-radius:6px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.45);padding:4px 0;font-size:13px;';
    var rect = button.getBoundingClientRect();
    languageMenu.style.left = (rect.left + window.scrollX) + 'px';
    languageMenu.style.top = (rect.bottom + window.scrollY + 4) + 'px';

    var title = document.createElement('div');
    title.textContent = 'Язык решения';
    title.style.cssText = 'padding:6px 12px;color:#a9a9a9;font-size:11px;text-transform:uppercase;';
    languageMenu.appendChild(title);

    languages.forEach(function (name) {
      var row = document.createElement('div');
      row.textContent = name;
      row.style.cssText = 'padding:6px 12px;cursor:pointer;';
      row.onmouseenter = function () { row.style.background = '#3a3d41'; };
      row.onmouseleave = function () { row.style.background = 'transparent'; };
      row.onclick = function () { generateAiAnswer(button, name); };
      languageMenu.appendChild(row);
    });
    document.documentElement.appendChild(languageMenu);
  }

  function onAiButtonClick(e) {
    var button = e.currentTarget;
    e.stopPropagation();
    if (button.getAttribute('data-saved') === '1') {
      openAiAnswer();
      return;
    }
    var languages = [];
    try { languages = JSON.parse(button.getAttribute('data-languages') || '[]'); } catch (err) { languages = []; }
    if (languages.length > 1) showLanguageMenu(button, languages);
    else generateAiAnswer(button, languages[0] || '');
  }

  function onAiClearClick() {
    postJson('/ejudge-api/ai-clear', { contest: CONTEST_ID })
      .then(function () { location.reload(); })
      .catch(function (error) {
        log('error', 'AI clear failed: ' + error);
        showPageMessage('Не удалось стереть решение: ' + error.message, true);
      });
  }

  function patchAiButtons() {
    var main = document.getElementById('ejudgeAiButton');
    if (main && !main.dataset.ejudgePatched) {
      main.dataset.ejudgePatched = '1';
      main.addEventListener('click', onAiButtonClick);
    }
    var clear = document.getElementById('ejudgeAiClear');
    if (clear && !clear.dataset.ejudgePatched) {
      clear.dataset.ejudgePatched = '1';
      clear.addEventListener('click', onAiClearClick);
    }
  }

  document.addEventListener('click', function (e) {
    if (languageMenu && !languageMenu.contains(e.target)) closeLanguageMenu();
  });

  // Кружки статусов слева от условия: скрытая группа не показывает кружки (кроме текущей задачи).
  function refreshRail(key, hidden) {
    document.querySelectorAll('.rail-seg[data-group]').forEach(function (seg) {
      if (seg.getAttribute('data-group') !== key) return;
      seg.classList.toggle('seg-hidden', hidden);
      seg.classList.toggle('seg-empty', hidden && !seg.querySelector('.status-dot.current'));
    });
    var first = true;
    document.querySelectorAll('.rail-seg').forEach(function (seg) {
      var visible = !seg.classList.contains('seg-empty');
      seg.classList.toggle('seg-first', visible && first);
      if (visible) first = false;
    });
  }

  // ---------- Скрытие / показ групп задач в списке ----------
  function patchGroupEyes() {
    document.querySelectorAll('.pgroup-eye').forEach(function (eye) {
      if (eye.dataset.ejudgePatched) return;
      eye.dataset.ejudgePatched = '1';
      eye.addEventListener('click', function (e) {
        e.stopPropagation();
        var group = eye.closest('.pgroup');
        if (!group) return;
        var hidden = !group.classList.contains('hidden-group');
        group.classList.toggle('hidden-group', hidden);
        if (hidden) group.classList.remove('open');
        eye.title = hidden ? 'Показать группу' : 'Скрыть группу';
        refreshRail(group.getAttribute('data-key') || '', hidden);
        postJson('/ejudge-api/group-visibility', {
          contest: CONTEST_ID,
          key: group.getAttribute('data-key') || '',
          hidden: hidden
        }).catch(function (error) {
          log('error', 'group visibility failed: ' + error);
          showPageMessage('Не удалось сохранить видимость группы: ' + error.message, true);
        });
      });
    });
  }

  // ---------- Сообщение, если серверный логин не удался ----------
  function checkLoginFailure() {
    var pwdInput = document.querySelector('input[name="password"], input[type="password"]');
    if (!pwdInput) return false;

    log('warn', 'server-side login did not succeed — showing raw login page.');

    var overlay = document.createElement('div');
    overlay.id = '__ejudge_login_overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:#1e1e1e;color:#eee;z-index:2147483000;' +
      'display:flex;align-items:center;justify-content:center;flex-direction:column;' +
      'font-family:sans-serif;text-align:center;padding:24px;';

    var msg = document.createElement('div');
    msg.style.cssText = 'font-size:14px;margin-bottom:14px;max-width:480px;color:#f48771;';
    msg.textContent = 'Не удалось войти в ejudge — проверьте логин/пароль и ссылку контеста в настройках.';
    overlay.appendChild(msg);

    var btn = document.createElement('div');
    btn.textContent = 'Перезагрузить';
    btn.style.cssText = 'cursor:pointer;color:#9cdcfe;text-decoration:underline;font-size:13px;';
    btn.onclick = function () { location.reload(); };
    overlay.appendChild(btn);

    document.documentElement.appendChild(overlay);
    document.documentElement.style.visibility = 'visible';
    return true;
  }

  // Цвета кружков берём только из панели задач и снимаем один раз; при переходах между
  // задачами используем сохранённый снимок, заново читаем панель только при перезагрузке.
  function syncRailColors() {
    var storeKey = 'ejudge.statuses.' + CONTEST_ID;
    var nav = window.performance && performance.getEntriesByType
      ? performance.getEntriesByType('navigation')[0]
      : null;
    var isReload = !!nav && nav.type === 'reload';

    var saved = {};
    try { saved = JSON.parse(sessionStorage.getItem(storeKey) || '{}') || {}; } catch (e) { saved = {}; }

    if (isReload || Object.keys(saved).length === 0) {
      document.querySelectorAll('#ejudgeProblemsPanel a').forEach(function (link) {
        if (link.classList.contains('active')) return;
        var name = (link.textContent || '').trim();
        if (!name) return;
        saved[name] = link.classList.contains('ok') ? 'ok' : link.classList.contains('wa') ? 'wa' : 'none';
      });
      try { sessionStorage.setItem(storeKey, JSON.stringify(saved)); } catch (e) { /* ignore */ }
    }

    document.querySelectorAll('.status-rail .status-dot').forEach(function (dot) {
      var status = saved[dot.getAttribute('title') || ''] || 'none';
      dot.classList.remove('ok', 'wa', 'none');
      dot.classList.add(status);
    });
  }

  // ---------- Листание задач стрелками влево / вправо ----------
  // Берём ссылки из меню задач в порядке показа; задачи из скрытых групп пропускаем.
  function stepProblem(delta) {
    var links = Array.prototype.filter.call(document.querySelectorAll('#ejudgeProblemsPanel a'), function (link) {
      return link.classList.contains('active') || !link.closest('.pgroup.hidden-group');
    });
    var index = links.findIndex(function (link) { return link.classList.contains('active'); });
    if (index < 0) return;
    var target = links[index + delta];
    if (target) location.href = target.href;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    var el = document.activeElement;
    var tag = el && el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
    e.preventDefault();
    stepProblem(e.key === 'ArrowRight' ? 1 : -1);
  });

  function scan() {
    patchRunLinks();
    patchAiButtons();
    patchGroupEyes();
  }

  var scanScheduled = false;
  new MutationObserver(function () {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(function () { scanScheduled = false; scan(); });
  }).observe(document.documentElement, { childList: true, subtree: true });

  function init() {
    try { window.parent.postMessage({ type: 'ejudge-loaded' }, '*'); } catch (e) { /* ignore */ }
    log('info', 'page loaded: ' + window.location.pathname);
    scan();
    if (checkLoginFailure()) return;
    document.documentElement.style.visibility = 'visible';
  }

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
`;
