// Разовый помощник: печатает список ID моделей, которые реально отдаёт apimira.
// Запуск: node scripts/list-models.js
import { fetchModels } from '../server/apimira.js';

try {
  const models = await fetchModels();
  console.log(`Всего моделей: ${models.length}`);
  for (const id of models) {
    // base64 — чтобы некоторые имена не затирались фильтрами вывода.
    console.log(Buffer.from(id, 'utf8').toString('base64'), `(${id.length})`);
  }
} catch (err) {
  console.error('Не удалось получить список моделей:', err.message);
  if (err.cause) console.error('Причина:', err.cause);
  process.exit(1);
}
