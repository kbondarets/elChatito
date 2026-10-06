import { useEffect, useRef, useState } from 'react';
import { api, apiStream, uploadFile, generateImage, editImage } from './api.js';

// Человеческие подписи для типов моделей (тип приходит из /v1/account/pricing).
const TYPE_LABEL = { chat: 'чат', image: 'картинки', video: 'видео', embedding: 'эмбеддинги' };
// Модели с capability "vision" видят картинки — помечаем глазом,
// а с "image_edit" — умеют править готовую картинку (помечаем кистью).
const modelLabel = (m) => {
  const marks = `${m.capabilities?.includes('vision') ? '👁 ' : ''}${m.capabilities?.includes('image_edit') ? '🖌 ' : ''}`;
  return `${marks}${m.name} · ${TYPE_LABEL[m.type] || m.type}`;
};

// Размеры кадра для правки картинки (для генерации размер выбирает модель сама).
const EDIT_SIZES = [
  { value: 'auto', label: 'как на фото' },
  { value: '1024x1024', label: 'квадрат' },
  { value: '1024x1536', label: 'вертикальный' },
  { value: '1536x1024', label: 'горизонтальный' },
];

const FILE_ICON = { pdf: '📕', docx: '📘', text: '📄', image: '🖼️' };

function formatSize(bytes) {
  if (typeof bytes !== 'number') return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

// Морда кота — символ elChatito. Силуэт белый (цвет = цвет текста), а глаза,
// нос и рот «вырезаны» цветом панели — поэтому морда читается на тёмном фоне.
function ChatitoLogo({ size = 26 }) {
  return (
    <svg
      className="logo-cat"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="el chatito"
    >
      {/* уши */}
      <path d="M13 32 L11 7 L32 19 Z" fill="currentColor" />
      <path d="M51 32 L53 7 L32 19 Z" fill="currentColor" />
      {/* голова */}
      <circle cx="32" cy="38" r="21" fill="currentColor" />
      {/* глаза */}
      <circle cx="24" cy="36" r="3.4" fill="var(--panel)" />
      <circle cx="40" cy="36" r="3.4" fill="var(--panel)" />
      {/* нос и рот */}
      <path d="M28.5 43 H35.5 L32 47.5 Z" fill="var(--panel)" />
      <path
        d="M32 47.5 V50 M32 50 q-4.5 4.5 -9 1 M32 50 q4.5 4.5 9 1"
        stroke="var(--panel)"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

// Обычная контурная скрепка — в отличие от эмодзи 📎 её хорошо видно.
function PaperclipIcon({ size = 24 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

// Вложение в пузыре сообщения: картинку показываем превью, остальное — плашкой.
// onEdit (если передан) добавляет кнопку «изменить» под картинкой.
function AttachmentView({ a, onEdit }) {
  const url = `/api/uploads/${a.id}`;
  if (a.kind === 'image') {
    return (
      <div className="att-image-wrap">
        <a className="att-image" href={url} target="_blank" rel="noreferrer" title={a.name}>
          <img src={url} alt={a.name} />
        </a>
        {onEdit && (
          <button type="button" className="att-edit" title="Изменить эту картинку" onClick={() => onEdit(a)}>
            🖌 Изменить
          </button>
        )}
      </div>
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
  // Параметры генерации/правки картинок: сколько кадров и какой размер кадра.
  const [genCount, setGenCount] = useState(1);
  const [editSize, setEditSize] = useState('auto');
  // Режим композера для моделей типа «картинки»: 'generate' или 'edit'.
  const [imageMode, setImageMode] = useState('generate');
  const textareaRef = useRef(null);
  // Подсвечиваем область чата, когда файл тащат в окно.
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);

  // При старте: список моделей и список чатов, а затем сразу открываем чат —
  // верхний в списке (последний по времени) или новый, если чатов ещё нет.
  // Так после запуска можно печатать сразу, не нажимая «+ Новый чат».
  // bootstrappedRef защищает от повторного запуска: в StrictMode React в режиме
  // разработки прогоняет эффекты дважды, и без защиты создалось бы два чата.
  const bootstrappedRef = useRef(false);
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    (async () => {
      try {
        const [m, c] = await Promise.all([api('/models'), api('/chats')]);
        const modelList = m.models || [];
        const chatList = c.chats || [];
        setModels(modelList);
        setChats(chatList);
        if (chatList.length) {
          setCurrentId(chatList[0].id);
        } else {
          await createChat(modelList);
        }
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

  // Гасим «браузерное» поведение: без этого файл, брошенный мимо зоны, открылся бы в окне.
  useEffect(() => {
    const block = (e) => e.preventDefault();
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

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

  // Создать чат и сразу его открыть. Список моделей принимаем аргументом:
  // при старте приложения состояние models ещё не успевает обновиться.
  async function createChat(modelList, preferredModel) {
    const model =
      preferredModel || modelList?.find((m) => m.type === 'chat')?.id || modelList?.[0]?.id;
    const { chat: created } = await api('/chats', {
      method: 'POST',
      body: JSON.stringify({ model }),
    });
    await refreshChats();
    setCurrentId(created.id);
    return created;
  }

  // Загружаем файлы по одному (чтобы показать ошибку по конкретному файлу).
  // Один путь и для кнопки-скрепки, и для перетаскивания, и для вставки из буфера.
  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!currentId) {
      setError('Сначала создайте чат.');
      return;
    }
    if (sending || uploading) return;
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

  function pickFiles(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = ''; // иначе нельзя выбрать тот же файл повторно
    uploadFiles(files);
  }

  // Ctrl+V: если в буфере картинка/файл — прикрепляем его, иначе вставляется текст.
  function pasteFiles(event) {
    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length) {
      event.preventDefault();
      uploadFiles(files);
    }
  }

  // Перетаскивание: подсвечиваем зону, а на drop забираем файлы.
  function dragOver(event) {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault(); // без этого браузер откроет файл вместо загрузки
    setDragging(true);
  }

  function dragLeave(event) {
    // Уходим только когда курсор покинул саму зону, а не её дочерние элементы.
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDragging(false);
  }

  function dropFiles(event) {
    event.preventDefault();
    setDragging(false);
    uploadFiles(event.dataTransfer?.files);
  }

  function removePending(id) {
    setPending((prev) => prev.filter((a) => a.id !== id));
  }

  // Общая обёртка для генерации и правки: блокируем ввод, гоняем запрос,
  // подменяем чат ответом сервера и обновляем список чатов.
  async function runImageJob(work) {
    if (!currentId || sending || uploading) return;
    setError('');
    setSending(true);
    try {
      const { chat: updated } = await work();
      if (updated) setChat(updated);
      await refreshChats();
    } catch (e) {
      setError(e.message);
      // Покажем актуальную переписку (сообщение пользователя уже сохранено).
      try {
        const { chat: fresh } = await api(`/chats/${currentId}`);
        setChat(fresh);
      } catch {
        // ignore
      }
    } finally {
      setSending(false);
    }
  }

  // Сгенерировать картинку по промпту (модель типа «картинки»).
  function generate(event) {
    event?.preventDefault();
    const prompt = input.trim();
    if (!prompt) return;
    setInput('');
    runImageJob(() => generateImage({ chatId: currentId, model: chat?.model, prompt, n: genCount }));
  }

  // Правка: берём выбранные картинки (pending) и описание — что с ними сделать.
  function submitEdit(event) {
    event?.preventDefault();
    const prompt = input.trim();
    const images = pending.filter((a) => a.kind === 'image');
    if (!prompt || !images.length) return;
    setInput('');
    setPending([]);
    runImageJob(() =>
      editImage({
        chatId: currentId,
        model: chat?.model,
        prompt,
        attachments: images.map((a) => a.id),
        n: genCount,
        size: editSize,
      }),
    );
  }

  // Кнопка «Изменить» под картинкой: подставляем её в поле ввода и переключаем режим.
  function startEdit(a) {
    setError('');
    setInput('');
    setPending([a]);
    setImageMode('edit');
    // Фокус в поле ввода, чтобы сразу писать, что изменить.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  // Переключение режима работы (только для моделей типа «картинки»).
  function switchImageMode(mode) {
    if (mode === imageMode) return;
    setImageMode(mode);
    setInput('');
    setPending([]);
    setError('');
  }

  async function newChat() {
    if (sending) return; // не переключаемся, пока модель печатает
    setError('');
    try {
      // Модель берём из текущего чата, а если чата нет — первую чат-модель.
      await createChat(models, chat?.model);
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
    // Модели типа «картинки» работают не как чат: это генерация или правка картинки.
    const activeModel = models.find((m) => m.id === chat?.model);
    if (activeModel?.type === 'image') {
      if (imageMode === 'edit') submitEdit(event);
      else generate(event);
      return;
    }

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
    // Смена модели сбрасывает режим картинок (нарисовать/изменить) и вложения.
    setImageMode('generate');
    setPending([]);
    setInput('');
    setError('');
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
      // Удалили открытый чат — открываем следующий, а если чатов не осталось,
      // создаём новый: экран без открытого чата выглядит как поломка.
      if (currentId === id) {
        const rest = chats.filter((c) => c.id !== id);
        setChat(null); // не показываем сообщения удалённого чата
        if (rest.length) setCurrentId(rest[0].id);
        else await createChat(models);
      }
    } catch (e) {
      setError(e.message);
    }
  }

  // Текущая модель и предупреждение, если к «слепой» модели прикрепляют картинку.
  const currentModel = models.find((m) => m.id === chat?.model);
  const visionWarn =
    pending.some((a) => a.kind === 'image') &&
    currentModel?.type !== 'image' &&
    !!currentModel?.capabilities &&
    !currentModel.capabilities.includes('vision');

  // Модель типа «картинки»: композер превращается в генератор/редактор.
  const isImageModel = currentModel?.type === 'image';
  const canEdit = !!currentModel?.capabilities?.includes('image_edit');
  const editMode = isImageModel && imageMode === 'edit';
  const pendingImages = pending.filter((a) => a.kind === 'image');
  // Правка требует хотя бы одну картинку; генерация — только промпт.
  const canSubmit = editMode
    ? !!input.trim() && pendingImages.length > 0
    : isImageModel
      ? !!input.trim()
      : !!input.trim() || pending.length > 0;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand" title="el chatito">
          <ChatitoLogo size={30} />
          <span className="brand-name">el chatito</span>
        </div>

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
          {!chat && <p className="placeholder">Открываем чат…</p>}
          {chat?.messages?.length === 0 && <p className="placeholder">Напишите первое сообщение.</p>}
          {chat?.messages?.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              <div className="role">{m.role === 'user' ? 'Вы' : 'Модель'}</div>
              {!!m.attachments?.length && (
                <div className="attachments">
                  {m.attachments.map((a) => (
                    <AttachmentView key={a.id} a={a} onEdit={canEdit ? startEdit : undefined} />
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

        <form
          className={`composer ${dragging ? 'dragging' : ''}`}
          onSubmit={send}
          onDragOver={dragOver}
          onDragLeave={dragLeave}
          onDrop={dropFiles}
        >
          <input ref={fileInputRef} type="file" multiple hidden onChange={pickFiles} />

          <div className="composer-body">
            {isImageModel && (
              <div className="mode-row">
                <div className="mode-tabs">
                  <button
                    type="button"
                    className={`mode-tab ${imageMode === 'generate' ? 'active' : ''}`}
                    onClick={() => switchImageMode('generate')}
                  >
                    Нарисовать
                  </button>
                  <button
                    type="button"
                    className={`mode-tab ${imageMode === 'edit' ? 'active' : ''}`}
                    onClick={() => switchImageMode('edit')}
                    disabled={!canEdit}
                    title={canEdit ? 'Изменить готовую картинку' : 'Эта модель не умеет править картинки'}
                  >
                    Изменить
                  </button>
                </div>

                {editMode ? (
                  <>
                    <label className="param">
                      Размер
                      <select value={editSize} onChange={(e) => setEditSize(e.target.value)}>
                        {EDIT_SIZES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="param">
                      Кадров
                      <select value={genCount} onChange={(e) => setGenCount(Number(e.target.value))}>
                        {[1, 2, 3, 4].map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : (
                  <label className="param">
                    Кадров
                    <select value={genCount} onChange={(e) => setGenCount(Number(e.target.value))}>
                      {[1, 2, 3, 4].map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}

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

            {editMode && !pendingImages.length && (
              <div className="hint">
                Прикрепите картинку скрепкой, перетаскиванием или Ctrl+V — и опишите, что изменить.
              </div>
            )}

            <div className="composer-row">
              <button
                type="button"
                className="attach-btn"
                title="Прикрепить файл или фото"
                onClick={() => fileInputRef.current?.click()}
                disabled={!chat || sending || uploading}
              >
                {uploading ? '…' : <PaperclipIcon size={24} />}
              </button>

              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={pasteFiles}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) send(e);
                }}
                placeholder={
                  editMode
                    ? 'Опишите, что изменить на картинке…'
                    : isImageModel
                      ? 'Опишите, что нарисовать…'
                      : 'Введите сообщение и нажмите Enter…'
                }
                disabled={!chat || sending}
                rows={1}
              />

              <button
                type="submit"
                className="send-btn"
                disabled={!chat || sending || uploading || !canSubmit}
              >
                {editMode ? 'Изменить' : isImageModel ? 'Нарисовать' : 'Отправить'}
              </button>
            </div>
          </div>

          {dragging && (
            <div className="drop-overlay">
              <span>Отпустите файлы, чтобы прикрепить</span>
            </div>
          )}
        </form>
      </main>
    </div>
  );
}
