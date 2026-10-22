// Разбор Markdown из ответов модели: вместо сырых «звёздочек» интерфейс получает
// дерево блоков (абзацы, заголовки, списки, код, таблицы, цитаты) и «строчные»
// кусочки (жирный, курсив, зачёркнутый, код, ссылки).
//
// Здесь нет JSX — этот же файл проверяет scripts/test-markdown.js.
//
// Два правила, из которых вырос весь этот файл:
//   1. Разбор «мягкий». Ответ приходит по кусочкам, поэтому незакрытые пометки
//      остаются обычным текстом, а незакрытый блок ``` считается кодом: при
//      печати ничего не мигает и не исчезает.
//   2. Никакого HTML. Теги из ответа модели остаются текстом, а ссылкой
//      становится только http/https/mailto — ответ модели не может выполнить
//      код в браузере и не может увести на неизвестную схему.

// ---- строчный уровень ------------------------------------------------------

// \* — «экранированная» звёздочка: показываем её как есть, без выделения.
const ESCAPE_RE = /^\\([\\`*_{}[\]()#+\-.!~|>])/;
// `код` — внутри обратных кавычек ничего не разбирается.
const CODE_SPAN_RE = /^`([^`\n]+)`/;
const STRONG_RE = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/;
const EM_STAR_RE = /^\*(?=\S)([\s\S]*?\S)\*/;
// Подчёркивание выделяет только по краям слова: snake_case_name не курсив.
const EM_UNDER_RE = /^_(?=\S)([\s\S]*?\S)_(?![\w])/;
const STRIKE_RE = /^~~(?=\S)([\s\S]*?\S)~~/;
const IMAGE_RE = /^!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)/;
const LINK_RE = /^\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)/;
const URL_RE = /^https?:\/\/[^\s<>"'`]+/;

// Кириллица входит в «буквы слова»: на_пример — не курсив.
const WORD_CHAR_RE = /[0-9A-Za-z\u0410-\u044f\u0401\u0451_]/;

// Какой адрес можно сделать ссылкой. Всё остальное (javascript:, data:, file:)
// остаётся текстом: чужой ответ не должен запускать что-то по клику.
export function safeHref(href) {
  const url = String(href ?? '').trim();
  if (!url) return null;
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return url;
  if (url.startsWith('/') || url.startsWith('#')) return url;
  return null;
}

// Соседние куски текста сливаем в один — дерево получается короче и понятнее.
function pushToken(list, token) {
  const last = list[list.length - 1];
  if (token.type === 'text' && last?.type === 'text') {
    last.value += token.value;
    return;
  }
  list.push(token);
}

// Строчный разбор: **жирный**, *курсив*, `код`, ~~зачёркнуто~~, [ссылка](адрес),
// голая ссылка https://… . Незакрытая пометка остаётся текстом (см. правило 1).
export function parseInline(input) {
  const src = String(input ?? '');
  const out = [];
  let buf = '';
  let i = 0;

  const flush = () => {
    if (buf) {
      pushToken(out, { type: 'text', value: buf });
      buf = '';
    }
  };

  while (i < src.length) {
    const rest = src.slice(i);
    const prev = i > 0 ? src[i - 1] : '';
    const inWord = WORD_CHAR_RE.test(prev);
    let m;

    if ((m = ESCAPE_RE.exec(rest))) {
      buf += m[1];
      i += m[0].length;
      continue;
    }

    if ((m = CODE_SPAN_RE.exec(rest))) {
      flush();
      pushToken(out, { type: 'code', value: m[1].trim() });
      i += m[0].length;
      continue;
    }

    if ((m = IMAGE_RE.exec(rest))) {
      const href = safeHref(m[2]);
      if (href) {
        flush();
        pushToken(out, { type: 'image', href, value: m[1] });
      } else {
        buf += m[0];
      }
      i += m[0].length;
      continue;
    }

    if ((m = LINK_RE.exec(rest))) {
      const href = safeHref(m[2]);
      if (href) {
        flush();
        pushToken(out, { type: 'link', href, children: parseInline(m[1]) });
      } else {
        buf += m[0];
      }
      i += m[0].length;
      continue;
    }

    if ((m = STRIKE_RE.exec(rest))) {
      flush();
      pushToken(out, { type: 'strike', children: parseInline(m[1]) });
      i += m[0].length;
      continue;
    }

    // Порядок важен: **жирный** проверяем раньше *курсива*.
    if ((m = STRONG_RE.exec(rest)) && (m[1] === '**' || !inWord)) {
      flush();
      pushToken(out, { type: 'strong', children: parseInline(m[2]) });
      i += m[0].length;
      continue;
    }

    if ((m = EM_STAR_RE.exec(rest))) {
      flush();
      pushToken(out, { type: 'em', children: parseInline(m[1]) });
      i += m[0].length;
      continue;
    }

    if ((m = EM_UNDER_RE.exec(rest)) && !inWord) {
      flush();
      pushToken(out, { type: 'em', children: parseInline(m[1]) });
      i += m[0].length;
      continue;
    }

    if ((m = URL_RE.exec(rest))) {
      const url = trimUrlTail(m[0]);
      flush();
      pushToken(out, { type: 'link', href: url, children: [{ type: 'text', value: url }] });
      i += url.length; // знаки препинания после адреса обработает следующий шаг
      continue;
    }

    buf += src[i];
    i++;
  }

  flush();
  return out;
}

// Точку, запятую и «висячую» скобку в конце адреса оставляем текстом:
// «см. https://example.com/a).» — ссылка заканчивается на /a.
function trimUrlTail(url) {
  let out = url;
  while (/[.,;:!?'"»]$/.test(out)) out = out.slice(0, -1);
  while (out.endsWith(')') && (out.match(/\)/g) || []).length > (out.match(/\(/g) || []).length) {
    out = out.slice(0, -1);
  }
  return out;
}

// ---- блочный уровень -------------------------------------------------------

// ```js … ``` (или ~~~): код. Информация после забора — язык для подписи.
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/;
const HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.*)$/;
const HR_RE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^[ \t]{0,3}>[ \t]?(.*)$/;
const BULLET_RE = /^([ \t]*)[-*+][ \t]+(.*)$/;
const ORDERED_RE = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
// Строка-разделитель таблицы: | --- | :---: | ---: |
const DELIM_ROW_RE = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

const indentWidth = (s) => String(s).replace(/\t/g, '    ').length;

// Строка — пункт списка? Тогда сообщаем уровень отступа, вид и текст пункта.
function matchItem(line) {
  const ordered = ORDERED_RE.exec(line);
  if (ordered) {
    return { indent: indentWidth(ordered[1]), ordered: true, start: Number(ordered[2]), content: ordered[3] };
  }
  const bullet = BULLET_RE.exec(line);
  if (bullet) return { indent: indentWidth(bullet[1]), ordered: false, start: 1, content: bullet[2] };
  return null;
}

// Ячейки строки таблицы: краевые палки не считаем, \| внутри ячейки — это «|».
function splitRow(line) {
  let body = String(line).trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);

  const cells = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (body[i] === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += body[i];
  }
  cells.push(cur.trim());
  return cells;
}

// Таблица начинается там, где под шапкой идёт строка из дефисов с тем же числом
// колонок. Без проверки числа колонок обычный текст «a | b» и линия «---»
// превращались бы в таблицу из одной колонки.
function tableStart(lines, i) {
  if (i + 1 >= lines.length) return false;
  const head = lines[i];
  if (!head.includes('|')) return false;
  if (!DELIM_ROW_RE.test(lines[i + 1])) return false;
  return splitRow(head).length === splitRow(lines[i + 1]).length;
}

// С этой строки начинается новый блок — значит, абзац на ней заканчивается.
function startsBlock(lines, i) {
  const line = lines[i];
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    Boolean(matchItem(line)) ||
    tableStart(lines, i)
  );
}

// Убираем из строки отступ пункта, чтобы вложенный блок разобрался как обычно.
function dedent(line, width) {
  let i = 0;
  let left = width;
  while (i < line.length && left > 0 && (line[i] === ' ' || line[i] === '\t')) {
    left -= line[i] === '\t' ? 4 : 1;
    i++;
  }
  return line.slice(i);
}

function itemBlocks(body, indent) {
  const text = body.map((l, idx) => (idx === 0 || !l.trim() ? l : dedent(l, indent + 2))).join('\n');
  const blocks = parseMarkdown(text);
  return blocks.length ? blocks : [{ type: 'paragraph', text: '' }];
}

function parseList(lines, i, blocks) {
  const first = matchItem(lines[i]);
  const ordered = first.ordered;
  const indent = first.indent;
  const start = first.start;
  const items = [];

  while (i < lines.length) {
    const item = matchItem(lines[i]);
    // Пункт того же уровня и того же вида — продолжаем список; иначе новый блок.
    if (!item || item.indent !== indent || item.ordered !== ordered) break;

    const body = [item.content];
    i++;
    while (i < lines.length) {
      const next = matchItem(lines[i]);
      if (next && next.indent <= indent) break;
      if (next) {
        body.push(lines[i]); // вложенный список
        i++;
        continue;
      }
      if (!lines[i].trim()) {
        // Пустая строка: пункт продолжается, только если дальше идёт отступ.
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        const after = j < lines.length ? matchItem(lines[j]) : null;
        const deeper =
          j < lines.length && (after ? after.indent > indent : indentWidth(/^[ \t]*/.exec(lines[j])[0]) > indent);
        if (deeper) {
          body.push('');
          i = j;
          continue;
        }
        break;
      }
      if (indentWidth(/^[ \t]*/.exec(lines[i])[0]) > indent) {
        body.push(lines[i]);
        i++;
        continue;
      }
      break; // строка без отступа — список закончился
    }

    items.push({ blocks: itemBlocks(body, indent) });
  }

  blocks.push({ type: 'list', ordered, start, items });
  return i;
}

function parseTable(lines, i, blocks) {
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });

  i += 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    rows.push(splitRow(lines[i]));
    i++;
  }

  blocks.push({ type: 'table', align, head, rows });
  return i;
}

// Разбор ответа целиком. Типы блоков:
//   { type: 'paragraph', text }             — абзац (переносы строк внутри сохранены)
//   { type: 'heading', level, text }        — заголовок 1..6
//   { type: 'code', lang, code, closed }    — блок кода (closed: пришёл ли закрывающий забор)
//   { type: 'list', ordered, start, items } — список; items[].blocks — содержимое пункта
//   { type: 'quote', blocks }               — цитата
//   { type: 'table', align, head, rows }    — таблица
//   { type: 'hr' }                          — горизонтальная линия
export function parseMarkdown(input) {
  const src = String(input ?? '').replace(/\r\n?/g, '\n');
  if (!src.trim()) return [];

  const lines = src.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2] || '';
      const body = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        const end = FENCE_RE.exec(lines[i]);
        if (end && end[1][0] === marker && end[1].length >= fence[1].length && !end[2]) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', lang, code: body.join('\n').replace(/\n+$/, ''), closed });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        text: heading[2].replace(/[ \t]+#+[ \t]*$/, '').trim(),
      });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        inner.push(QUOTE_RE.exec(lines[i])[1]);
        i++;
      }
      blocks.push({ type: 'quote', blocks: parseMarkdown(inner.join('\n')) });
      continue;
    }

    if (matchItem(line)) {
      i = parseList(lines, i, blocks);
      continue;
    }

    if (tableStart(lines, i)) {
      i = parseTable(lines, i, blocks);
      continue;
    }

    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      paragraph.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n').trim() });
  }

  return blocks;
}