// Service Worker: アプリ本体をプリキャッシュして、オフラインでも動かす。
// ファイルを足したら ASSETS に追加すること（tests/pwa.test.js が一覧の漏れを検査する）。
// 既存ファイルの変更は、次の起動で自動的に取り直される。キャッシュ構成を変えるときだけ CACHE を上げる。
const CACHE = 'mix-analyzer-v1';
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'fonts/archivo-latin-variable.woff2',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'src/main.js',
  'src/worker.js',
  'src/dsp/fft.js',
  'src/dsp/kfilter.js',
  'src/dsp/loudness.js',
  'src/dsp/truepeak.js',
  'src/dsp/welch.js',
  'src/dsp/bands.js',
  'src/dsp/pipeline.js',
  'src/decode/wav.js',
  'src/decode/sniff.js',
  'src/decode/webaudio.js',
  'src/explain/readings.js',
  'src/explain/glossary.js',
  'src/score/criteria.js',
  'src/score/score.js',
  'src/render/charts.js',
  'src/render/report.js',
  'src/i18n/index.js',
  'src/i18n/ja.js',
  'src/i18n/ja_explain.js',
  'src/i18n/en.js',
  'src/i18n/en_explain.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// キャッシュを即座に返し、裏で取り直して次回に反映する（stale-while-revalidate）。
// バージョン番号の上げ忘れがあっても、次の起動で新しいファイルに切り替わる。オフラインではキャッシュだけで動く。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const update = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (hit) {
        event.waitUntil(update);
        return hit;
      }
      const res = await update;
      if (res) return res;
      return req.mode === 'navigate' ? (await cache.match('index.html')) || Response.error() : Response.error();
    }),
  );
});
