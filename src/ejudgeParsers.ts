// Единственный парсер страниц ejudge (клиентский интерфейс unpriv, ejudge 3.10-3.14).
// Достаёт из HTML данные: информацию о контесте, список задач, страницу задачи и таблицу посылок.

export type DotStatus = 'ok' | 'wa' | 'none';

export interface ContestInfo {
  participantName: string | null;
  serverTime: string;
  contestStartTime: string;
  duration: string;
}

export interface ProblemSummary {
  id: string;
  name: string;
  href: string;
  // 'CURRENT' | 'OK' | 'WA' | '' — по CSS-классу обёртки ссылки.
  dotStatus?: DotStatus;
  status: string;
}

export interface ProblemLimit {
  label: string;
  value: string;
}

export interface ProblemLanguage {
  id: string;
  name: string;
}

export interface ProblemDetail {
  title: string;
  statementHtml: string;
  limits: ProblemLimit[];
  languages: ProblemLanguage[];
  fixedLanguageLabel?: string;
  submitAction?: string;
  fileFieldName?: string;
  langFieldName?: string;
  hiddenFields: Record<string, string>;
}

export interface RunLink {
  label: string;
  href: string;
  kind: 'source' | 'report' | 'generic';
}

export interface SubmissionRow {
  id: string;
  time: string;
  result: string;
  resultCode: string;
  resultClass: string;
  tests: string;
  score: string;
  links: RunLink[];
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}
function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}
export function stripTagsPreserveLines(value: string): string {
  return decodeHtmlEntities(value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '');
}
// Снимает теги, но не трогает пробелы/переносы строк — для <pre>-блоков
// (детальный протокол по тесту), где важно сохранить форматирование как есть.
function stripTagsVerbatim(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ''));
}
function matchAll(re: RegExp, input: string): RegExpExecArray[] {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const local = new RegExp(re.source, flags);
  const out: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = local.exec(input))) out.push(match);
  return out;
}
function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}=["']([^"']*)["']`, 'i');
  const match = re.exec(tag);
  return match ? decodeHtmlEntities(match[1]) : undefined;
}
function extractElementById(html: string, id: string): string | null {
  const openRe = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
  const open = openRe.exec(html);
  if (!open || open.index === undefined) return null;
  const tag = open[1];
  const from = open.index + open[0].length;
  const tagRe = new RegExp(`<${tag}\\b[^>]*>|<\\/${tag}\\s*>`, 'gi');
  tagRe.lastIndex = from;
  let depth = 1;
  let item: RegExpExecArray | null;
  while ((item = tagRe.exec(html))) {
    if (item[0].startsWith('</')) {
      depth--;
      if (depth === 0) return html.slice(from, item.index);
    } else {
      depth++;
    }
  }
  return html.slice(from);
}
// Как extractElementById, но ищет по классу — нужно для страницы протокола
// (<div class="l14">), где нет id.
function extractElementByClass(html: string, className: string): string | null {
  const openRe = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`, 'i');
  const open = openRe.exec(html);
  if (!open || open.index === undefined) return null;
  const tag = open[1];
  const from = open.index + open[0].length;
  const tagRe = new RegExp(`<${tag}\\b[^>]*>|<\\/${tag}\\s*>`, 'gi');
  tagRe.lastIndex = from;
  let depth = 1;
  let item: RegExpExecArray | null;
  while ((item = tagRe.exec(html))) {
    if (item[0].startsWith('</')) {
      depth--;
      if (depth === 0) return html.slice(from, item.index);
    } else {
      depth++;
    }
  }
  return html.slice(from);
}
function formatReportTable(tableHtml: string): string {
  return matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i, tableHtml)
    .map((row) => matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/i, row[1]).map((cell) => stripTags(cell[1])).join('\t'))
    .join('\n');
}
// Разбирает страницу протокола (view-report): <div class="l14"> с <h2>
// статусом, сводкой в <big> и таблицей результатов по тестам. После
// таблицы иногда идёт подробный протокол по каждому тесту в <pre> (входные/
// выходные данные, ожидаемый ответ, вывод чекера) — сохраняем его почти
// как есть, без "причёсывания" пробелов, потому что там важны точные
// пустые строки между секциями теста.
export function extractReportText(html: string): string {
  const block = extractElementByClass(html, 'l14');
  if (!block) return stripTagsPreserveLines(html).trim() + '\n';
  const h2 = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
  const status = h2 ? stripTags(h2[1]) : '';
  const tableMatch = /<table\b[^>]*>[\s\S]*?<\/table>/i.exec(block);
  const beforeTable = tableMatch && tableMatch.index !== undefined ? block.slice(0, tableMatch.index) : block;
  const summarySource = h2 && h2.index !== undefined ? beforeTable.slice(h2.index + h2[0].length) : beforeTable;
  const summary = stripTagsPreserveLines(summarySource).trim();
  const tableText = tableMatch ? formatReportTable(tableMatch[0]) : '';
  const afterTable = tableMatch && tableMatch.index !== undefined
    ? block.slice(tableMatch.index + tableMatch[0].length)
    : '';
  const detailsText = matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i, afterTable)
    .map((m) => stripTagsVerbatim(m[1]))
    .join('\n\n')
    .trim();
  return [status, summary, tableText, detailsText].filter(Boolean).join('\n\n').trim() + '\n';
}
function parseStatusBeforeLink(prefix: string): string {
  const wrap = /<div\b[^>]*\bclass=["']([^"']*)["'][^>]*>\s*$/i.exec(prefix);
  const cls = wrap?.[1] || '';
  if (/probcurrent/i.test(cls)) return 'CURRENT';
  if (/probok/i.test(cls)) return 'OK';
  if (/probbad|probrej/i.test(cls)) return 'WA';
  return '';
}
function parseTableRows(tableHtml: string): ProblemLimit[] {
  const rows = [];
  for (const row of matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i, tableHtml)) {
    const cells = matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/i, row[1]).map((cell) => stripTags(cell[1]));
    if (cells.length >= 2 && cells[0]) rows.push({ label: cells[0], value: cells[1] });
  }
  return rows;
}
function isServerTimeLabel(label: string): boolean {
  return /server\s*time|время\s*(на\s*)?сервере/i.test(label);
}
function isContestStartLabel(label: string): boolean {
  return /contest\s*start|время\s*начала|начала\s*турнира/i.test(label);
}
function isDurationLabel(label: string): boolean {
  return /duration|продолжительность/i.test(label);
}
function normalizeDuration(value: string): string {
  if (/^unlimited$/i.test(value)) return 'Не ограничена';
  return value;
}
const VERDICT_TEXT_TO_CODE: Record<string, string> = {
  'ok': 'OK',
  'ошибка компиляции': 'CE',
  'ошибка при работе программы': 'RT',
  'ошибка превышения лимита времени': 'TL',
  'ошибка неправильного формата результата': 'PE',
  'неправильный ответ': 'WA',
  'внутренняя ошибка проверки': 'CF',
  'частичное решение': 'PT',
  'неполное решение': 'PT',
  'принято на проверку': 'AC',
  'решение проигнорировано': 'IG',
  'решение дисквалифицировано': 'DQ',
  'ожидает проверки': 'PD',
  'ошибка превышения лимита памяти': 'ML',
  'ошибка нарушения ограничений безопасности': 'SE',
  'ошибка нарушения стиля оформления исходного кода': 'SV',
  'нарушение правил оформления программ': 'SV',
  'ошибка превышения лимита реального времени': 'WT',
  'ожидает подтверждения': 'PR',
  'отклонено': 'RJ',
  'пропущено': 'SK',
  'ошибка синхронизации': 'SY',
  'вызван на защиту': 'SM',
  'ожидает полной перепроверки': 'FR',
  'в очереди проверки или проверяется': 'RU',
  'решение скомпилировано, но еще не отправлено на проверку': 'CD',
  'в очереди компиляции или компилируется': 'CG',
  'доступно для тестирования': 'AV',
  'решение отправлено на перепроверку': 'RJ',
  'пустая запись. при удалении решения': 'EM',
  'начало виртуального соревнования для пользователя. служебная метка, не является записью о решении': 'VS',
  'конец виртуального соревнования для пользователя. служебная метка, не является записью о решении': 'VT'
};
const OK_CODES = new Set(['OK', 'AC']);
const PENDING_CODES = new Set(['PD', 'PR', 'RU', 'CD', 'CG', 'AV', 'FR']);
function normalizeVerdictText(text: string): string {
  return text.trim().replace(/\.+$/, '').toLowerCase();
}
function verdictCode(result: string): string {
  return VERDICT_TEXT_TO_CODE[normalizeVerdictText(result)] || result;
}
function classifyResult(result: string): string {
  const code = verdictCode(result);
  if (OK_CODES.has(code)) return 'ok';
  if (PENDING_CODES.has(code)) return 'pending';
  return code === result ? '' : 'bad';
}
// Ссылки "исходник"/"протокол" различаются по характерному пути в href
// (см. csp/contests/unpriv_source_page.csp и unpriv_report_page.csp —
// новый REST-стиль /ej/client/view-source|view-report/...). Если ссылка
// не подходит ни под один шаблон (например, старый числовой action=NN на
// ejudge 3.10.x) — помечаем как generic и открываем тем же способом, что и
// исходник (безопасный универсальный разбор текста на прокси).
function classifyRunLink(href: string): RunLink {
  if (/view-source/i.test(href)) return { label: 'Исходник', href, kind: 'source' };
  if (/view-report/i.test(href)) return { label: 'Протокол', href, kind: 'report' };
  return { label: 'Просмотр', href, kind: 'generic' };
}
const RUN_ID_HREF_RE = /run_id=(\d+)/i;
const RUN_LINK_RE = /<a\b[^>]*href=["']([^"']*run_id=\d+[^"']*)["'][^>]*>/i;
const MAIN_PHRASE_RE = /<div\b[^>]*class=["'][^"']*\bmain_phrase\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
const LIMITS_TABLE_RE = /<table\b[^>]*class=["'][^"']*\bline-table-wb\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i;
const SUBMIT_TABS_RE = /<div\b[^>]*id=["']ej-submit-tabs["'][^>]*>/i;
const PROBLEM_H3_RE = /<h3\b[^>]*>\s*(Задача[\s\S]*?)<\/h3>/i;
const FORM_RE = /<form\b([^>]*)>([\s\S]*?)<\/form>/i;
export const EJUDGE_PARSER = {
  // Признаки клиентского интерфейса ejudge unpriv (3.10–3.14).
  detect(html: string): boolean {
    return /\bid=["'](?:probNavTopList|probNavRightList)["']/i.test(html) ||
      /\bclass=["'][^"']*\bmain_phrase\b/i.test(html);
  },
  parseContestInfo(html: string): ContestInfo {
    const phrase = MAIN_PHRASE_RE.exec(html);
    let participantName: string | null = null;
    if (phrase) {
      const full = stripTags(phrase[1]);
      const lastColon = full.lastIndexOf(':');
      participantName = (lastColon >= 0 ? full.slice(0, lastColon) : full).trim() || null;
    }
    let serverTime = '';
    let contestStartTime = '';
    let duration = '';
    for (const table of matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/i, html)) {
      const rows = parseTableRows(table[1]);
      for (const row of rows) {
        if (!serverTime && isServerTimeLabel(row.label)) serverTime = row.value;
        if (!contestStartTime && isContestStartLabel(row.label)) contestStartTime = row.value;
        if (!duration && isDurationLabel(row.label)) duration = normalizeDuration(row.value);
      }
      if (serverTime || contestStartTime || duration) break;
    }
    return { participantName, serverTime, contestStartTime, duration };
  },
  parseProblemList(html: string): ProblemSummary[] {
    const navHtml = extractElementById(html, 'probNavTopList') ?? extractElementById(html, 'probNavRightList');
    if (!navHtml) return [];
    const result: ProblemSummary[] = [];
    const seenProblemIds = new Set<string>();
    for (const link of matchAll(/<a\b[^>]*\bclass=["'][^"']*\btab\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i, navHtml)) {
      const whole = link[0];
      const href = attr(whole, 'href');
      if (!href || !/[?&]prob_id=\d+/i.test(href)) continue;
      const problemId = /[?&]prob_id=(\d+)/i.exec(href)?.[1];
      if (!problemId || seenProblemIds.has(problemId)) continue;
      seenProblemIds.add(problemId);
      const linkIndex = link.index ?? navHtml.indexOf(whole);
      const before = linkIndex >= 0 ? navHtml.slice(Math.max(0, linkIndex - 120), linkIndex) : '';
      const title = stripTags(link[1]);
      result.push({
        id: title || `#${problemId}`,
        name: title || `Задача ${problemId}`,
        href,
        status: parseStatusBeforeLink(before)
      });
    }
    return result;
  },
  parseProblem(html: string): ProblemDetail | null {
    const limitsMatch = LIMITS_TABLE_RE.exec(html);
    const submitTabs = SUBMIT_TABS_RE.exec(html);
    const h3Title = PROBLEM_H3_RE.exec(html);
    if (!limitsMatch && !submitTabs && !h3Title) return null;
    const limits = limitsMatch ? parseTableRows(limitsMatch[1]) : [];
    let form: RegExpExecArray | null = null;
    if (submitTabs?.index !== undefined) {
      form = FORM_RE.exec(html.slice(submitTabs.index));
    }
    if (!form) {
      form = matchAll(FORM_RE, html).find((f) => /<input\b[^>]*\btype=["']file["']/i.test(f[2])) || null;
    }
    const statementStart = limitsMatch && limitsMatch.index !== undefined
      ? limitsMatch.index + limitsMatch[0].length
      : (h3Title && h3Title.index !== undefined ? h3Title.index : 0);
    const statementEnd = submitTabs?.index !== undefined ? submitTabs.index : (form?.index ?? html.length);
    const statementHtml = html.slice(statementStart, statementEnd).trim();
    const h2Title = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(html);
    const title = h3Title ? stripTags(h3Title[1]) : h2Title ? stripTags(h2Title[1]) : 'Задача';
    if (!form) {
      return { title, statementHtml, limits, languages: [], hiddenFields: {} };
    }
    const formAttrs = form[1];
    const formBody = form[2];
    const hiddenFields: Record<string, string> = {};
    for (const input of matchAll(/<input\b[^>]*\btype=["']hidden["'][^>]*>/i, formBody)) {
      const name = attr(input[0], 'name');
      if (name) hiddenFields[name] = attr(input[0], 'value') || '';
    }
    for (const input of matchAll(/<input\b[^>]*\btype=["']submit["'][^>]*>/i, formBody)) {
      const name = attr(input[0], 'name');
      if (name && !(name in hiddenFields)) hiddenFields[name] = attr(input[0], 'value') || '';
    }
    const action = attr(`<form${formAttrs}>`, 'action');
    const fileInput = /<input\b[^>]*\btype=["']file["'][^>]*>/i.exec(formBody)?.[0];
    const fileFieldName = fileInput ? attr(fileInput, 'name') || 'file' : undefined;
    const select = /<select\b[^>]*\bname=["']([^"']*lang[^"']*)["'][^>]*>([\s\S]*?)<\/select>/i.exec(formBody);
    const languages: ProblemLanguage[] = [];
    let langFieldName: string | undefined;
    if (select) {
      langFieldName = select[1];
      for (const option of matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/i, select[2])) {
        const optionValue = attr(option[0], 'value') || '';
        const optionText = stripTags(option[1]);
        if (optionText) languages.push({ id: optionValue, name: optionText });
      }
      delete hiddenFields[langFieldName];
    }
    const fixedLanguage = /(?:Язык|Language):<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(formBody);
    return {
      title,
      statementHtml,
      limits,
      languages,
      fixedLanguageLabel: !select && fixedLanguage ? stripTags(fixedLanguage[1]) : undefined,
      submitAction: action,
      fileFieldName,
      langFieldName,
      hiddenFields
    };
  },
  // Раньше искали ОДНУ конкретную таблицу по тексту заголовка "Номер
  // решения" — на другом сервере (ejudge 3.10.x) заголовки таблицы вообще
  // без текста (иконки), и таблица никогда не находилась. Теперь ищем
  // напрямую строки <tr>, где есть ссылка с run_id=, независимо от того,
  // в какой конкретно таблице и с какими заголовками они лежат. Дальше два
  // режима разбора: точный — для "богатого" формата (10+ колонок: id,
  // время, размер, задача, язык, результат, тесты, баллы, 2 ссылки), и
  // щадящий эвристический — для урезанного формата, где вердикт кодируется
  // цветом фона строки (#ddffdd = RUN_OK, см. lib/new_server_html_2.c
  // в исходниках ejudge), а не текстом.
  parseSubmissions(html: string): SubmissionRow[] {
    const rows: SubmissionRow[] = [];
    const seenIds = new Set<string>();
    for (const rowMatch of matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i, html)) {
      const rowHtml = rowMatch[0];
      const rowInner = rowMatch[1];
      const runLinks = matchAll(RUN_LINK_RE, rowInner);
      if (!runLinks.length) continue;
      const cellTexts = matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/i, rowInner).map((c) => stripTags(c[1]));
      const id = RUN_ID_HREF_RE.exec(runLinks[0][1])?.[1] || cellTexts.find((c) => /^\d+$/.test(c)) || '';
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      const links = runLinks.map((l) => classifyRunLink(l[1]));
      if (cellTexts.length >= 10) {
        // Точный разбор "богатого" формата (см. пример с unicorn.ejudge.ru).
        const result = cellTexts[5] || '';
        rows.push({
          id: cellTexts[0] || id,
          time: cellTexts[1] || '',
          result,
          resultCode: verdictCode(result),
          resultClass: classifyResult(result),
          tests: cellTexts[6] || '',
          score: cellTexts[7] || '',
          links
        });
        continue;
      }
      // Щадящий разбор урезанного формата.
      const time = cellTexts.find((c) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(c)) || '';
      let result = cellTexts.find((c) => c in VERDICT_TEXT_TO_CODE || VERDICT_TEXT_TO_CODE[normalizeVerdictText(c)]) || '';
      let resultClass = result ? classifyResult(result) : '';
      if (!result) {
        const bg = /bgcolor=["']?#?([0-9a-f]{6})/i.exec(rowHtml)?.[1]?.toLowerCase();
        if (bg === 'ddffdd') {
          resultClass = 'ok';
          result = 'OK';
        } else if (bg) {
          resultClass = 'bad';
        }
      }
      const usedTexts = new Set<string>([id, time, result]);
      const score = cellTexts.find((c) => /^\d+(\s*\(\d+\))?$/.test(c) && !usedTexts.has(c)) || '';
      rows.push({
        id,
        time,
        result,
        resultCode: result ? verdictCode(result) : '',
        resultClass,
        tests: '',
        score,
        links
      });
    }
    return rows;
  }
};

export function isEjudgePage(html: string): boolean {
  return EJUDGE_PARSER.detect(html);
}
