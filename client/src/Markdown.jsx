// Красивое отображение ответа модели: Markdown вместо сырых «звёздочек».
// Разбор текста живёт в markdown.js (чистая логика, её проверяет
// scripts/test-markdown.js), а здесь — только превращение дерева в HTML.
//
// HTML из ответа модели не выполняется: всё, что похоже на теги, остаётся
// текстом (React экранирует строки сам), ссылками становятся только http/https.
import { useMemo, useState } from 'react';
import { parseMarkdown, parseInline } from './markdown.js';

// Строчные кусочки: **жирный**, *курсив*, `код`, ~~зачёркнуто~~, ссылки.
function inline(tokens) {
  return tokens.map((t, i) => {
    if (t.type === 'text') return t.value;
    if (t.type === 'code') return <code key={i} className="md-inline-code">{t.value}</code>;
    if (t.type === 'strong') return <strong key={i}>{inline(t.children)}</strong>;
    if (t.type === 'em') return <em key={i}>{inline(t.children)}</em>;
    if (t.type === 'strike') return <del key={i}>{inline(t.children)}</del>;
    if (t.type === 'link') {
      return (
        <a key={i} href={t.href} target="_blank" rel="noreferrer">
          {inline(t.children)}
        </a>
      );
    }
    // Картинку из ответа не подгружаем — за ней ходил бы браузер к чужому сайту.
    if (t.type === 'image') {
      return (
        <a key={i} className="md-image" href={t.href} target="_blank" rel="noreferrer">
          🖼 {t.value || 'картинка'}
        </a>
      );
    }
    return null;
  });
}

function Inline({ text }) {
  return <>{inline(parseInline(text))}</>;
}

// Блок кода с подписью языка и кнопкой «Копировать».
function CodeBlock({ lang, code, tail }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    const write = navigator.clipboard?.writeText(code);
    if (!write) return; // старый браузер — кнопка просто ничего не делает
    write
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang || 'код'}</span>
        <button type="button" className="md-copy" onClick={copy}>
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      {/* Без переносов внутри JSX: лишние пробелы в <pre> были бы видны. */}
      <pre><code>{code}{tail}</code></pre>
    </div>
  );
}

function Table({ block }) {
  const cellStyle = (j) => (block.align?.[j] ? { textAlign: block.align[j] } : undefined);
  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {block.head.map((cell, j) => (
              <th key={j} style={cellStyle(j)}>
                <Inline text={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {block.head.map((_, j) => (
                <td key={j} style={cellStyle(j)}>
                  <Inline text={row[j] ?? ''} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Один блок дерева. tail — мигающий курсор, он идёт в самый конец последнего
// блока, чтобы во время печати ответа «мигало» ровно там, где сейчас текст.
function block(blockData, key, tail) {
  switch (blockData.type) {
    case 'heading': {
      // Заголовок # в пузыре выглядел бы огромным — сдвигаем уровень на один.
      const Tag = `h${Math.min(blockData.level + 1, 6)}`;
      return (
        <Tag key={key}>
          <Inline text={blockData.text} />
          {tail}
        </Tag>
      );
    }

    case 'paragraph':
      return (
        <p key={key}>
          <Inline text={blockData.text} />
          {tail}
        </p>
      );

    case 'code':
      return <CodeBlock key={key} lang={blockData.lang} code={blockData.code} tail={tail} />;

    case 'hr':
      return <hr key={key} />;

    case 'quote':
      return (
        <blockquote key={key}>
          {blockData.blocks.map((inner, j) => block(inner, j, tail && j === blockData.blocks.length - 1 ? tail : null))}
        </blockquote>
      );

    case 'list': {
      const Tag = blockData.ordered ? 'ol' : 'ul';
      return (
        <Tag key={key} start={blockData.ordered && blockData.start !== 1 ? blockData.start : undefined}>
          {blockData.items.map((item, j) => {
            const last = j === blockData.items.length - 1;
            const inner = item.blocks;
            // Пункт из одного абзаца рисуем без <p>: иначе каждая строка списка
            // получает лишние отступы и список выглядит «рыхлым».
            if (inner.length === 1 && inner[0].type === 'paragraph') {
              return (
                <li key={j}>
                  <Inline text={inner[0].text} />
                  {tail && last ? tail : null}
                </li>
              );
            }
            return (
              <li key={j}>
                {inner.map((b, k) => block(b, k, tail && last && k === inner.length - 1 ? tail : null))}
              </li>
            );
          })}
        </Tag>
      );
    }

    case 'table':
      return <Table key={key} block={blockData} />;

    default:
      return null;
  }
}

// Ответ модели целиком. cursor=true добавляет мигающий курсор в конец текста.
export function Markdown({ text, cursor = false }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="md text">
      {blocks.map((b, i) => block(b, i, cursor && i === blocks.length - 1 ? <span className="cursor" /> : null))}
    </div>
  );
}