// Подписи и тарифы моделей для панели «Модели и цены» (кнопка «i» в шапке).
// Здесь нет JSX — этот же файл проверяет scripts/test-models.js.

// Человеческие подписи для типов моделей (тип приходит из /v1/account/pricing).
export const TYPE_LABEL = { chat: 'чат', image: 'картинки', video: 'видео', embedding: 'эмбеддинги' };

// Порядок разделов в панели: сначала то, чем пользуются чаще всего.
export const TYPE_ORDER = ['chat', 'image', 'video', 'embedding'];

// «Видит картинки» — глаз, «правит картинки» — кисть (подписи к каталогу).
export function capMarks(m) {
  const caps = m?.capabilities || [];
  return `${caps.includes('vision') ? '👁' : ''}${caps.includes('image_edit') ? '🖌' : ''}`;
}

// Подпись модели в выпадающем списке: «👁 GPT-6 Astra · чат».
export function modelLabel(m) {
  const marks = capMarks(m);
  return `${marks ? `${marks} ` : ''}${m.name} · ${TYPE_LABEL[m.type] || m.type}`;
}

// «Для чего подходит» собираем из типа и возможностей, а не из ручного списка:
// тогда подпись не устареет, когда apimira добавит новые модели.
export function purposeLabel(m) {
  const caps = m.capabilities || [];
  if (m.type === 'image') {
    return caps.includes('image_edit') ? 'Рисует и правит картинки' : 'Рисует картинки по описанию';
  }
  if (m.type === 'video') return 'Генерирует видео по описанию';
  if (m.type === 'embedding') return 'Векторы текста для поиска и сравнения';
  if (m.type === 'chat') {
    if (caps.includes('code') && caps.includes('vision')) return 'Код, текст и картинки';
    if (caps.includes('code')) return 'Код и текст';
    if (caps.includes('vision')) return 'Текст и картинки, диалоги';
    return 'Текст и диалоги';
  }
  return '—';
}

// Деньги apimira отдаёт в USD (внутренний учёт ведётся в USD) — так и показываем,
// без пересчёта в рубли «на глазок». Хвостовые нули убираем: $0.680 → $0.68.
export function formatUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const digits = value >= 1 ? 2 : value >= 0.1 ? 3 : 4;
  return `$${value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')}`;
}

// 250000 → «250 000».
export function formatTokens(n) {
  return typeof n === 'number' ? new Intl.NumberFormat('ru-RU').format(n) : '';
}

// Тариф модели в удобном для таблицы виде.
//   { kind: 'tokens', input, cachedInput, output } — за 1M токенов;
//   { kind: 'frame' | 'second', amount }          — за кадр картинки / секунду видео.
// null — если apimira цену не отдала (тогда в таблице напишем «нет данных»).
export function priceInfo(m) {
  const p = m?.pricing;
  if (!p) return null;
  if (p.unit === '1m_tokens' && (p.input != null || p.output != null)) {
    return { kind: 'tokens', input: p.input, cachedInput: p.cachedInput, output: p.output };
  }
  if (p.generation != null) {
    return { kind: p.unit === 'second' ? 'second' : 'frame', amount: p.generation };
  }
  return null;
}

