// Загруженные файлы храним на диске: data/uploads/<id> (байты) и <id>.json (мета).
// В chats.json попадают только метаданные — иначе файл распухнет от base64.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classify } from './extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, '..', 'data', 'uploads');

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// id — UUID, поэтому такой проверки достаточно, чтобы не выйти из папки.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function saveUpload({ name, mime, dataBase64 }) {
  const buffer = Buffer.from(String(dataBase64 || ''), 'base64');
  if (!buffer.length) throw new Error('Пустой файл.');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Файл больше ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ.`);
  }

  const cleanName = String(name || 'file').replace(/[\\/]/g, '_').slice(0, 200) || 'file';
  const kind = classify(cleanName, mime, buffer);
  if (kind === 'unsupported') {
    throw new Error(
      `Не могу обработать «${cleanName}»: поддерживаются картинки, текст, PDF и DOCX.`,
    );
  }

  const id = crypto.randomUUID();
  const meta = { id, name: cleanName, mime: String(mime || ''), size: buffer.length, kind };

  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, id), buffer);
  fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

export function readUpload(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
    const buffer = fs.readFileSync(path.join(DIR, id));
    return { meta, buffer };
  } catch {
    return null;
  }
}

export function uploadPath(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const file = path.join(DIR, id);
  return fs.existsSync(file) ? file : null;
}
