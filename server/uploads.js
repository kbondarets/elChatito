// Загруженные файлы храним на диске: data/uploads/<id> (байты) и <id>.json (мета).
// В chats.json попадают только метаданные — иначе файл распухнет от base64.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classify, detectImageMime } from './extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, '..', 'data', 'uploads');

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Картинки шлюз принимает не больше 5 МБ двоичных данных (см. документацию apimira).
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// id — UUID, поэтому такой проверки достаточно, чтобы не выйти из папки.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function saveUpload({ name, mime, dataBase64 }) {
  const buffer = Buffer.from(String(dataBase64 || ''), 'base64');
  return saveBuffer({ name, mime, buffer });
}

// Общий путь сохранения: и для загрузки из интерфейса, и для картинок,
// которые мы получили от модели (b64_json) — кладём их на диск тем же способом.
// maxBytes переопределяет предел (картинки от модели уже оплачены — их храним всегда).
export function saveBuffer({ name, mime, buffer, maxBytes }) {
  if (!buffer || !buffer.length) throw new Error('Пустой файл.');

  const cleanName = String(name || 'file').replace(/[\\/]/g, '_').slice(0, 200) || 'file';
  const kind = classify(cleanName, mime, buffer);

  if (kind === 'image_unsupported') {
    throw new Error(
      `Картинку «${cleanName}» apimira не принимает: нужен PNG, JPEG или WebP ` +
        `(тип определяется по содержимому файла).`,
    );
  }
  if (kind === 'unsupported') {
    throw new Error(
      `Не могу обработать «${cleanName}»: поддерживаются картинки, текст, PDF и DOCX.`,
    );
  }

  // Лимит 5 МБ — только для картинок; документы и текст грузим до общего предела.
  const limit = maxBytes || (kind === 'image' ? MAX_IMAGE_BYTES : MAX_UPLOAD_BYTES);
  if (buffer.length > limit) {
    throw new Error(`Файл «${cleanName}» больше ${Math.round(limit / 1024 / 1024)} МБ.`);
  }

  const id = crypto.randomUUID();
  // Для картинок mime берём из содержимого — так его ждёт apimira.
  const meta = {
    id,
    name: cleanName,
    mime: kind === 'image' ? detectImageMime(buffer) : String(mime || ''),
    size: buffer.length,
    kind,
  };

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
