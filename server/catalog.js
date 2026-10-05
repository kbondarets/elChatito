// Кэш каталога моделей в памяти. Загружается при старте сервера и
// перезагружается, если кэш пуст. Никакого фиксированного файла со списком.
import { fetchCatalog } from './apimira.js';

let state = { models: [], defaultModel: '', loadedAt: null, error: null };

// Модель по умолчанию — первая чат-модель (иначе просто первая в списке).
function pickDefault(models) {
  const chat = models.find((m) => m.type === 'chat');
  return (chat || models[0])?.id || '';
}

export async function refreshCatalog() {
  try {
    const models = await fetchCatalog();
    state = {
      models,
      defaultModel: pickDefault(models),
      loadedAt: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    state = { ...state, error: err.message };
  }
  return state;
}

export function getCatalog() {
  return state;
}
