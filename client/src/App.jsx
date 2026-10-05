import { useEffect, useRef, useState } from 'react';
import { api, apiStream, uploadFile } from './api.js';

// Человеческие подписи для типов моделей (тип приходит из /v1/account/pricing).
const TYPE_LABEL = { chat: 'чат', image: 'картинки', video: 'видео', embedding: 'эмбеддинги' };
// Модели с capability "vision" видят картинки — помечаем глазом.
const modelLabel = (m) =>
  `${m.capabilities?.includes('vision') ? '👁 ' : ''}${m.name} · ${TYPE_LABEL[m.type] || m.type}`;

const FILE_ICON = { pdf: '📕', docx: '📘', text: '📄', image: '🖼️' };

function formatSize(bytes) {
  if (typeof bytes !== 'number') return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

// Вложение в пузыре сообщения: картинку показываем превью, остальное — плашкой.
function AttachmentView({ a }) {
  const url = `/api/uploads/${a.id}`;
  if (a.kind === 'image') {
    return (
      <a className="att-image" href={url} target="_blank" rel="noreferrer" title={a.name}>
        <img src={url} alt={a.name} />
      </a>
    );
  }
  return (
    <a className="att-file" href={url} target="_blank" rel="noreferrer" title={a.name}>
      <span className="att-icon">{FILE_ICON[a.kind] || '📎'}</span>
      <span className="att-name">{a.name}</span>
      <span className="att-size">{formatSize(a.size)}</span>
    </a>
  );
}

export default function App() {
  const [models, setModels] = useState([]);
  const [chats, setChats] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [chat, setChat] = useState(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // Текст, который «печатается» прямо сейчас — плавный вывод ответа модели.
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState('');
  // id чата, который сейчас переименовываем, и текст нового имени.
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  // Флаг: нажали Esc — при потере фокуса имя сохранять не надо.
  const cancelRenameRef = useRef(false);
  const bottomRef = useRef(null);
  const messagesRef = useRef(null);
  // «Печатная машинка»: bufferRef — что уже пришло, shownRef — сколько показано.
  const bufferRef = useRef('');
  const shownRef = useRef(0);
  const rafRef = useRef(0);
  const doneRef = useRef(false);
  const typingDoneRef = useRef(null);
  // Файлы, готовые к отправке (уже загружены на сервер — храним метаданные).
  const [pending, setPending] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  // При старте: список моделей и список чатов.
  useEffect(() => {
    (async () => {
      try {
        const [m, c] = await Promise.all([api('/models'), api('/chats')]);
        setModels(m.models || []);
        setChats(c.chats || []);
      } catch (e) {
        setError(e.message);
      }
    })();
  }, []);

  // При выборе чата — загружаем его сообщения.
  useEffect(() => {
    if (!currentId) {
      setChat(null);
      return;
    }
    (async () => {
      try {
        const { chat } = await api(`/chats/${currentId}`);
        setChat(chat);
      } catch (e) {
        setError(e.message);
      }
    })();
  }, [currentId]);

  // При смене чата не тащим с собой неотправленные вложения.
  useEffect(() => {
    setPending([]);
  }, [currentId]);

  // Прокрутка вниз при новом сообщении или во время ожидания ответа.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat?.messages?.length, sending]);

  // Во время «печати» держимся у нижнего края, но не мешаем, если прокрутили вверх почитать.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [streamText]);

  async function refreshChats() {
    const { chats } = await api('/chats');
    setChats(chats || []);
  }

  // Загружаем выбранные файлы по одному (чтобы показать ошибку по конкретному файлу).
  async function pickFiles(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = ''; // иначе нельзя выбрать тот же файл повторно
    if (!files.length) return;
    setError('');
    setUploading(true);
    try {
      for (const f of files) {
        try {
          const meta = await uploadFile(f);
          setPending((prev) => [...prev, meta]);
        } catch (e) {
          setError(e.message);
        }
      }
    } finally {
      setUploading(false);
    }
  }

  function removePending(id) {
    setPending((prev) => prev.filter((a) => a.id !== id));
  }

  async function newChat() {
    if (sending) return; // не переключаемся, пока модель печатает
    setError('');
    // Берём модель текущего чата, а если чата нет — первую чат-модель.
    const model = chat?.model || models.find((m) => m.type === 'chat')?.id || models[0]?.id;
    try {
      const { chat: created } = await api('/chats', {
        method: 'POST',
        body: JSON.stringify({ model }),
      });
      await refreshChats();
      setCurrentId(created.id);
    } catch (e) {
      setError(e.message);
    }
  }

  // «Печатная машинка»: плавно дорисовывает текст из буфера через requestAnimationFrame.
  // Чем больше символов осталось, тем крупнее шаг — так хвост догоняет без рывков.
  function startTyping() {
    cancelAnimationFrame(rafRef.current);
    typingDoneRef.current = new Promise((resolve) => {
      const pump = () => {
        const buffer = bufferRef.current;
        if (shownRef.current < buffer.length) {
          const remaining = buffer.length - shownRef.current;
          const step = Math.max(2, Math.ceil(remaining / 12));
          shownRef.current = Math.min(buffer.length, shownRef.current + step);
          setStreamText(buffer.slice(0, shownRef.current));
        }
        if (shownRef.current < buffer.length || !doneRef.current) {
          rafRef.current = requestAnimationFrame(pump);
        } else {
          resolve();
        }
      };
      rafRef.current = requestAnimationFrame(pump);
    });
  }

  async function send(event) {
    event?.preventDefault();
    const content = input.trim();
    const attachments = pending.map((a) => a.id);
    if ((!content && !attachments.length) || !currentId || sending || uploading) return;

    setError('');
    setSending(true);
    setInput('');
    setPending([]);
    // Сразу показываем сообщение пользователя, не дожидаясь сервера.
    setChat((prev) =>
      prev ? { ...prev, messages: [...prev.messages, { role: 'user', content, attachments: pending }] } : prev,
    );

    // Сбрасываем «печатную машинку» и запускаем плавный вывод.
    bufferRef.current = '';
    shownRef.current = 0;
    doneRef.current = false;
    setStreamText('');
    startTyping();

    try {
      const finalChat = await apiStream(
        `/chats/${currentId}/messages/stream`,
        { content, attachments },
        { onDelta: (text) => { bufferRef.current += text; } },
      );
      // Ждём, пока дорисуется хвост, и только потом подменяем чат финальным —
      // иначе текст «прыгнул» бы, не успев допечататься.
      doneRef.current = true;
      await typingDoneRef.current;
      if (finalChat) setChat(finalChat);
      await refreshChats();
    } catch (e) {
      doneRef.current = true;
      setError(e.message);
      try {
        const { chat } = await api(`/chats/${currentId}`);
        setChat(chat);
      } catch {
        // ignore
      }
    } finally {
      doneRef.current = true;
      cancelAnimationFrame(rafRef.current);
      setStreamText('');
      setSending(false);
    }
  }

  async function changeModel(event) {
    const model = event.target.value;
    setChat((prev) => (prev ? { ...prev, model } : prev));
    try {
      await api(`/chats/${currentId}`, { method: 'PATCH', body: JSON.stringify({ model }) });
      await refreshChats();
    } catch (e) {
      setError(e.message);
    }
  }

  // Сохранить новое имя чата (пустое имя не сохраняем).
  async function renameChat(id, title) {
    setEditingId(null);
    const clean = title.trim();
    if (!clean) return;
    try {
      await api(`/chats/${id}`, { method: 'PATCH', body: JSON.stringify({ title: clean }) });
      await refreshChats();
      // Если переименовали открытый чат — обновим заголовок в шапке.
      setChat((prev) => (prev && prev.id === id ? { ...prev, title: clean } : prev));
    } catch (e) {
      setError(e.message);
    }
  }

  // Удалить чат (с подтверждением).
  async function deleteChat(id) {
    const target = chats.find((c) => c.id === id);
    if (!window.confirm(`Удалить чат «${target?.title || ''}»?`)) return;
    setError('');
    try {
      await api(`/chats/${id}`, { method: 'DELETE' });
      await refreshChats();
      // Если удалили открытый чат — вернёмся к пустому экрану.
      if (currentId === id) {
        setCurrentId(null);
        setChat(null);
      }
    } catch (e) {
      setError(e.message);
    }
  }

  // Текущая модель и предупреждение, если к «слепой» модели прикрепляют картинку.
  const currentModel = models.find((m) => m.id === chat?.model);
  const visionWarn =
    pending.some((a) => a.kind === 'image') &&
    !!currentModel?.capabilities &&
    !currentModel.capabilities.includes('vision');

  return (
    <div className="layout">
      <aside className="sidebar">
        <button className="new-chat" onClick={newChat}>
          + Новый чат
        </button>
        <nav className="chat-list">
          {chats.map((c) => (
            <div
              key={c.id}
              className={`chat-item ${c.id === currentId ? 'active' : ''}`}
              onClick={() => {
                if (!sending) setCurrentId(c.id);
              }}
              title={c.title}
            >
              {editingId === c.id ? (
                <input
                  className="chat-rename"
                  value={editTitle}
                  autoFocus
                  onChange={(e) => setEditTitle(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.target.blur();
                    if (e.key === 'Escape') {
                      cancelRenameRef.current = true;
                      e.target.blur();
                    }
                  }}
                  onBlur={() => {
                    if (cancelRenameRef.current) {
                      cancelRenameRef.current = false;
                      setEditingId(null);
                      return;
                    }
                    renameChat(c.id, editTitle);
                  }}
                />
              ) : (
                <>
                  <span className="chat-title">{c.title}</span>
                  <span className="chat-actions">
                    <button
                      className="icon-btn"
                      title="Переименовать"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(c.id);
                        setEditTitle(c.title);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className="icon-btn"
                      title="Удалить"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteChat(c.id);
                      }}
                    >
                      ×
                    </button>
                  </span>
                </>
              )}
            </div>
          ))}
          {chats.length === 0 && <p className="empty-hint">Пока нет чатов</p>}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <span className="topbar-label">Модель:</span>
          <select value={chat?.model || ''} onChange={changeModel} disabled={!chat}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {modelLabel(m)}
              </option>
            ))}
          </select>
        </header>

        <section className="messages" ref={messagesRef}>
          {!chat && <p className="placeholder">Создайте новый чат, чтобы начать общение.</p>}
          {chat?.messages?.length === 0 && <p className="placeholder">Напишите первое сообщение.</p>}
          {chat?.messages?.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              <div className="role">{m.role === 'user' ? 'Вы' : 'Модель'}</div>
              {!!m.attachments?.length && (
                <div className="attachments">
                  {m.attachments.map((a) => (
                    <AttachmentView key={a.id} a={a} />
                  ))}
                </div>
              )}
              {m.content && <div className="text">{m.content}</div>}
            </div>
          ))}
          {sending && (
            <div className="bubble assistant streaming">
              <div className="role">Модель</div>
              <div className="text">
                {streamText ? (
                  <>
                    {streamText}
                    <span className="cursor" />
                  </>
                ) : (
                  <span className="thinking">Модель думает…</span>
                )}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </section>

        {error && <div className="error">{error}</div>}

        <form className="composer" onSubmit={send}>
          <input ref={fileInputRef} type="file" multiple hidden onChange={pickFiles} />
          <button
            type="button"
            className="attach-btn"
            title="Прикрепить файл или фото"
            onClick={() => fileInputRef.current?.click()}
            disabled={!chat || sending || uploading}
          >
            {uploading ? '…' : '📎'}
          </button>

          <div className="composer-body">
            {!!pending.length && (
              <div className="pending">
                {pending.map((a) => (
                  <span key={a.id} className="pending-chip" title={a.name}>
                    {a.kind === 'image' ? (
                      <img className="chip-thumb" src={`/api/uploads/${a.id}`} alt={a.name} />
                    ) : (
                      <span className="att-icon">{FILE_ICON[a.kind] || '📎'}</span>
                    )}
                    <span className="pending-name">{a.name}</span>
                    <span className="att-size">{formatSize(a.size)}</span>
                    <button
                      type="button"
                      className="chip-remove"
                      title="Убрать"
                      onClick={() => removePending(a.id)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            {visionWarn && (
              <div className="hint">
                Модель «{currentModel?.name}» не видит картинки — выберите модель с 👁.
              </div>
            )}

            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) send(e);
              }}
              placeholder={chat ? 'Введите сообщение и нажмите Enter…' : 'Сначала создайте чат'}
              disabled={!chat || sending}
              rows={1}
            />
          </div>

          <button
            type="submit"
            disabled={!chat || sending || uploading || (!input.trim() && !pending.length)}
          >
            Отправить
          </button>
        </form>
      </main>
    </div>
  );
}
