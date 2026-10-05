// Тонкая обёртка над fetch: всегда шлём JSON и превращаем ошибки в понятный текст.
export async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  let data = {};
  try {
    data = await res.json();
  } catch {
    // пустой ответ — оставим {}
  }

  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Ошибка ${res.status}`);
  }
  return data;
}

// Читаем файл в base64 (без префикса "data:...;base64,") — так его ждёт сервер.
export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error(`Не удалось прочитать файл «${file.name}».`));
    reader.readAsDataURL(file);
  });
}

// Загружаем один файл и получаем его метаданные для вложения.
export async function uploadFile(file) {
  const dataBase64 = await readFileAsBase64(file);
  const { file: meta } = await api('/uploads', {
    method: 'POST',
    body: JSON.stringify({ name: file.name, mime: file.type, dataBase64 }),
  });
  return meta;
}

// Потоковый запрос: читаем SSE-ответ сервера и отдаём кусочки текста в onDelta.
// Возвращает финальный объект чата из события "done" (или null).
export async function apiStream(path, body, { onDelta, signal } = {}) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let data = {};
    try {
      data = await res.json();
    } catch {
      // тела нет — покажем хотя бы код статуса
    }
    throw new Error(data?.message || data?.error || `Ошибка ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalChat = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // События SSE разделяются пустой строкой.
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = event.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;

        let data;
        try {
          data = JSON.parse(line.slice(5).trim());
        } catch {
          continue; // неполный/битый кусок — пропускаем
        }

        if (data.type === 'delta') onDelta?.(data.text);
        else if (data.type === 'done') finalChat = data.chat;
        else if (data.type === 'error') throw new Error(data.message);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return finalChat;
}
