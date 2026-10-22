// Проверка форматирования ответов модели (Markdown вместо сырых «звёздочек»).
// Разбор проверяется напрямую (client/src/markdown.js), а отрисовка — настоящим
// рендером в HTML (Markdown.jsx собирается через esbuild), чтобы опечатка в JSX
// не прошла незамеченной.
//
// Запуск: node scripts/test-markdown.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'client', 'src', 'markdown.js');
const VIEW = path.join(ROOT, 'client', 'src', 'Markdown.jsx');

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

// Первый кусочек нужного типа — так проверки читаются короче, чем весь массив.
const first = (tokens, type) => tokens.find((t) => t.type === type);
const textOf = (tokens) => tokens.map((t) => (t.type === 'text' ? t.value : '')).join('');

const { parseInline, parseMarkdown, safeHref } = await import(pathToFileURL(MODULE).href);

// 1. Строчное форматирование.
console.log('Строчное форматирование:');
const bold = parseInline('это **жирный** текст');
ok('**…** становится жирным', first(bold, 'strong')?.children[0]?.value === 'жирный', `(${JSON.stringify(bold)})`);
ok('текст вокруг жирного сохраняется', textOf(bold).startsWith('это ') && textOf(bold).endsWith(' текст'));
ok('__…__ тоже жирный', first(parseInline('__важно__'), 'strong')?.children[0]?.value === 'важно');
ok('*…* становится курсивом', first(parseInline('это *курсив* тут'), 'em')?.children[0]?.value === 'курсив');
ok('_…_ тоже курсив', first(parseInline('_курсив_'), 'em')?.children[0]?.value === 'курсив');
ok('~~…~~ становится зачёркнутым', first(parseInline('~~старое~~'), 'strike')?.children[0]?.value === 'старое');
ok('`код` становится кодом', first(parseInline('вызов `npm run dev` тут'), 'code')?.value === 'npm run dev');
ok('жирный и курсив в одном абзаце', !!first(parseInline('**а** и *б*'), 'strong') && !!first(parseInline('**а** и *б*'), 'em'));

// 2. Ссылки: только безопасные схемы, знаки препинания не съедаются.
console.log('Ссылки:');
const link = first(parseInline('[документация](https://apimira.com/docs)'), 'link');
ok('[текст](адрес) становится ссылкой', link?.href === 'https://apimira.com/docs', `(${JSON.stringify(link)})`);
ok('подпись ссылки сохраняется', link?.children?.[0]?.value === 'документация');
ok('голый адрес тоже становится ссылкой', first(parseInline('см. https://example.com/page'), 'link')?.href === 'https://example.com/page');
ok(
  'точка после адреса остаётся текстом',
  first(parseInline('см. https://example.com/a).'), 'link')?.href === 'https://example.com/a',
  `(${JSON.stringify(parseInline('см. https://example.com/a).'))})`,
);
ok('mailto разрешён', safeHref('mailto:cat@example.com') === 'mailto:cat@example.com');
ok('javascript: не превращается в ссылку', safeHref('javascript:alert(1)') === null);
ok('data: не превращается в ссылку', safeHref('data:text/html,<b>x</b>') === null);
ok(
  'опасная ссылка остаётся текстом',
  !first(parseInline('[жми](javascript:alert(1))'), 'link'),
  `(${JSON.stringify(parseInline('[жми](javascript:alert(1))'))})`,
);

// 3. «Мягкий» разбор: незакрытые пометки не ломают вывод во время печати.
console.log('Незакрытые пометки (ответ ещё печатается):');
ok('незакрытый ** остаётся текстом', !first(parseInline('**жирный'), 'strong') && textOf(parseInline('**жирный')) === '**жирный');
ok('незакрытый ` остаётся текстом', !first(parseInline('код `npm'), 'code'));
ok('одиночная звёздочка остаётся текстом', !first(parseInline('2 * 3 = 6'), 'em'), `(${JSON.stringify(parseInline('2 * 3 = 6'))})`);
ok('snake_case не превращается в курсив', !first(parseInline('my_snake_case_name'), 'em'));
ok('экранированная звёздочка остаётся символом', textOf(parseInline('\\*не курсив\\*')) === '*не курсив*');
ok('HTML из ответа остаётся текстом', textOf(parseInline('<script>alert(1)</script>')).includes('<script>'));

// 4. Блочный разбор.
console.log('Блоки:');
const heading = parseMarkdown('## Итоги')[0];
ok('## становится заголовком 2 уровня', heading?.type === 'heading' && heading.level === 2 && heading.text === 'Итоги');
ok('# и ### различаются по уровню', parseMarkdown('# Раз')[0]?.level === 1 && parseMarkdown('### Три')[0]?.level === 3);

const paragraphs = parseMarkdown('первый абзац\nвторая строка\n\nвторой абзац');
ok('абзацы разделяются пустой строкой', paragraphs.length === 2 && paragraphs[1].text === 'второй абзац', `(${paragraphs.length})`);
ok('переносы строк внутри абзаца сохранены', paragraphs[0].text.includes('\n'));

const code = parseMarkdown('```js\nconst a = 1;\n```')[0];
ok('``` делает блок кода', code?.type === 'code' && code.code === 'const a = 1;', `(${JSON.stringify(code)})`);
ok('язык блока кода сохраняется', code?.lang === 'js');
ok('закрытый блок помечен closed', code?.closed === true);
const openCode = parseMarkdown('```python\nprint(1)')[0];
ok('незакрытый ``` остаётся кодом (печать в процессе)', openCode?.type === 'code' && openCode.closed === false);
ok('звёздочки внутри кода остаются как есть', parseMarkdown('```\n**a**\n```')[0].code === '**a**');

const bullets = parseMarkdown('- один\n- два\n- три')[0];
ok('маркированный список разобран', bullets?.type === 'list' && !bullets.ordered && bullets.items.length === 3, `(${JSON.stringify(bullets)})`);
ok('текст пункта на месте', bullets?.items[0]?.blocks?.[0]?.text === 'один');
const numbered = parseMarkdown('1. первый\n2. второй')[0];
ok('нумерованный список разобран', numbered?.type === 'list' && numbered.ordered && numbered.items.length === 2);
const fromFive = parseMarkdown('5. пять\n6. шесть')[0];
ok('список начинается с указанного числа', fromFive?.start === 5, `(${fromFive?.start})`);
const nested = parseMarkdown('- внешний\n  - вложенный')[0];
ok(
  'вложенный список попадает внутрь пункта',
  nested?.items?.[0]?.blocks?.some((b) => b.type === 'list' && b.items[0].blocks[0].text === 'вложенный'),
  `(${JSON.stringify(nested)})`,
);

const quote = parseMarkdown('> цитата\n> вторая строка')[0];
ok('> становится цитатой', quote?.type === 'quote' && quote.blocks[0].text.includes('цитата'));
ok('--- становится линией', parseMarkdown('---')[0]?.type === 'hr');

const table = parseMarkdown('| Модель | Цена |\n| --- | ---: |\n| GPT | $1 |')[0];
ok('таблица разобрана', table?.type === 'table' && table.head.length === 2, `(${JSON.stringify(table)})`);
ok('шапка таблицы на месте', table?.head?.[0] === 'Модель');
ok('строка таблицы на месте', table?.rows?.[0]?.[1] === '$1');
ok('выравнивание из :---: читается', table?.align?.[1] === 'right', `(${JSON.stringify(table?.align)})`);
ok('обычный текст с | не становится таблицей', parseMarkdown('a | b')[0]?.type === 'paragraph');
ok('пустой ответ не даёт блоков', parseMarkdown('').length === 0 && parseMarkdown('   \n\n ').length === 0);

// 5. Отрисовка: собираем Markdown.jsx через esbuild и рендерим в HTML.
const esbuild = (await import('esbuild')).default;
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');

const source = fs.readFileSync(VIEW, 'utf8');
const outFile = path.join(ROOT, 'node_modules', '.cache', 'elchatito-markdown.mjs');
fs.mkdirSync(path.dirname(outFile), { recursive: true });

try {
  await esbuild.build({
    stdin: {
      contents: source,
      resolveDir: path.dirname(VIEW),
      sourcefile: 'Markdown.probe.jsx',
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

  const { Markdown } = await import(pathToFileURL(outFile).href);
  const render = (text, props = {}) => renderToStaticMarkup(React.createElement(Markdown, { text, ...props }));

  console.log('Отрисовка ответа модели:');
  const boldHtml = render('это **жирный** текст');
  ok('жирный отрисован тегом strong', boldHtml.includes('<strong>жирный</strong>'), `(${boldHtml})`);
  ok('звёздочки в тексте не остались', !boldHtml.includes('**'), `(${boldHtml})`);
  ok('курсив отрисован тегом em', render('*курсив*').includes('<em>курсив</em>'));
  ok('код отрисован тегом code', render('`npm i`').includes('md-inline-code'));
  ok('зачёркнутый отрисован тегом del', render('~~старое~~').includes('<del>старое</del>'));

  const listHtml = render('- один\n- два');
  ok('список отрисован как ul/li', listHtml.includes('<ul') && listHtml.includes('<li>один</li>'), `(${listHtml})`);
  ok('нумерация отрисована как ol', render('1. один\n2. два').includes('<ol'));

  const codeHtml = render('```js\nconst a = 1;\n```');
  ok('блок кода отрисован с подписью языка', codeHtml.includes('md-code') && codeHtml.includes('js'), `(${codeHtml})`);
  ok('в блоке кода есть кнопка «Копировать»', codeHtml.includes('md-copy') && codeHtml.includes('Копировать'));
  ok('текст кода не потерялся', codeHtml.includes('const a = 1;'));
  ok('кнопка кода не отправляет форму', /<button[^>]*type="button"/.test(codeHtml));

  const linkHtml = render('[документация](https://apimira.com/docs)');
  ok('ссылка отрисована тегом a', linkHtml.includes('<a') && linkHtml.includes('href="https://apimira.com/docs"'));
  ok('ссылка открывается в новой вкладке безопасно', linkHtml.includes('target="_blank"') && linkHtml.includes('rel="noreferrer"'));
  ok('опасная ссылка не стала тегом a', !render('[жми](javascript:alert(1))').includes('<a '));

  const headingHtml = render('## Итоги');
  ok('заголовок в пузыре на уровень ниже (h3)', headingHtml.includes('<h3>') && !headingHtml.includes('<h1>'), `(${headingHtml})`);
  ok('таблица отрисована', render('| a | b |\n| --- | --- |\n| 1 | 2 |').includes('<table'));
  ok('цитата отрисована', render('> мысль').includes('<blockquote'));
  ok('линия отрисована', render('---').includes('<hr'));

  const scriptHtml = render('<script>alert(1)</script>');
  ok('HTML из ответа экранирован', scriptHtml.includes('&lt;script&gt;') && !scriptHtml.includes('<script>'), `(${scriptHtml})`);
  ok('картинка не подгружается с чужого сайта', !render('![кот](https://evil.example/cat.png)').includes('<img'));
  ok('ссылка на картинку подписана', render('![кот](https://evil.example/cat.png)').includes('md-image'));

  const withCursor = render('печатается', { cursor: true });
  ok('курсор печати в конце текста', withCursor.includes('class="cursor"'), `(${withCursor})`);
  ok('без флага курсора нет', !render('готово').includes('class="cursor"'));
  ok('курсор один, а не в каждом блоке', render('первый\n\nвторой', { cursor: true }).split('class="cursor"').length === 2);
  ok('пустой ответ не падает', render('') === '<div class="md text"></div>', `(${render('')})`);
} finally {
  fs.rmSync(outFile, { force: true });
}

console.log(`\nИтог: ${pass} OK / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
