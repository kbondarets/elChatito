import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Чаты храним в простом JSON-файле: data/chats.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'chats.json');

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.chats)) return parsed;
  } catch {
    // файла ещё нет или он повреждён — начнём с чистого листа
  }
  return { chats: [] };
}

function write(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), 'utf8');
}

// Для списка чатов сообщения не нужны — отдаём только шапку.
export function listChats() {
  return read().chats.map(({ id, title, model, createdAt, updatedAt }) => ({
    id,
    title,
    model,
    createdAt,
    updatedAt,
  }));
}

export function getChat(id) {
  return read().chats.find((c) => c.id === id) ?? null;
}

export function createChat(model) {
  const db = read();
  const now = new Date().toISOString();
  const chat = {
    id: crypto.randomUUID(),
    title: 'Новый чат',
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  db.chats.unshift(chat);
  write(db);
  return chat;
}

export function updateChat(id, patch) {
  const db = read();
  const chat = db.chats.find((c) => c.id === id);
  if (!chat) return null;
  if (typeof patch.model === 'string' && patch.model) chat.model = patch.model;
  if (typeof patch.title === 'string' && patch.title) chat.title = patch.title;
  chat.updatedAt = new Date().toISOString();
  write(db);
  return chat;
}

export function addMessage(id, message) {
  const db = read();
  const chat = db.chats.find((c) => c.id === id);
  if (!chat) return null;
  chat.messages.push(message);
  chat.updatedAt = new Date().toISOString();
  // Заголовок чата берём из первого сообщения пользователя
  // (или из имени первого вложения, если текста нет).
  if (chat.title === 'Новый чат' && message.role === 'user') {
    const base = message.content.trim() || message.attachments?.[0]?.name || '';
    chat.title = base.slice(0, 48) || 'Новый чат';
  }
  write(db);
  return chat;
}

// Удаляем чат целиком. true — если что-то удалили, false — если такого чата не было.
export function deleteChat(id) {
  const db = read();
  const before = db.chats.length;
  db.chats = db.chats.filter((c) => c.id !== id);
  if (db.chats.length === before) return false;
  write(db);
  return true;
}
