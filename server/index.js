import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getCatalog, refreshCatalog } from './catalog.js';
import { chatComplete, chatCompleteStream, generateImage, editImage } from './apimira.js';
import { toUpstreamMessages } from './messages.js';
import { detectImageMime } from './extract.js';
import * as uploads from './uploads.js';
import * as store from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;

const app = express();
// Файлы приходят как base64 в JSON, поэтому лимит поднят (см. MAX_UPLOAD_BYTES).
app.use(express.json({ limit: '32mb' }));

// Принимаем список id вложений и отдаём их метаданные (что реально сохранилось).
function resolveAttachments(input) {
  if (!Array.isArray(input)) return [];
  return input.map((id) => uploads.readUpload(id)?.meta).filter(Boolean);
}

// ----- API -----

// Список моделей: тянем из apimira (GET /v1/models + /v1/account/pricing).
// Кэшируется в памяти при запуске сервера (см. server/catalog.js).
app.get('/api/models', async (req, res) => {
  let catalog = getCatalog();
  if (!catalog.models.length) catalog = await refreshCatalog();
  res.json(catalog);
});

// Список чатов (без сообщений).
app.get('/api/chats', (req, res) => {
  res.json({ chats: store.listChats() });
});

// ----- Файлы -----

// Загрузить файл (base64 в JSON) — отдаём метаданные для вложения.
app.post('/api/uploads', (req, res) => {
  try {
    const meta = uploads.saveUpload({
      name: req.body?.name,
      mime: req.body?.mime,
      dataBase64: req.body?.dataBase64,
    });
    res.status(201).json({ file: meta });
  } catch (err) {
    res.status(400).json({ error: 'upload_failed', message: err.message });
  }
});

// Отдать файл обратно (например, чтобы показать картинку в переписке).
app.get('/api/uploads/:id', (req, res) => {
  const file = uploads.readUpload(req.params.id);
  if (!file) return res.status(404).json({ error: 'file_not_found', message: 'Файл не найден.' });
  res.setHeader('Content-Type', file.meta.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.meta.name)}`);
  res.send(file.buffer);
});

// ----- Картинки -----

// Промпт у генерации и правки — до 15 000 символов (требование apimira).
const MAX_PROMPT_CHARS = 15_000;
// Сколько кадров просим за раз (у правки документация допускает 1…4).
const MAX_IMAGE_COUNT = 4;

// Достаём вложения-картинки по id: возвращаем { buffer, mime, name } для отправки.
function loadImageAttachments(ids) {
  const list = Array.isArray(ids) ? ids : [];
  return list.map((id) => {
    const file = uploads.readUpload(id);
    if (!file) throw new Error('Картинка не найдена — загрузите её ещё раз.');
    if (file.meta.kind !== 'image') throw new Error(`«${file.meta.name}» — не картинка.`);
    return { buffer: file.buffer, mime: file.meta.mime, name: file.meta.name };
  });
}

// Кладём пришедшие от модели кадры (base64) в хранилище и получаем их метаданные.
function saveGeneratedImages(b64List, prefix) {
  return b64List.map((b64, i) => {
    const buffer = Buffer.from(b64, 'base64');
    // Формат кадра выбирает модель (PNG или JPEG) — определяем по байтам.
    const mime = detectImageMime(buffer) || 'image/png';
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    return uploads.saveBuffer({
      name: `${prefix}-${i + 1}.${ext}`,
      mime,
      buffer,
      // Кадр уже оплачен — храним его даже если он больше 5 МБ (лимита на вход).
      maxBytes: uploads.MAX_UPLOAD_BYTES,
    });
  });
}

// Генерация картинок: POST /v1/images/generations через наш сервер.
app.post('/api/images/generations', async (req, res) => {
  const chat = store.getChat(req.body?.chatId);
  if (!chat) return res.status(404).json({ error: 'chat_not_found', message: 'Чат не найден.' });

  const model = String(req.body?.model || '').trim();
  const prompt = String(req.body?.prompt ?? '').trim();
  const n = Math.min(Math.max(Number(req.body?.n) || 1, 1), MAX_IMAGE_COUNT);
  if (!model) return res.status(400).json({ error: 'no_model', message: 'Не выбрана модель.' });
  if (!prompt) return res.status(400).json({ error: 'empty_prompt', message: 'Пустой промпт.' });
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({
      error: 'prompt_too_long',
      message: `Промпт длиннее ${MAX_PROMPT_CHARS} символов.`,
    });
  }

  // Сразу показываем в переписке, что именно попросили нарисовать.
  store.addMessage(chat.id, { role: 'user', content: prompt });

  try {
    const { images, requestId } = await generateImage({ model, prompt, n });
    const attachments = saveGeneratedImages(images, 'image');
    store.addMessage(chat.id, {
      role: 'assistant',
      content: n > 1 ? `Готово: ${attachments.length} картинки.` : 'Готово.',
      attachments,
      requestId: requestId || undefined,
    });
    res.json({ chat: store.getChat(chat.id), requestId: requestId || null });
  } catch (err) {
    res.status(502).json({
      error: 'upstream_error',
      message: err.message,
      chat: store.getChat(chat.id),
    });
  }
});

// Редактирование картинки: POST /v1/images/edits. Операция долгая — модель
// может думать несколько минут, поэтому таймаут клиента должен быть не меньше 600 с.
app.post('/api/images/edits', async (req, res) => {
  const chat = store.getChat(req.body?.chatId);
  if (!chat) return res.status(404).json({ error: 'chat_not_found', message: 'Чат не найден.' });

  const model = String(req.body?.model || '').trim();
  const prompt = String(req.body?.prompt ?? '').trim();
  const n = Math.min(Math.max(Number(req.body?.n) || 1, 1), MAX_IMAGE_COUNT);
  const size = String(req.body?.size || 'auto');
  const ids = Array.isArray(req.body?.attachments) ? req.body.attachments : [];

  if (!model) return res.status(400).json({ error: 'no_model', message: 'Не выбрана модель.' });
  if (!prompt) return res.status(400).json({ error: 'empty_prompt', message: 'Опишите, что изменить.' });
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({
      error: 'prompt_too_long',
      message: `Описание длиннее ${MAX_PROMPT_CHARS} символов.`,
    });
  }
  if (!ids.length || ids.length > MAX_IMAGE_COUNT) {
    return res.status(400).json({
      error: 'bad_images',
      message: `Нужно от 1 до ${MAX_IMAGE_COUNT} картинок.`,
    });
  }

  let images;
  try {
    images = loadImageAttachments(ids);
  } catch (err) {
    return res.status(400).json({ error: 'bad_images', message: err.message });
  }

  // В историю кладём исходные картинки вместе с описанием правки.
  const sourceMeta = ids.map((id) => uploads.readUpload(id).meta);
  store.addMessage(chat.id, { role: 'user', content: prompt, attachments: sourceMeta });

  try {
    const { images: result, requestId } = await editImage({ model, prompt, images, n, size });
    const attachments = saveGeneratedImages(result, 'edit');
    store.addMessage(chat.id, {
      role: 'assistant',
      content: n > 1 ? `Готово: ${attachments.length} варианта.` : 'Готово.',
      attachments,
      requestId: requestId || undefined,
    });
    res.json({ chat: store.getChat(chat.id), requestId: requestId || null });
  } catch (err) {
    res.status(502).json({
      error: 'upstream_error',
      message: err.message,
      chat: store.getChat(chat.id),
    });
  }
});

// Создать новый чат.
app.post('/api/chats', async (req, res) => {
  let model = typeof req.body?.model === 'string' && req.body.model ? req.body.model : getCatalog().defaultModel;
  if (!model) {
    // Каталог ещё не загрузился — подтянем и возьмём модель по умолчанию.
    model = (await refreshCatalog()).defaultModel;
  }
  const chat = store.createChat(model);
  res.status(201).json({ chat });
});

// Получить один чат целиком (с сообщениями).
app.get('/api/chats/:id', (req, res) => {
  const chat = store.getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'chat_not_found', message: 'Чат не найден.' });
  res.json({ chat });
});

// Сменить модель у существующего чата.
app.patch('/api/chats/:id', (req, res) => {
  const chat = store.updateChat(req.params.id, { model: req.body?.model, title: req.body?.title });
  if (!chat) return res.status(404).json({ error: 'chat_not_found', message: 'Чат не найден.' });
  res.json({ chat });
});

// Удалить чат.
app.delete('/api/chats/:id', (req, res) => {
  const removed = store.deleteChat(req.params.id);
  if (!removed) return res.status(404).json({ error: 'chat_not_found', message: 'Чат не найден.' });
  res.json({ ok: true });
});

// Отправить сообщение и получить ответ модели.
app.post('/api/chats/:id/messages', async (req, res) => {
  const chat = store.getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'chat_not_found', message: 'Чат не найден.' });

  const content = String(req.body?.content ?? '').trim();
  const attachments = resolveAttachments(req.body?.attachments);
  if (!content && !attachments.length) {
    return res.status(400).json({ error: 'empty_message', message: 'Пустое сообщение.' });
  }

  store.addMessage(chat.id, { role: 'user', content, attachments });

  try {
    const reply = await chatComplete({
      model: chat.model,
      messages: toUpstreamMessages(store.getChat(chat.id).messages),
    });
    store.addMessage(chat.id, { role: 'assistant', content: reply });
    res.json({ chat: store.getChat(chat.id) });
  } catch (err) {
    // Сообщение пользователя сохраняем, но ответа нет — вернём ошибку и актуальный чат.
    res.status(502).json({
      error: 'upstream_error',
      message: err.message,
      chat: store.getChat(chat.id),
    });
  }
});

// То же самое, но ответ модели приходит потоком (Server-Sent Events).
// Клиент получает кусочки текста и рисует их «по буквам».
app.post('/api/chats/:id/messages/stream', async (req, res) => {
  const chat = store.getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'chat_not_found', message: 'Чат не найден.' });

  const content = String(req.body?.content ?? '').trim();
  const attachments = resolveAttachments(req.body?.attachments);
  if (!content && !attachments.length) {
    return res.status(400).json({ error: 'empty_message', message: 'Пустое сообщение.' });
  }

  store.addMessage(chat.id, { role: 'user', content, attachments });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // Если вкладку закрыли — прекращаем запрос к apimira, чтобы не жечь лимиты.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    let full = '';
    for await (const chunk of chatCompleteStream({
      model: chat.model,
      messages: toUpstreamMessages(store.getChat(chat.id).messages),
      signal: controller.signal,
    })) {
      full += chunk;
      send({ type: 'delta', text: chunk });
    }
    store.addMessage(chat.id, { role: 'assistant', content: full });
    send({ type: 'done', chat: store.getChat(chat.id) });
  } catch (err) {
    if (!res.writableEnded) {
      send({ type: 'error', message: err.message, chat: store.getChat(chat.id) });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// ----- Статика (только для "боевого" режима, если собран dist) -----

const dist = path.join(ROOT, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`elChatito backend: http://localhost:${PORT}`);
  // Список моделей подтягиваем из apimira сразу при запуске.
  refreshCatalog().then((catalog) => {
    if (catalog.error) {
      console.warn(`Не удалось загрузить список моделей: ${catalog.error}`);
    } else {
      console.log(`Загружено моделей: ${catalog.models.length} (по умолчанию: ${catalog.defaultModel})`);
    }
  });
});
