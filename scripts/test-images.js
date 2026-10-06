// Проверка работы с картинками: тип по байтам, лимиты, сборка сообщений и —
// главное — форма запросов к apimira (multipart + Content-Length), которую
// проверяем на локальном «моке» apimira, не тратя деньги.
//
// Платные проверки (реальная генерация и правка) включаются флагом:
//   RUN_PAID=1 node scripts/test-images.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Ключ подставляем до импорта apimira.js — он читает его при загрузке.
process.env.apimira_api_key = process.env.apimira_api_key || 'am-test';

// --- Минимальные картинки (для детектора достаточно «магических» байтов) ---
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

const PNG = solidPng(32, 32, [30, 120, 220]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.alloc(24),
]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(20)]);

// --- Мок apimira: принимает /v1/images/*, запоминает форму запроса ---
const seen = { generate: null, edit: null };
function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const parts = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', () => {
        const body = Buffer.concat(parts);
        const json = (obj) => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': 'req-test-1' });
          res.end(JSON.stringify(obj));
        };
        if (req.url === '/v1/images/generations') {
          seen.generate = { body: body.toString('utf8') };
          // Спец-промпт, на котором мок отвечает ошибкой шлюза.
          if (seen.generate.body.includes('ERRTEST')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: { message: 'The model does not support images.', code: 'unsupported_capability' },
              }),
            );
            return;
          }
          json({ created: 1, data: [{ b64_json: PNG.toString('base64') }] });
        } else if (req.url === '/v1/images/edits') {
          seen.edit = {
            contentLength: req.headers['content-length'],
            actualLength: body.length,
            contentType: req.headers['content-type'],
            body,
          };
          json({ created: 1, data: [{ b64_json: PNG.toString('base64') }] });
        } else {
          res.writeHead(404).end('{}');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  OK   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

// 1. Определение типа по байтам (а не по имени)
const { detectImageMime, classify } = await import('../server/extract.js');
console.log('Определение типа картинки:');
ok('PNG → image/png', detectImageMime(PNG) === 'image/png');
ok('JPEG → image/jpeg', detectImageMime(JPEG) === 'image/jpeg');
ok('WebP → image/webp', detectImageMime(WEBP) === 'image/webp');
ok('GIF → null (не поддерживается)', detectImageMime(GIF) === null);
ok('GIF классифицируется как image_unsupported', classify('a.gif', 'image/gif', GIF) === 'image_unsupported');
ok('PNG классифицируется как image', classify('a.png', 'image/png', PNG) === 'image');
ok(
  '«png» с чужими байтами не считается картинкой',
  classify('a.png', 'image/png', Buffer.from('nope nope nope nope')) === 'image_unsupported',
);

// 2. Сохранение: лимит 5 МБ для картинок, mime из байтов
const uploads = await import('../server/uploads.js');
console.log('Сохранение картинок:');
const saved = uploads.saveBuffer({ name: 'cat.png', mime: 'image/png', buffer: PNG });
ok('mime взят из содержимого', saved.mime === 'image/png');
ok('kind = image', saved.kind === 'image');
const bigPng = Buffer.concat([PNG, Buffer.alloc(uploads.MAX_IMAGE_BYTES + 1)]);
let bigErr = '';
try {
  uploads.saveBuffer({ name: 'big.png', mime: 'image/png', buffer: bigPng });
} catch (e) {
  bigErr = e.message;
}
ok('картинка больше 5 МБ отклоняется', /5 МБ/.test(bigErr), `(${bigErr})`);
let gifErr = '';
try {
  uploads.saveBuffer({ name: 'anim.gif', mime: 'image/gif', buffer: GIF });
} catch (e) {
  gifErr = e.message;
}
ok('GIF отклоняется с понятным текстом', /PNG, JPEG или WebP/.test(gifErr), `(${gifErr})`);

// 3. Сборка сообщения для apimira: image_url + detail
const { toUpstreamMessages } = await import('../server/messages.js');
console.log('Сборка сообщения:');
const msgs = toUpstreamMessages([
  {
    role: 'user',
    content: 'что тут?',
    attachments: [{ id: saved.id, name: 'cat.png', kind: 'image', detail: 'high' }],
  },
]);
const part = msgs[0]?.content?.[1];
ok('часть имеет тип image_url', part?.type === 'image_url');
ok('url — data URL с image/png', part?.image_url?.url?.startsWith('data:image/png;base64,'));
ok('detail пробрасывается', part?.image_url?.detail === 'high');


// 4. Форма запросов к apimira (мок, без денег)
const mock = await startMock();
process.env.apimira_base_url = `http://127.0.0.1:${mock.address().port}/v1`;
const { generateImage, editImage } = await import('../server/apimira.js');

console.log('Запрос генерации (мок):');
const gen = await generateImage({ model: 'openai/gpt-image-2', prompt: 'рыжий кот', n: 1 });
ok('вернулась картинка в base64', gen.images.length === 1 && gen.images[0] === PNG.toString('base64'));
ok('x-request-id прочитан', gen.requestId === 'req-test-1');
ok(
  'тело запроса — JSON с model и prompt',
  /"model":"openai\/gpt-image-2"/.test(seen.generate.body) && /"prompt":"рыжий кот"/.test(seen.generate.body),
);

console.log('Запрос правки (мок):');
const edit = await editImage({
  model: 'openai/gpt-image-2',
  prompt: 'сделай фон светлым',
  images: [{ buffer: PNG, mime: 'image/png', name: 'cat.png' }],
  n: 1,
  size: '1024x1024',
});
ok('вернулась картинка в base64', edit.images.length === 1 && edit.images[0] === PNG.toString('base64'));
ok(
  'Content-Length выставлен',
  seen.edit.contentLength === String(seen.edit.actualLength),
  `(${seen.edit.contentLength} vs ${seen.edit.actualLength})`,
);
ok('Content-Type — multipart/form-data', /^multipart\/form-data; boundary=/.test(seen.edit.contentType || ''));
const text = seen.edit.body.toString('utf8');
ok('есть поле model', text.includes('name="model"') && text.includes('openai/gpt-image-2'));
ok('есть поле prompt', text.includes('name="prompt"') && text.includes('сделай фон светлым'));
ok('есть поле image (файл)', text.includes('name="image"') && text.includes('filename="cat.png"'));
ok('есть поле size', text.includes('name="size"') && text.includes('1024x1024'));
ok('байты картинки внутри тела', seen.edit.body.includes(PNG));
ok('тело корректно закрыто', text.trimEnd().endsWith('--'));

// 4б. Несколько картинок → поле image[]
seen.edit = null;
await editImage({
  model: 'openai/gpt-image-2',
  prompt: 'объедини',
  images: [
    { buffer: PNG, mime: 'image/png', name: 'a.png' },
    { buffer: JPEG, mime: 'image/jpeg', name: 'b.jpg' },
  ],
  n: 1,
  size: 'auto',
});
const multi = seen.edit.body.toString('latin1');
ok('несколько картинок шлются как image[]', (multi.match(/name="image\[\]"/g) || []).length === 2);
ok('size=auto не отправляем (значение по умолчанию)', !multi.includes('name="size"'));

// 4в. Ошибка шлюза превращается в понятный текст (тот же мок, промпт ERRTEST)
let apiErr = '';
try {
  await generateImage({ model: 'openai/gpt-image-2', prompt: 'ERRTEST' });
} catch (e) {
  apiErr = e.message;
}
ok('ошибка шлюза содержит код', /unsupported_capability/.test(apiErr), `(${apiErr})`);
mock.close();

// 5. Платные проверки — только по флагу (реально тратят деньги на балансе ключа).
if (process.env.RUN_PAID === '1') {
  const API = process.env.API_BASE || 'http://localhost:3000/api';
  const req = async (method, url, body) => {
    const r = await fetch(API + url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      // оставим {}
    }
    return { status: r.status, data };
  };

  console.log('\nПлатные проверки (нужен запущенный сервер и баланс на ключе):');
  const { data: created } = await req('POST', '/chats', {});
  const chatId = created?.chat?.id;
  if (!chatId) {
    ok('создан чат для платной проверки', false, '(запущен ли сервер?)');
  } else {
    const gen = await req('POST', '/images/generations', {
      chatId,
      model: process.env.PAID_IMAGE_MODEL || 'openai/gpt-image-2.5-sunburst',
      prompt: 'рыжий кот в очках, минимализм',
      n: 1,
    });
    const last = gen.data?.chat?.messages?.at(-1);
    ok('генерация вернула картинку', gen.status === 200 && last?.attachments?.[0]?.kind === 'image',
      `(${gen.status} ${gen.data?.message || ''})`);

    if (last?.attachments?.[0]) {
      const edit = await req('POST', '/images/edits', {
        chatId,
        model: process.env.PAID_EDIT_MODEL || 'openai/gpt-image-2',
        prompt: 'Сделай фон светло-серым градиентом',
        attachments: [last.attachments[0].id],
        n: 1,
        size: 'auto',
      });
      const edited = edit.data?.chat?.messages?.at(-1);
      ok('правка вернула картинку', edit.status === 200 && edited?.attachments?.[0]?.kind === 'image',
        `(${edit.status} ${edit.data?.message || ''})`);
    }
    await req('DELETE', `/chats/${chatId}`);
  }
} else {
  console.log('Платные проверки пропущены (включить: RUN_PAID=1).');
}

// Уборка: удаляем сохранённый в тесте файл.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, '..', 'data', 'uploads');
for (const f of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
  if (f.startsWith(saved.id)) fs.rmSync(path.join(DIR, f), { force: true });
}

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
