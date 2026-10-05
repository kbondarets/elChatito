// Разбор загруженных файлов в то, что умеет apimira: картинки — как есть,
// документы — как текст. Тип "file" в chat/completions apimira не поддерживает,
// поэтому PDF/DOCX мы распаковываем сами (только zlib из стандартной библиотеки).
import zlib from 'node:zlib';

// Расширения, которые считаем текстом (даже если mime не пришёл).
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'yml', 'yaml', 'toml',
  'ini', 'cfg', 'conf', 'properties', 'log', 'env', 'sql', 'svg',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'css', 'scss', 'sass', 'less',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'swift', 'lua',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'dockerfile', 'makefile', 'gradle', 'r', 'pl', 'dart',
]);

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);

// Слишком длинный текст в промпт не льём — обрежем (модель и так не съест больше контекста).
const MAX_TEXT_CHARS = 200_000;

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

// Определяем, что за файл: image | pdf | docx | text | unsupported.
export function classify(name, mime, buffer) {
  const ext = extOf(name);
  const m = String(mime || '').toLowerCase();

  // SVG — это XML-текст, а не растровая картинка: модели его не «увидят».
  if (ext === 'svg' || m === 'image/svg+xml') return 'text';

  if (m.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (ext === 'docx' || m.includes('wordprocessingml.document')) return 'docx';

  if (m.startsWith('text/') || TEXT_EXT.has(ext) || m === 'application/json' || /(xml|json|yaml|csv)/.test(m)) {
    return 'text';
  }
  // Незнакомое расширение — попробуем угадать по содержимому.
  if (buffer && looksLikeText(buffer)) return 'text';
  return 'unsupported';
}

// Извлекаем содержимое как текст (для pdf/docx/text). Для картинок не используется.
export function extractText(name, mime, buffer) {
  const kind = classify(name, mime, buffer);
  if (kind === 'pdf') return limit(extractPdfText(buffer));
  if (kind === 'docx') return limit(extractDocxText(buffer));
  return limit(buffer.toString('utf8'));
}

// ----- Внутреннее -----

function limit(text) {
  const clean = String(text || '').replace(/\u0000/g, '').trim();
  if (clean.length <= MAX_TEXT_CHARS) return clean;
  return `${clean.slice(0, MAX_TEXT_CHARS)}\n\n[... текст обрезан: файл слишком большой ...]`;
}

// Эвристика «это текст»: нет нулевых байтов и почти всё — печатные символы.
function looksLikeText(buffer) {
  const n = Math.min(buffer.length, 4096);
  if (n === 0) return false;
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const b = buffer[i];
    if (b === 0) return false;
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127)) printable++;
  }
  return printable / n > 0.9;
}


// ----- PDF -----
// Best-effort: распаковываем потоки (FlateDecode) и вытаскиваем текст из
// операторов Tj/TJ. Не понимает Type0/CID-шрифты (часть PDF с нелатиницей).

function extractPdfText(buffer) {
  const raw = buffer.toString('latin1');
  const parts = [];
  const re = /stream\r?\n?([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(raw))) {
    let bytes = Buffer.from(m[1], 'latin1');
    // Отрезаем перевод строки перед endstream.
    while (bytes.length && (bytes[bytes.length - 1] === 10 || bytes[bytes.length - 1] === 13)) {
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    let content = null;
    try {
      content = zlib.inflateSync(bytes).toString('latin1');
    } catch {
      try {
        content = zlib.inflateRawSync(bytes).toString('latin1');
      } catch {
        content = bytes.toString('latin1');
      }
    }
    if (/\)\s*Tj|\]\s*TJ/.test(content)) parts.push(decodePdfText(content));
  }
  return parts.filter(Boolean).join('\n').trim();
}

function decodePdfText(content) {
  let out = '';
  const token = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|Tj|TJ|Td|TD|T\*|ET|'|"/g;
  let m;
  while ((m = token.exec(content))) {
    const t = m[0];
    if (t.startsWith('(')) out += unescapePdf(t.slice(1, -1));
    else if (t.startsWith('<')) out += hexToString(t.slice(1, -1));
    else if (t === 'Td' || t === 'TD' || t === 'T*' || t === "'" || t === '"') out += ' ';
    else if (t === 'ET') out += '\n';
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

function unescapePdf(s) {
  return s.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_, g) => {
    switch (g) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case '(': return '(';
      case ')': return ')';
      case '\\': return '\\';
      default: return String.fromCharCode(parseInt(g, 8));
    }
  });
}

function hexToString(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}


// ----- DOCX -----
// DOCX — это zip, внутри word/document.xml с текстом. Читаем один файл из архива.

function extractDocxText(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml');
  if (!xml) return '';
  return xmlToText(xml);
}

// Минимальный читатель zip: находим центральный каталог и нужную запись.
function readZipEntry(buf, wanted) {
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const entryName = buf.toString('utf8', off + 46, off + 46 + nameLen);

    if (entryName === wanted) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
      return null;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function xmlToText(xml) {
  let s = xml;
  s = s.replace(/<w:tab\b[^>]*\/?>/g, '\t');
  s = s.replace(/<w:br\b[^>]*\/?>/g, '\n');
  s = s.replace(/<\/w:p>/g, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeXmlEntities(s);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeXmlEntities(s) {
  return s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
