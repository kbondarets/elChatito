// Запасной DNS через DNS-over-HTTPS (DoH).
//
// Бывает, что провайдер «глушит» обычный DNS: запросы на 53-й порт (UDP и TCP)
// просто не получают ответа, и тогда apimira.com «не находится», хотя сам сервер
// при этом доступен напрямую. Здесь мы добавляем обходной путь: если системный
// резолвер не справился, спрашиваем адрес по DNS-over-HTTPS — это обычный HTTPS
// на 443-м порту, который почти никогда не блокируют.
//
// Мы аккуратно надстраиваем dns.lookup, поэтому запасной путь работает и для
// fetch (undici), и для любых других сетевых запросов этого процесса. Если
// обычный DNS отвечает — поведение не меняется вообще.
//
// Выключить можно в .env: doh_enabled=0.
import dns from 'node:dns';
import https from 'node:https';

const ENABLED = process.env.doh_enabled !== '0';
// Адрес DoH-сервера. Важно: в нём должен стоять IP, а не имя, — иначе мы
// упрёмся в тот же сломанный DNS.
const SERVER = (process.env.doh_server || 'https://1.1.1.1/dns-query').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.doh_timeout_ms) || 5000;
const CACHE_TTL_MS = Number(process.env.doh_cache_ttl_ms) || 5 * 60 * 1000;

const cache = new Map(); // имя -> { answers: [{ address, family }], at }
const inflight = new Map(); // имя -> Promise (чтобы не спрашивать дважды)
let warnedOnce = false;

// Спрашиваем адреса у DoH-сервера. Возвращаем [{ address, family }].
export async function resolveViaDoh(hostname) {
  const cached = cache.get(hostname);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.answers;
  if (inflight.has(hostname)) return inflight.get(hostname);

  const task = dohRequest(hostname)
    .then((answers) => {
      if (answers.length) cache.set(hostname, { answers, at: Date.now() });
      return answers;
    })
    .finally(() => inflight.delete(hostname));

  inflight.set(hostname, task);
  return task;
}

function dohRequest(hostname) {
  const url = new URL(SERVER);
  const path = `${url.pathname}?name=${encodeURIComponent(hostname)}&type=A`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: url.hostname,
        port: url.port || 443,
        path,
        method: 'GET',
        // Cloudflare и Google отдают ответ в JSON при таком accept.
        headers: { accept: 'application/dns-json' },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`DoH: HTTP ${res.statusCode}`));
          try {
            const data = JSON.parse(body);
            const answers = (Array.isArray(data?.Answer) ? data.Answer : [])
              .filter((a) => a.type === 1 && typeof a.data === 'string')
              .map((a) => ({ address: a.data, family: 4 }));
            resolve(answers);
          } catch (err) {
            reject(new Error(`DoH: некорректный ответ (${err.message})`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('DoH: таймаут')));
    req.on('error', reject);
    req.end();
  });
}

function install() {
  const originalLookup = dns.lookup.bind(dns);

  dns.lookup = function lookupWithDoh(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    } else if (typeof options === 'number') {
      options = { family: options };
    }
    const opts = options || {};

    originalLookup(hostname, opts, (err, address, family) => {
      // Обычный DNS ответил — ничего не меняем.
      if (!err) return callback(null, address, family);

      resolveViaDoh(hostname)
        .then((answers) => {
          if (!answers.length) return callback(err, address, family);
          if (!warnedOnce) {
            warnedOnce = true;
            console.warn(`Обычный DNS не ответил — беру адрес через DoH (${SERVER}).`);
          }
          // undici (fetch) запрашивает сразу все адреса: all: true.
          if (opts.all) {
            return callback(
              null,
              answers.map((a) => ({ address: a.address, family: a.family })),
            );
          }
          callback(null, answers[0].address, answers[0].family);
        })
        .catch(() => callback(err, address, family));
    });
  };
}

if (ENABLED) install();
