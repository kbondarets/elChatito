

## 
## Документация
## Эндпоинты
POST/v1/chat/completions
Генерация ответа модели. Поддерживает stream=true (SSE). Формат запроса и
ответа — как у OpenAI.
GET/v1/models
Список доступных моделей в формате OpenAI. Отключённые модели не
возвращаются.
POST/v1/images/generations
Синхронная генерация изображений (OpenAI Images-совместимо). Кадр
приходит в base64.
POST/v1/images/edits
Редактирование готовой картинки по описанию: multipart/form-data на входе,
кадр в base64 на выходе.
POST/v1/videos/generations
Быстрый стартПодключение программЧатПараметры запросаКарти
10/5/26, 8:22 PMДокументация — ApiMira
https://apimira.com/docs#endpoints1/3

Создание задачи генерации видео. Тариф посекундный, параметр seconds
обязателен; ответ — задача со status processing.
GET/v1/jobs/{id}
Статус задачи генерации. processing — ещё идёт, succeeded — готово (в ответе
url ролика), failed — не вышло (деньги не списаны).
POST/v1/messages
Родной протокол Anthropic — совместим с Claude Code и Anthropic SDK без
переделок. Авторизация как у родных клиентов: заголовок x-api-key (Bearer
тоже принимается). Стриминг (SSE) и вызовы инструментов поддержаны;
max_tokens обязателен.
POST/v1/messages/count_tokens
Оценка числа входных токенов без обращения к модели — не точное число и не
расходует баланс.
POST/v1/responses
Формат OpenAI Responses API — совместим с Codex CLI и SDK OpenAI без
переделок. Stateless: историю шлёт клиент, previous_response_id не
поддерживается, ответы по id не хранятся (GET и DELETE — 404). Инструменты
function и стрим (SSE) поддержаны.
GET/v1/account/{balance,pricing,usage,analytics}
Read-only API аккаунта: баланс, розничные цены, детализация и аналитика
ключа. Подробности — в разделе «Account API».
Модели и ценыДокументацияСтатус серверовОбновленияFAQ
ОфертаКонфиденциальностьМагазин пополнений
RU₽Кабинет
10/5/26, 8:22 PMДокументация — ApiMira
https://apimira.com/docs#endpoints2/3

Единая точка доступа к LLM-моделям© 2026 ApiMira
10/5/26, 8:22 PMДокументация — ApiMira
https://apimira.com/docs#endpoints3/3