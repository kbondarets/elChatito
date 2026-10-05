// Сквозная проверка: создать чат, отправить сообщение, получить ответ.
// Требует запущенного бэкенда на http://localhost:3000
const BASE = 'http://localhost:3000/api';
const post = (p, body) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const patch = (p, body) =>
  fetch(BASE + p, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const del = (p) => fetch(BASE + p, { method: 'DELETE' }).then((r) => r.json());
const get = (p) => fetch(BASE + p).then((r) => r.json());

const { models, defaultModel } = await get('/models');
console.log('Моделей в списке:', models.length, '| первая:', models[0]?.name, '| тип:', models[0]?.type);

const { chat } = await post('/chats', {});
console.log('Создан чат:', chat.id, '| модель по умолчанию задана:', Boolean(chat.model));

const res = await post(`/chats/${chat.id}/messages`, { content: 'Ответь одним словом: привет' });
if (res.error) {
  console.error('ОШИБКА:', res.message);
  process.exit(1);
}

const roles = res.chat.messages.map((m) => `${m.role}(${m.content.length})`);
console.log('Сообщения в чате:', roles.join(', '));
console.log('Заголовок чата длина:', res.chat.title.length);

// --- Потоковый ответ (SSE) ---
const streamRes = await fetch(`${BASE}/chats/${chat.id}/messages/stream`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: 'Считай от 1 до 5 через запятую' }),
});
console.log('Поток: статус', streamRes.status, '| content-type:', streamRes.headers.get('content-type'));
let streamed = '';
let deltas = 0;
let gotDone = false;
{
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const event = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const line = event.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const d = JSON.parse(line.slice(5).trim());
      if (d.type === 'delta') {
        streamed += d.text;
        deltas += 1;
      } else if (d.type === 'done') {
        gotDone = true;
      } else if (d.type === 'error') {
        console.error('ОШИБКА потока:', d.message);
      }
    }
  }
}
console.log('Поток: кусочков =', deltas, '| символов =', streamed.length, '| done =', gotDone);
const streamedChat = await get(`/chats/${chat.id}`);
console.log('Ответ сохранён в чат:', streamedChat.chat.messages.length === 4 ? 'OK' : `ОШИБКА (${streamedChat.chat.messages.length})`);

// --- Переименование ---
const NEW_TITLE = 'Переименованный чат';
const renamed = await patch(`/chats/${chat.id}`, { title: NEW_TITLE });
console.log('Переименование:', renamed.chat.title === NEW_TITLE ? 'OK' : `ОШИБКА (${renamed.chat.title})`);

// --- Удаление ---
await del(`/chats/${chat.id}`);
const afterDelete = await get(`/chats/${chat.id}`);
console.log('Удаление:', afterDelete.error === 'chat_not_found' ? 'OK' : `ОШИБКА (${JSON.stringify(afterDelete)})`);

// --- Удаление несуществующего чата ---
const delMissing = await del(`/chats/${chat.id}`);
console.log('Повторное удаление:', delMissing.error === 'chat_not_found' ? 'OK (404)' : 'ОШИБКА');

console.log('OK');
