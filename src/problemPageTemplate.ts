import { ContestInfo, ProblemDetail, ProblemSummary, SubmissionRow, DotStatus } from './ejudgeParsers';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c] as string));
}

const CSS = `
:root{
  --bg:#1e1e1e; --panel:#252526; --panel2:#2d2d30; --border:#3c3c3c;
  --text:#d4d4d4; --muted:#a9a9a9; --accent:#3794ff; --ok:#89d185; --bad:#f48771; --pending:#e8c66c;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Ubuntu,sans-serif;font-size:14px}
.header{border-bottom:1px solid var(--border);background:var(--panel)}
.topbar{position:sticky;top:0;z-index:30;display:flex;align-items:stretch;background:var(--panel);border-bottom:1px solid var(--border);box-shadow:0 3px 10px rgba(0,0,0,.35)}
.topbar .header{flex:1 1 auto;min-width:0;border-bottom:0}
.topbar-actions{flex:0 0 auto;display:flex;align-items:flex-start;padding:7px 12px;border-left:1px solid var(--border)}
.participant{padding:9px 14px 7px;font-weight:600;font-size:14px}
.info-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid var(--border)}
.info-cell{padding:8px 14px;border-right:1px solid var(--border);min-width:0}
.info-cell:last-child{border-right:0}
.info-label{font-size:11px;color:var(--muted);margin-bottom:3px}
.info-value{font-size:13px;overflow-wrap:anywhere}
.content-wrap{position:relative;display:flex;align-items:flex-start}
.content{flex:1 1 auto;min-width:0}
.status-rail{position:sticky;top:calc(var(--topbar-h,96px) + 10px);flex:0 0 auto;display:flex;flex-direction:column;align-items:center;width:30px;max-height:calc(100vh - var(--topbar-h,96px) - 20px);overflow-y:auto;padding:12px 0 12px 8px;scrollbar-width:none}
.status-rail::-webkit-scrollbar{display:none}
.rail-seg{display:flex;flex-direction:column;align-items:center;gap:8px;width:18px}
.rail-seg:not(.seg-first){margin-top:8px;padding-top:8px;border-top:1px solid #4a4a4a}
.rail-seg.seg-empty{display:none}
.rail-seg.seg-hidden .status-dot:not(.current){display:none}
.status-dot{display:block;box-sizing:border-box;width:12px;height:12px;flex:0 0 auto;border-radius:50%;border:2px solid #6b6b6b;background:transparent;transition:transform .1s}
.status-dot:hover{transform:scale(1.25)}
.status-dot.ok{background:var(--ok);border-color:var(--ok)}
.status-dot.wa{background:var(--bad);border-color:var(--bad)}
.status-dot.current{box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--accent)}
@media(max-width:700px){.status-rail{display:none}}
.content{padding:18px 76px 18px 22px;overflow-x:auto}
.title-row{display:flex;align-items:center;gap:10px;margin:0 0 12px}
.problem-title{margin:0;font-size:19px;line-height:1.35;color:#f0f0f0}
.limits-toggle{border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--muted);cursor:pointer;width:28px;height:28px;display:flex;align-items:center;justify-content:center;padding:0;flex:0 0 auto}
.limits-toggle:hover{background:var(--panel2);color:var(--text);border-color:#555}
.limits-toggle.open{color:var(--accent);border-color:var(--accent);background:var(--panel2)}
.limits{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--border);border-radius:6px;margin:0 0 18px;overflow:hidden}
.limit{padding:8px 11px;border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)}
.limit:last-child{border-bottom:0}
.limit b{color:#d6d6d6;margin-right:5px}
.statement{line-height:1.6;max-width:1200px}
.statement h1{display:none}
.statement h2{font-size:17px;margin:25px 0 10px;color:#ececec}
.statement h3{font-size:15px;margin:20px 0 9px;color:#ececec}
.statement h4{font-size:13px;margin:16px 0 7px;color:#e1e1e1}
.statement p{margin:10px 0}
.statement img{max-width:100%;height:auto}
.statement pre{margin:8px 0 18px;padding:10px 12px;overflow:auto;background:var(--panel);border-radius:4px;font-family:Consolas,"Cascadia Code",monospace;font-size:13px}
.statement code{font-family:Consolas,"Cascadia Code",monospace}
.raw-content{max-width:1200px;line-height:1.6}
.raw-content table{border-collapse:collapse;margin:0 0 16px}
.raw-content table,.raw-content td,.raw-content th{border:1px solid var(--border);padding:6px 9px;font-size:13px}
.runs-heading{margin:28px 0 10px;font-size:15px;color:#ececec}
.runs-table{width:100%;max-width:1400px;border-collapse:collapse;font-size:12.5px}
.runs-table th,.runs-table td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap}
.runs-table th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.02em}
.runs-table th.icon-col,.runs-table td.icon-col{text-align:center;width:70px}
.runs-table tbody tr:hover{background:rgba(255,255,255,.04)}
.runs-table td.result{font-weight:600;cursor:help}
.runs-table tr.ok td.result{color:var(--ok)}
.runs-table tr.bad td.result{color:var(--bad)}
.runs-table tr.pending td.result{color:var(--pending)}
.runs-table a{color:var(--muted);text-decoration:none;cursor:pointer;display:inline-flex;padding:4px;border-radius:4px;margin:0 1px}
.runs-table a:hover{color:var(--accent);background:rgba(255,255,255,.08)}
.runs-table a svg{display:block}
.empty{color:var(--muted)}
.problems-toggle{position:static;width:34px;height:34px;flex:0 0 auto;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:5;padding:0}
.problems-toggle:hover{background:var(--panel2);border-color:#555}
.problems-toggle.open{background:var(--panel2);border-color:var(--accent);color:var(--accent)}
.problems-panel{position:absolute;top:100%;right:0;width:280px;max-height:min(70vh,560px);overflow:auto;background:var(--panel);border:1px solid var(--border);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.45);z-index:10;display:none;padding:6px 0}
.problems-panel.open{display:block}
.problems-panel a{display:block;padding:7px 14px;border-left:3px solid transparent;color:var(--text);text-decoration:none;font-size:13px}
.problems-panel a:hover{background:rgba(255,255,255,.06)}
.problems-panel a.active{border-left-color:var(--accent);background:rgba(55,148,255,.16)}
.problems-panel .ok{color:var(--ok)}
.problems-panel .wa{color:var(--bad)}
.pgroup-head{display:flex;align-items:center;gap:8px;padding:7px 14px;cursor:pointer;color:var(--muted);font-size:13px;user-select:none}
.pgroup-head:hover{background:rgba(255,255,255,.06);color:var(--text)}
.pgroup-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pgroup-count{font-size:11px;line-height:1;padding:3px 7px;border-radius:9px;background:var(--panel2);border:1px solid var(--border)}
.pgroup .chev{flex:0 0 auto;transition:transform .15s}
.pgroup.open .chev{transform:rotate(90deg)}
.pgroup-items{display:none;margin-left:20px;border-left:1px solid var(--border)}
.pgroup.open .pgroup-items{display:block}
::-webkit-scrollbar{width:12px;height:12px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background-color:rgba(140,140,140,.35);border:3px solid transparent;background-clip:padding-box;border-radius:10px}
::-webkit-scrollbar-thumb:hover{background-color:rgba(55,148,255,.65)}
::-webkit-scrollbar-thumb:active{background-color:rgba(55,148,255,.90)}
::-webkit-scrollbar-corner{background:transparent}
.ai-btn{font-size:14px;line-height:1}
.ai-btn:disabled{opacity:.5;cursor:default}
.pgroup-eye{margin-left:2px;border:0;background:transparent;color:inherit;cursor:pointer;padding:2px 4px;border-radius:4px;display:flex;align-items:center;opacity:.65}
.pgroup-eye:hover{opacity:1;background:rgba(255,255,255,.08)}
.pgroup-eye .eye-off{display:none}
.pgroup.hidden-group .pgroup-eye .eye-on{display:none}
.pgroup.hidden-group .pgroup-eye .eye-off{display:block}
.pgroup.hidden-group .pgroup-head{opacity:.5;text-decoration:line-through}
.pgroup.hidden-group .pgroup-items{display:none!important}
@media(max-width:700px){
  .info-grid{grid-template-columns:1fr}
  .info-cell{border-right:0;border-bottom:1px solid var(--border)}
  .info-cell:last-child{border-bottom:0}
  .content{padding-right:22px}
  .problems-panel{right:12px;left:12px;width:auto}
}
`;

const MATHJAX_TAG = `
<script>
window.MathJax = {
  tex: { inlineMath: [['\\\\(', '\\\\)']], displayMath: [['\\\\[', '\\\\]'], ['$$', '$$']] },
  options: { skipHtmlTags: ['script','noscript','style','textarea','pre','code'] }
};
</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js" id="MathJax-script" async></script>
`;

const ICON_SOURCE = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`;
const ICON_REPORT = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>`;
const ICON_GENERIC = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const ICON_LIST = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>`;
const ICON_LIMITS = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>`;

const LINK_ICONS: Record<string, string> = { source: ICON_SOURCE, report: ICON_REPORT, generic: ICON_GENERIC };

const DROPDOWN_SCRIPT = `
<script>
(function () {
  var btn = document.getElementById('ejudgeProblemsToggle');
  var panel = document.getElementById('ejudgeProblemsPanel');
  if (btn && panel) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = panel.classList.toggle('open');
      btn.classList.toggle('open', open);
    });
    document.addEventListener('click', function (e) {
      if (!panel.classList.contains('open')) return;
      if (panel.contains(e.target) || e.target === btn) return;
      panel.classList.remove('open');
      btn.classList.remove('open');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { panel.classList.remove('open'); btn.classList.remove('open'); }
    });
  }

  var limitsBtn = document.getElementById('ejudgeLimitsToggle');
  var limitsPanel = document.getElementById('ejudgeLimitsPanel');
  if (limitsBtn && limitsPanel) {
    limitsBtn.addEventListener('click', function () {
      var isHidden = limitsPanel.style.display === 'none';
      limitsPanel.style.display = isHidden ? '' : 'none';
      limitsBtn.classList.toggle('open', isHidden);
    });
  }
})();
</script>
`;

// Группа задач с одинаковой датой закрытия. collapsed — срок прошёл, группа
// свёрнута (раскрывается по клику на строку группы).
export interface ProblemGroup {
  // Ключ группы (по нему хранится видимость).
  key: string;
  // Название группы — название первой задачи в ней.
  name: string;
  hidden: boolean;
  collapsed: boolean;
  problems: ProblemSummary[];
}

export interface RenderPageOptions {
  contestInfo: ContestInfo;
  problems: ProblemSummary[];
  problemGroups?: ProblemGroup[];
  problem: ProblemDetail | null;
  submissions: SubmissionRow[];
  rawContentHtml?: string;
  // Скрыть ИИ-кнопки (настройка контеста).
  hideAi?: boolean;
  // Для текущей задачи уже сохранён ответ ИИ.
  aiAnswerSaved?: boolean;
  hrefBuilder(problem: ProblemSummary): string;
  formActionRewriter(action: string): string;
  clientScriptTag?: string;
}

function renderHeader(info: ContestInfo): string {
  const cells: Array<[string, string]> = [
    ['Время на сервере', info.serverTime || '—'],
    ['Время начала турнира', info.contestStartTime || '—'],
    ['Продолжительность', info.duration || '—']
  ];
  return `<div class="header">
    <div class="participant">${escapeHtml(info.participantName || '')}</div>
    <div class="info-grid">${cells.map(([label, value]) => `<div class="info-cell"><div class="info-label">${escapeHtml(label)}</div><div class="info-value">${escapeHtml(value)}</div></div>`).join('')}</div>
  </div>`;
}

function renderProblemsList(problems: ProblemSummary[], hrefBuilder: (problem: ProblemSummary) => string): string {
  if (!problems.length) return '<div class="empty" style="padding:10px 14px"></div>';
  return problems.map((problem) => {
    const status = problem.status === 'OK' ? 'ok' : problem.status === 'WA' ? 'wa' : '';
    const active = problem.status === 'CURRENT' ? ' active' : '';
    return `<a class="${status}${active}" href="${escapeHtml(hrefBuilder(problem))}"><span class="${status}">${escapeHtml(problem.id)}</span></a>`;
  }).join('');
}

const ICON_CHEVRON = `<svg class="chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`;

const ICON_EYE = `<svg class="eye-on" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><svg class="eye-off" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function renderGroupedProblems(
  groups: ProblemGroup[],
  hrefBuilder: (problem: ProblemSummary) => string,
  interactive: boolean
): string {
  return groups.map((group) => {
    if (group.problems.length === 1) return renderProblemsList(group.problems, hrefBuilder);
    // Без клиентского скрипта вернуть скрытую группу нельзя, поэтому её просто не показываем.
    if (group.hidden && !interactive) return '';
    const open = group.collapsed || group.hidden ? '' : ' open';
    const hidden = group.hidden ? ' hidden-group' : '';
    const eye = interactive
      ? `<button type="button" class="pgroup-eye" title="${group.hidden ? 'Показать группу' : 'Скрыть группу'}" aria-label="Скрыть или показать группу">${ICON_EYE}</button>`
      : '';
    return `<div class="pgroup${open}${hidden}" data-key="${escapeHtml(group.key)}"><div class="pgroup-head">${ICON_CHEVRON}<span class="pgroup-name">${escapeHtml(group.name)}</span><span class="pgroup-count">${group.problems.length}</span>${eye}</div><div class="pgroup-items">${renderProblemsList(group.problems, hrefBuilder)}</div></div>`;
  }).join('');
}

function renderProblemsToggle(
  problems: ProblemSummary[],
  hrefBuilder: (problem: ProblemSummary) => string,
  groups: ProblemGroup[] | undefined,
  interactive: boolean
): string {
  if (!problems.length) return '';
  const list = groups && groups.length ? renderGroupedProblems(groups, hrefBuilder, interactive) : renderProblemsList(problems, hrefBuilder);
  return `<div class="topbar-actions"><button id="ejudgeProblemsToggle" class="problems-toggle" title="Список задач" aria-label="Список задач">${ICON_LIST}</button>
  <div id="ejudgeProblemsPanel" class="problems-panel">${list}</div></div>`;
}

const GROUP_SCRIPT = `<script>
(function () {
  document.querySelectorAll('.pgroup-head').forEach(function (head) {
    head.addEventListener('click', function () {
      if (head.parentElement.classList.contains('hidden-group')) return;
      head.parentElement.classList.toggle('open');
    });
  });
})();
</script>`;

interface AiUi {
  // Названия языков из формы ejudge: если больше одного — клиент покажет выбор.
  languages: string[];
  saved: boolean;
}

// Одна кнопка ИИ: пока ответа нет — генерирует (✨), когда есть — открывает (💡);
// рядом с открывающей кнопкой — кнопка ✕, стирающая сохранённый ответ.
function renderAiButtons(ai: AiUi): string {
  const languages = escapeHtml(JSON.stringify(ai.languages));
  if (ai.saved) {
    return `<button type="button" id="ejudgeAiButton" class="limits-toggle ai-btn" data-saved="1" data-languages="${languages}" title="Открыть ответ ИИ" aria-label="Открыть ответ ИИ">💡</button>`
      + `<button type="button" id="ejudgeAiClear" class="limits-toggle ai-btn" title="Стереть решение ИИ" aria-label="Стереть решение ИИ">✕</button>`;
  }
  return `<button type="button" id="ejudgeAiButton" class="limits-toggle ai-btn" data-saved="0" data-languages="${languages}" title="Решить с помощью ИИ (Gemini)" aria-label="Решить с помощью ИИ">✨</button>`;
}

// Кнопка сразу после заголовка задачи — раскрывает/скрывает таблицу
// ограничений. По умолчанию (при загрузке страницы) таблица скрыта.
function renderTitleRow(problem: ProblemDetail, ai: AiUi | null): string {
  const toggle = problem.limits.length
    ? `<button id="ejudgeLimitsToggle" class="limits-toggle" title="Ограничения задачи" aria-label="Ограничения задачи">${ICON_LIMITS}</button>`
    : '';
  return `<div class="title-row"><h1 class="problem-title">${escapeHtml(problem.title)}</h1>${toggle}${ai ? renderAiButtons(ai) : ''}</div>`;
}

function renderLimits(problem: ProblemDetail): string {
  if (!problem.limits.length) return '';
  return `<div id="ejudgeLimitsPanel" class="limits" style="display:none">${problem.limits.map((limit) => `<div class="limit"><b>${escapeHtml(limit.label)}</b>${escapeHtml(limit.value)}</div>`).join('')}</div>`;
}

function renderSubmissions(rows: SubmissionRow[], formActionRewriter: (action: string) => string): string {
  if (!rows.length) return '';

  const safeHref = (href: string) => {
    try {
      return formActionRewriter(href);
    } catch {
      return href;
    }
  };

  return `<h2 class="runs-heading">Посылки</h2>
  <table class="runs-table"><thead><tr>
    <th>№</th><th>Время</th><th>Результат</th><th>Тесты</th><th>Баллы</th><th class="icon-col"></th>
  </tr></thead><tbody>${rows.map((row) => `<tr class="${row.resultClass}">
    <td>${escapeHtml(row.id)}</td>
    <td>${escapeHtml(row.time)}</td>
    <td class="result" title="${escapeHtml(row.result)}">${escapeHtml(row.resultCode || '—')}</td>
    <td>${escapeHtml(row.tests || '—')}</td>
    <td>${escapeHtml(row.score || '—')}</td>
    <td class="icon-col">${row.links.map((link) => `<a class="run-link" data-kind="${link.kind}" data-run-id="${escapeHtml(row.id)}" title="${escapeHtml(link.label)}" href="${escapeHtml(safeHref(link.href))}">${LINK_ICONS[link.kind]}</a>`).join('')}</td>
  </tr>`).join('')}</tbody></table>`;
}

// ---------- Ряд кружков со статусами задач слева от условия ----------

interface RailDot {
  problem: ProblemSummary;
  status: DotStatus;
  current: boolean;
}

interface RailSegment {
  // true для группы из нескольких задач, false для блока одиночных задач.
  isGroup: boolean;
  key: string;
  hidden: boolean;
  dots: RailDot[];
}

function dotStatus(problem: ProblemSummary): DotStatus {
  if (problem.dotStatus) return problem.dotStatus;
  if (problem.status === 'CURRENT') return 'none';
  return problem.status === 'OK' ? 'ok' : problem.status === 'WA' ? 'wa' : 'none';
}

function buildRailSegments(problems: ProblemSummary[], groups: ProblemGroup[] | undefined): RailSegment[] {
  const toDot = (problem: ProblemSummary): RailDot => ({
    problem,
    status: dotStatus(problem),
    current: problem.status === 'CURRENT'
  });
  if (!groups || !groups.length) {
    return [{ isGroup: false, key: '', hidden: false, dots: problems.map(toDot) }];
  }
  const segments: RailSegment[] = [];
  let plain: RailSegment | null = null;
  for (const group of groups) {
    if (group.problems.length === 1) {
      if (!plain) {
        plain = { isGroup: false, key: '', hidden: false, dots: [] };
        segments.push(plain);
      }
      plain.dots.push(toDot(group.problems[0]));
      continue;
    }
    plain = null;
    segments.push({ isGroup: true, key: group.key, hidden: group.hidden, dots: group.problems.map(toDot) });
  }
  return segments;
}

function renderStatusRail(
  segments: RailSegment[],
  hrefBuilder: (problem: ProblemSummary) => string,
  interactive: boolean
): string {
  // Без клиентского скрипта вернуть скрытую группу нельзя, поэтому её не рендерим
  // (кроме случая, когда в ней текущая задача).
  const shown = interactive
    ? segments
    : segments.filter((segment) => !segment.hidden || segment.dots.some((dot) => dot.current));
  if (!shown.length) return '';

  let firstVisibleDone = false;
  const parts = shown.map((segment) => {
    const hasCurrent = segment.dots.some((dot) => dot.current);
    const classes = ['rail-seg'];
    if (segment.hidden) classes.push('seg-hidden');
    if (segment.hidden && !hasCurrent) {
      classes.push('seg-empty');
    } else if (!firstVisibleDone) {
      classes.push('seg-first');
      firstVisibleDone = true;
    }
    const groupAttr = segment.isGroup ? ` data-group="${escapeHtml(segment.key)}"` : '';
    const dots = segment.dots.map((dot) => {
      const title = escapeHtml(dot.problem.name || dot.problem.id);
      const cls = `status-dot ${dot.status}${dot.current ? ' current' : ''}`;
      return `<a class="${cls}" href="${escapeHtml(hrefBuilder(dot.problem))}" title="${title}" aria-label="${title}"></a>`;
    }).join('');
    return `<div class="${classes.join(' ')}"${groupAttr}>${dots}</div>`;
  });
  return `<nav class="status-rail" aria-label="Статусы задач">${parts.join('')}</nav>`;
}

// Высота шапки нужна, чтобы ряд кружков прилипал сразу под ней.
const RAIL_SCRIPT = `<script>
(function () {
  var topbar = document.querySelector('.topbar');
  function setHeight() {
    if (topbar) document.documentElement.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
  }
  setHeight();
  window.addEventListener('resize', setHeight);
})();
</script>`;

export function renderContestPage(options: RenderPageOptions, includeClientScript: boolean): string {
  const {
    contestInfo, problems, problemGroups, problem, submissions, rawContentHtml,
    hideAi, aiAnswerSaved, hrefBuilder, formActionRewriter, clientScriptTag
  } = options;

  // ИИ-кнопки нужны только внутри webview VS Code и если они не скрыты в настройках контеста.
  const ai: AiUi | null = problem && includeClientScript && !hideAi
    ? {
        languages: problem.languages.length
          ? problem.languages.map((language) => language.name)
          : problem.fixedLanguageLabel
            ? [problem.fixedLanguageLabel]
            : [],
        saved: !!aiAnswerSaved
      }
    : null;

  const rail = problem && problems.length
    ? renderStatusRail(buildRailSegments(problems, problemGroups), hrefBuilder, includeClientScript)
    : '';

  const body = problem
    ? `${renderTitleRow(problem, ai)}${renderLimits(problem)}<article class="statement">${problem.statementHtml}</article>${renderSubmissions(submissions, formActionRewriter)}`
    : submissions.length
      ? renderSubmissions(submissions, formActionRewriter)
      : rawContentHtml
        ? `<div class="raw-content">${rawContentHtml}</div>`
        : `<div class="empty">Нет содержимого для отображения.</div>`;

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CSS}</style>
${MATHJAX_TAG}
</head>
<body>
<div class="topbar">
${renderHeader(contestInfo)}
${renderProblemsToggle(problems, hrefBuilder, problemGroups, includeClientScript)}
</div>
<div class="content-wrap">
  ${rail}
  <section class="content">${body}</section>
</div>
${DROPDOWN_SCRIPT}
${GROUP_SCRIPT}
${RAIL_SCRIPT}
${includeClientScript && clientScriptTag ? clientScriptTag : ''}
</body>
</html>`;
}
