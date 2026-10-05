// Превращаем сохранённые сообщения в формат apimira ([OI]-совместимый):
// картинки — как image_url (data URL), документы — как извлечённый текст.
// apimira принимает только текстовые части и картинки (тип "file" отклоняется).
import { readUpload } from './uploads.js';
import { extractText } from './extract.js';

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
        const mime = file.meta.mime || 'image/png';
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${file.buffer.toString('base64')}` },
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
