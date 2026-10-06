import 'dotenv/config';
// Запасной DNS через DoH: подключаем до первого сетевого запроса, чтобы
// apimira.com находился, даже если провайдер «глушит» обычный DNS (см. server/doh.js).
import './doh.js';

// Базовый адрес apimira. Убираем хвостовые слэши, чтобы не получилось /v1/v1.
const BASE_URL = (process.env.apimira_base_url || 'https://apimira.com/v1').replace(/\/+$/, '');
const API_KEY = process.env.apimira_api_key;

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
  };
}

// Список моделей у самого apimira (GET /v1/models). Ключ здесь не печатаем.
export async function fetchModels() {
  assertKey();
  const res = await fetch(`${BASE_URL}/models`, { headers: authHeaders() });
  const text = await res.text();
  const data = safeJson(text);
  if (!res.ok) throw new Error(errorMessage(res, data, text));
  const models = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
  return models;
}

// Каталог для интерфейса: id берём из GET /v1/models, а тип и название —
// из GET /v1/account/pricing (там есть поле type: chat / image / video).
export async function fetchCatalog() {
  assertKey();

  const modelsRes = await fetch(`${BASE_URL}/models`, { headers: authHeaders() });
  const modelsText = await modelsRes.text();
  const modelsData = safeJson(modelsText);
  if (!modelsRes.ok) throw new Error(errorMessage(modelsRes, modelsData, modelsText));
  const ids = Array.isArray(modelsData?.data) ? modelsData.data.map((m) => m.id) : [];

  // Типы и цены — вспомогательные данные: если не получились, покажем хотя бы id.
  const meta = new Map();
  try {
    const pricingRes = await fetch(`${BASE_URL}/account/pricing`, { headers: authHeaders() });
    const pricingData = safeJson(await pricingRes.text());
    if (pricingRes.ok && Array.isArray(pricingData?.data)) {
      for (const p of pricingData.data) meta.set(p.id, p);
    }
  } catch {
    // без типов тоже сойдёт
  }

  return ids.map((id) => {
    const p = meta.get(id);
    return {
      id,
      name: p?.name || id,
      type: p?.type || 'unknown',
      // capabilities из /account/pricing: например ["vision"] — модель видит картинки.
      capabilities: Array.isArray(p?.capabilities) ? p.capabilities : [],
      contextWindow: p?.context_window ?? null,
    };
  });
}

// Обычный (не потоковый) ответ модели: POST /v1/chat/completions.
export async function chatComplete({ model, messages }) {
  assertKey();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ model, messages }),
  });
  const text = await res.text();
  const data = safeJson(text);
  if (!res.ok) throw new Error(errorMessage(res, data, text));
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

// Потоковый ответ модели: тот же POST /v1/chat/completions, но со stream: true.
// apimira присылает SSE-строки "data: {...}", заканчивая маркером "data: [DONE]".
// Отдаём кусочки текста по мере поступления — интерфейс рисует их «по буквам».
export async function* chatCompleteStream({ model, messages, signal }) {
  assertKey();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(errorMessage(res, safeJson(text), text));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Разбираем буфер построчно: каждая значимая строка начинается с "data:".
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        const chunk = safeJson(payload)?.choices?.[0]?.delta?.content;
        if (typeof chunk === 'string' && chunk) yield chunk;
      }
    }
  } finally {
    // Освобождаем соединение, если вышли раньше (например, по [DONE]).
    reader.cancel().catch(() => {});
  }
}

function assertKey() {
  if (!API_KEY || API_KEY.includes('ВСТАВЬТЕ') || API_KEY.includes('ВАШ_КЛЮЧ')) {
    throw new Error('Ключ apimira не задан: откройте файл .env и впишите apimira_api_key.');
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Ошибки apimira приходят в формате { error: { message, type, code, param } }.
function errorMessage(res, data, rawText) {
  const apiError = data?.error;
  if (apiError?.message) {
    return `${apiError.message}${apiError.code ? ` (${apiError.code})` : ''}`;
  }
  return rawText || `HTTP ${res.status}`;
}
