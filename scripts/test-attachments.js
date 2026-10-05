// Проверка вложений: загрузка картинки и текста, отправка сообщения с файлами,
// плюс прямая проверка извлечения текста из PDF. Требует запущенного бэкенда.
import zlib from 'node:zlib';
import { extractText } from '../server/extract.js';

const BASE = 'http://localhost:3000/api';
const json = (r) => r.json();
const get = (p) => fetch(BASE + p).then(json);
const post = (p, body) =>
  fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json);

// --- Минимальный PNG (однотонный красный) ---
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- 1. Каталог: capabilities ---
const { models } = await get('/models');
const vision = models.filter((m) => m.capabilities?.includes('vision'));
console.log('Моделей всего:', models.length, '| с vision:', vision.length);

// --- 2. Прямая проверка извлечения текста из PDF ---
const pdf = Buffer.from(
  `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 100 Td (Secret word: banana) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>`,
);
const pdfText = extractText('doc.pdf', 'application/pdf', pdf);
console.log('PDF извлечение:', /banana/.test(pdfText) ? 'OK' : `ОШИБКА (${JSON.stringify(pdfText)})`);

// --- 2б. DOCX: собираем минимальный zip (метод 0, без сжатия) и читаем текст ---
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localRec = Buffer.concat([local, nameBuf, data]);
    locals.push(localRec);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += localRec.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const docxXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  '<w:p><w:r><w:t>Секретное слово: апельсин</w:t></w:r></w:p>' +
  '</w:body></w:document>';
const docx = buildZip([{ name: 'word/document.xml', data: docxXml }]);
const docxText = extractText('doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx);
console.log('DOCX извлечение:', /апельсин/.test(docxText) ? 'OK' : `ОШИБКА (${JSON.stringify(docxText)})`);

// --- 3. Загрузка картинки и текстового файла ---
const img = await post('/uploads', {
  name: 'red.png',
  mime: 'image/png',
  dataBase64: solidPng(64, 64, [220, 20, 20]).toString('base64'),
});
console.log('Картинка:', img.file?.kind === 'image' ? 'OK' : `ОШИБКА (${JSON.stringify(img)})`);

const txt = await post('/uploads', {
  name: 'note.txt',
  mime: 'text/plain',
  dataBase64: Buffer.from('Секретное слово: банан', 'utf8').toString('base64'),
});
console.log('Текст:', txt.file?.kind === 'text' ? 'OK' : `ОШИБКА (${JSON.stringify(txt)})`);

// --- 4. Неподдерживаемый файл должен отдать понятную ошибку ---
const bad = await post('/uploads', {
  name: 'archive.zip',
  mime: 'application/zip',
  dataBase64: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01, 0x02]).toString('base64'),
});
console.log('Неподдерживаемый:', bad.error === 'upload_failed' ? 'OK (400)' : `ОШИБКА (${JSON.stringify(bad)})`);

// --- 5. Отдать файл обратно ---
const imgRes = await fetch(`${BASE}/uploads/${img.file.id}`);
console.log('Отдача файла:', imgRes.status === 200 && imgRes.headers.get('content-type') === 'image/png' ? 'OK' : `ОШИБКА (${imgRes.status})`);

// --- 6. Сообщение с вложениями ---
const { chat } = await post('/chats', {});
const streamRes = await fetch(`${BASE}/chats/${chat.id}/messages/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    content: 'Какого цвета картинка? И какое секретное слово в файле? Ответь одной строкой.',
    attachments: [img.file.id, txt.file.id],
  }),
});
let reply = '';
let done = false;
{
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done: fin } = await reader.read();
    if (fin) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const ev = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const line = ev.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const d = JSON.parse(line.slice(5).trim());
      if (d.type === 'delta') reply += d.text;
      else if (d.type === 'done') done = true;
      else if (d.type === 'error') console.error('ОШИБКА потока:', d.message);
    }
  }
}
console.log('Ответ модели:', JSON.stringify(reply));
console.log('Увидела слово «банан»:', /банан/i.test(reply) ? 'OK' : 'ОШИБКА');
console.log('Увидела красный цвет:', /красн|red/i.test(reply) ? 'OK' : 'ОШИБКА');
console.log('Событие done:', done ? 'OK' : 'ОШИБКА');

// --- 7. Вложения сохранились в истории ---
const saved = await get(`/chats/${chat.id}`);
const first = saved.chat.messages[0];
console.log('Вложения в истории:', first.attachments?.length === 2 ? 'OK' : `ОШИБКА (${first.attachments?.length})`);

// Уборка
await fetch(`${BASE}/chats/${chat.id}`, { method: 'DELETE' });
console.log('OK');
