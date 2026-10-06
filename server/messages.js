// Превращаем сохранённые сообщения в формат apimira ([OI]-совместимый):
// картинки — как image_url (data URL), документы — как извлечённый текст.
// apimira принимает только текстовые части и картинки (тип "file" отклоняется).
import { readUpload } from './uploads.js';
import { extractText, detectImageMime } from './extract.js';

export function toUpstreamMessages(messages) {
  return messages.map((m) => {
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    if (!atts.length) return { role: m.role, content: m.content };

    const parts = [];
    if (m.content) parts.push({ type: 'text', text: m.content });

    for (const a of atts) {
      const file = readUpload(a.id);
      if (!file) {
        parts.push({ type: 'text', text: `[вложение «${a.name}» больше недоступно]` });
        continue;
      }
      if (file.meta.kind === 'image') {
        // mime уже определён по байтам при сохранении (uploads.js).
        const mime = file.meta.mime || 'image/png';
        // Старые загрузки (до проверки по байтам) могли быть GIF/BMP — такие
        // apimira не принимает. Не роняем весь запрос, а честно сообщаем текстом.
        if (!detectImageMime(file.buffer)) {
          parts.push({
            type: 'text',
            text: `[картинка «${a.name}» в формате, который модель не принимает: нужен PNG, JPEG или WebP]`,
          });
          continue;
        }
        // detail: auto | low | high — шлюз передаёт его модели как есть.
        const detail = ['low', 'high', 'auto'].includes(a.detail) ? a.detail : 'auto';
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${file.buffer.toString('base64')}`, detail },
        });
      } else {
        const text = extractText(file.meta.name, file.meta.mime, file.buffer);
        const body = text || '(не удалось извлечь текст из файла)';
        parts.push({ type: 'text', text: `Содержимое файла «${a.name}»:\n\n${body}` });
      }
    }
    return { role: m.role, content: parts };
  });
}
