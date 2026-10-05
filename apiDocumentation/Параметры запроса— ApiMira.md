

## 
## Документация
Параметры запроса
Тело POST /v1/chat/completions. Обязательны только model и messages — всё
остальное можно не передавать, у каждого поля есть разумное значение по
умолчанию.
ПолеТип
modelобязательно
string
messagesобязательно
array
stream
boolean
Быстрый стартПодключение программЧатПараметры запросаКарти
10/5/26, 7:56 PMДокументация — ApiMira
https://apimira.com/docs#params1/5

ПолеТип
temperature
## 0 ... 2
top_p
## 0 ... 1
max_tokens
## ≥ 1 (max 32 000)
max_completion_tokens
## ≥ 1 (max 32 000)
stop
string | string[]
stream_options
object
tools
array (≤ 128)
tool_choice
string | object
RU₽Кабинет
10/5/26, 7:56 PMДокументация — ApiMira
https://apimira.com/docs#params2/5

ПолеТип
reasoning_effort
none | minimal | low | medium | high | xhigh | max
user
string
Эти параметры шлюз отклоняет
functions, response_format, audio, modalities — ответ 400 с кодом
unsupported_parameter. Отказ намеренный: молча проигнорировать параметр и
выставить счёт за ответ, полученный не по вашим правилам, хуже честной
ошибки.
Что приходит в ответе
Формат совпадает с OpenAI, поэтому официальные SDK разбирают его без
переделок.
10/5/26, 7:56 PMДокументация — ApiMira
https://apimira.com/docs#params3/5

ПолеТипЧто делает
idstring
## Идентификатор
запроса. Его
стоит
приложить к
обращению в
поддержку.
modelstring
ID модели,
которая
ответила.
choices[].message.contentstring | null
Текст ответа.
null, если
модель вместо
текста вызвала
инструмент.
choices[].message.tool_callsarray
## Вызовы
функций, если
модель их
сделала.
choices[].finish_reasonstring
## Почему
генерация
закончилась:
stop — модель
договорила,
length —
упёрлась в
max_tokens,
tool_calls —
зовёт
инструмент.
usage.prompt_tokensnumber
## Входные
токены — по
ним считается
первая
10/5/26, 7:56 PMДокументация — ApiMira
https://apimira.com/docs#params4/5

ПолеТипЧто делает
половина
счёта.
usage.prompt_tokens_details.cached_tokensnumber
## Сколько
входных
токенов
пришло из
кэша — они
уже входят в
prompt_tokens;
у моделей со
ставкой кэш-
входа
посчитаны по
льготной
ставке.
usage.completion_tokensnumber
## Выходные
токены —
вторая
половина
счёта.
usage.total_tokensnumber
Сумма входных
и выходных.
Модели и ценыДокументацияСтатус серверовОбновленияFAQ
ОфертаКонфиденциальностьМагазин пополнений
Единая точка доступа к LLM-моделям© 2026 ApiMira
10/5/26, 7:56 PMДокументация — ApiMira
https://apimira.com/docs#params5/5