// Проверка панели «Модели и цены» (кнопка «i»): подписи, назначение и тарифы.
// Чистая логика проверяется сразу, а таблица — настоящей отрисовкой в HTML
// (сборка App.jsx через esbuild), чтобы опечатка в JSX не прошла незамеченной.
// Если сервер запущен, панель проверяется на живом каталоге моделей.
//
// Запуск: node scripts/test-models.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE = process.env.API_BASE || 'http://localhost:3000/api';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'client', 'src', 'App.jsx');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  OK   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

// 1. Подписи моделей и «для чего подходит» — собираются из типа и capabilities.
const { modelLabel, purposeLabel, priceInfo, formatUsd, formatTokens, capMarks, TYPE_ORDER } = await import(
  '../client/src/modelInfo.js'
);

console.log('Подписи моделей:');
const visionChat = { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', type: 'chat', capabilities: ['vision'] };
const plainChat = { id: 'openai/gpt-5.4', name: 'GPT-5.4', type: 'chat', capabilities: [] };
const codeChat = { id: 'x/code', name: 'Code', type: 'chat', capabilities: ['code'] };
const imageGen = { id: 'openai/gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', type: 'image', capabilities: [] };
const imageEdit = { id: 'openai/gpt-image-2', name: 'GPT Image 2', type: 'image', capabilities: ['image_edit'] };
const video = { id: 'google/veo-3.1', name: 'Veo 3.1', type: 'video', capabilities: [] };
const embedding = { id: 'baai/bge-m3-embedding', name: 'BGE M3 Embedding', type: 'embedding', capabilities: [] };

ok('модель с vision получает глаз', modelLabel(visionChat) === '👁 GPT-6 Astra · чат', `(${modelLabel(visionChat)})`);
ok('модель без пометок — просто имя и тип', modelLabel(plainChat) === 'GPT-5.4 · чат', `(${modelLabel(plainChat)})`);
ok('кисть ставится у image_edit', capMarks(imageEdit) === '🖌', `(${capMarks(imageEdit)})`);
ok('чат без vision — «Текст и диалоги»', purposeLabel(plainChat) === 'Текст и диалоги');
ok('чат с vision — упоминает картинки', /картинки/.test(purposeLabel(visionChat)), `(${purposeLabel(visionChat)})`);
ok('кодовая модель — «Код и текст»', purposeLabel(codeChat) === 'Код и текст');
ok('картинка без image_edit только рисует', purposeLabel(imageGen) === 'Рисует картинки по описанию');
ok('картинка с image_edit ещё и правит', purposeLabel(imageEdit) === 'Рисует и правит картинки');
ok('видео описано как видео', /видео/.test(purposeLabel(video)), `(${purposeLabel(video)})`);
ok('эмбеддинги описаны как векторы', /Вектор/.test(purposeLabel(embedding)), `(${purposeLabel(embedding)})`);
ok('неизвестный тип не ломает подпись', purposeLabel({ name: 'X', type: 'weird' }) === '—');
ok('порядок разделов начинается с чата', TYPE_ORDER[0] === 'chat');

console.log('Формат цен:');
ok('$ не теряется', formatUsd(0.68) === '$0.68', `(${formatUsd(0.68)})`);
ok('хвостовые нули убираются', formatUsd(2.25) === '$2.25' && formatUsd(1.5) === '$1.5', `(${formatUsd(1.5)})`);
ok('копейки видны у дешёвых моделей', formatUsd(0.038) === '$0.038', `(${formatUsd(0.038)})`);
ok('null превращается в прочерк', formatUsd(null) === '—');
ok('контекст форматируется с пробелом', formatTokens(250000) === '250\u00a0000', `(${formatTokens(250000)})`);

console.log('Тарифы:');
const chatPrice = priceInfo({
  pricing: { unit: '1m_tokens', input: 0.68, cachedInput: 0.4, output: 2.25, generation: null },
});
ok('чат — тариф по токенам', chatPrice?.kind === 'tokens' && chatPrice.input === 0.68 && chatPrice.output === 2.25);
const framePrice = priceInfo({ pricing: { unit: 'generation', input: null, cachedInput: null, output: null, generation: 0.08775 } });
ok('картинка — цена за кадр', framePrice?.kind === 'frame' && framePrice.amount === 0.08775);
const secondPrice = priceInfo({ pricing: { unit: 'second', input: null, cachedInput: null, output: null, generation: 0.12 } });
ok('видео — цена за секунду', secondPrice?.kind === 'second' && secondPrice.amount === 0.12);
ok('без прайса тариф не выдумывается', priceInfo({ pricing: null }) === null && priceInfo({}) === null);
ok('пустой прайс не считается тарифом', priceInfo({ pricing: { unit: '1m_tokens', input: null, output: null, generation: null } }) === null);

// 2. Каталог сервера: у моделей есть pricing, который нужен панели.
let models = [];
let live = false;
try {
  const res = await fetch(`${BASE}/models`);
  models = (await res.json()).models || [];
  live = models.length > 0;
} catch {
  // сервер не запущен — на этом шаге ничего не проверяем
}

if (live) {
  console.log(`Каталог сервера (${models.length} моделей):`);
  ok('у каждой модели есть тип', models.every((m) => typeof m.type === 'string' && m.type));
  ok('у каждой модели есть capabilities', models.every((m) => Array.isArray(m.capabilities)));
  const priced = models.filter((m) => priceInfo(m));
  ok('цены пришли хотя бы для большинства моделей', priced.length >= models.length - 2, `(${priced.length}/${models.length})`);
  const chat = models.find((m) => m.type === 'chat');
  ok('у чат-модели тариф по токенам', priceInfo(chat)?.kind === 'tokens', `(${JSON.stringify(chat?.pricing)})`);
  const image = models.find((m) => m.type === 'image');
  ok('у картинок есть тариф', Boolean(priceInfo(image)), `(${JSON.stringify(image?.pricing)})`);
  ok('все видео — посекундно', models.filter((m) => m.type === 'video').every((m) => priceInfo(m)?.kind === 'second'));
} else {
  console.log('Каталог сервера: пропущено (сервер не запущен).');
  // Фикстура: все три вида тарифа плюс модель без прайса и с незнакомым типом.
  models = [
    { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra', type: 'chat', capabilities: ['vision'], contextWindow: 250000, pricing: { unit: '1m_tokens', input: 0.68, cachedInput: 0.4, output: 2.25, generation: null } },
    { id: 'openai/gpt-image-2', name: 'GPT Image 2', type: 'image', capabilities: ['image_edit'], contextWindow: null, pricing: { unit: '1m_tokens', input: 1.44, cachedInput: null, output: 8.64, generation: null } },
    { id: 'google/veo-3.1', name: 'Veo 3.1', type: 'video', capabilities: [], contextWindow: null, pricing: { unit: 'second', input: null, cachedInput: null, output: null, generation: 0.28 } },
    { id: 'baff/unknown', name: 'Загадка', type: 'weird', capabilities: [], contextWindow: null, pricing: null },
  ];
}

// 3. Отрисовка панели: собираем App.jsx через esbuild и рендерим таблицу в HTML.
//    Внутренние компоненты становятся экспортируемыми только в этой сборке —
//    исходник App.jsx не трогаем (esbuild берёт код из stdin).
const esbuild = (await import('esbuild')).default;
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');

const source = fs.readFileSync(APP, 'utf8');
const outFile = path.join(ROOT, 'node_modules', '.cache', 'elchatito-panel.mjs');
fs.mkdirSync(path.dirname(outFile), { recursive: true });

try {
  await esbuild.build({
    stdin: {
      contents: `${source}\nexport { ModelInfoPanel, PriceCell };\n`,
      // resolveDir нужен, чтобы относительные импорты внутри App.jsx нашли свои файлы.
      resolveDir: path.dirname(APP),
      sourcefile: 'App.probe.jsx',
      loader: 'jsx',
    },
    outfile: outFile,
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    platform: 'node',
    external: ['react', 'react-dom', 'react-dom/server'],
    logLevel: 'silent',
  });

  const { ModelInfoPanel, PriceCell } = await import(pathToFileURL(outFile).href);

  console.log(`Отрисовка панели (${models.length} моделей${live ? ', живой каталог' : ', фикстура'}):`);
  const html = renderToStaticMarkup(
    React.createElement(ModelInfoPanel, {
      models,
      currentModelId: models[0]?.id,
      onPick: () => {},
      onClose: () => {},
    }),
  );

  ok('панель отрисовалась не пустой', html.length > 400, `(${html.length})`);
  ok('есть заголовок «Модели и цены»', html.includes('Модели и цены'));
  ok('есть колонки «Модель / Для чего / Стоимость»', html.includes('>Модель<') && html.includes('>Для чего<') && html.includes('>Стоимость<'));
  ok('есть поиск и выбор модели по клику', html.includes('infopanel-search') && html.includes('Выбрать модель'));
  ok('название и id модели видно', html.includes(models[0].name) && html.includes(models[0].id));
  ok('текущая модель подсвечена', html.includes('current'));
  ok('тариф показан в долларах', html.includes('$'), '(ни одной цены)');
  ok('пояснение «за 1M токенов» есть', html.includes('за 1M токенов'));
  if (models.some((m) => m.type === 'video')) ok('у видео написано «за секунду видео»', html.includes('за секунду видео'));
  if (models.some((m) => !['chat', 'image', 'video', 'embedding'].includes(m.type))) {
    ok('незнакомый тип попал в раздел «прочее»', html.includes('прочее'));
  }
  if (models.some((m) => !priceInfo(m))) ok('модель без прайса подписана «нет данных»', html.includes('нет данных'));

  console.log('Ячейка цены:');
  ok('без прайса — «нет данных»', renderToStaticMarkup(React.createElement(PriceCell, { price: null })).includes('нет данных'));
  ok(
    'цена за кадр подписана',
    renderToStaticMarkup(React.createElement(PriceCell, { price: { kind: 'frame', amount: 0.08775 } })).includes('за кадр'),
  );
  ok(
    'у видео подпись «за секунду видео»',
    renderToStaticMarkup(React.createElement(PriceCell, { price: { kind: 'second', amount: 0.28 } })).includes('за секунду видео'),
  );

  // Панель на пустом каталоге не должна падать.
  const empty = renderToStaticMarkup(
    React.createElement(ModelInfoPanel, { models: [], currentModelId: null, onPick: () => {}, onClose: () => {} }),
  );
  ok('пустой каталог даёт подсказку, а не падение', empty.includes('не загружен'));
} finally {
  fs.rmSync(outFile, { force: true });
}

console.log(`\nИтог: ${pass} OK / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
