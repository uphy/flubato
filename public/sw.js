// ホーム画面から開くアプリ（PWA）にするための service worker。
// アプリは dist/index.html の1枚で完結しているので、それとアイコンを手元に置けば電波がなくても開ける。
// 開くたびにまずネットから取り、取れたら手元の控えを差し替える。取れないときだけ控えを出す。
// こうしておけば、公開した新しい版は次に開いたときにそのまま届く。
// ブラウザの HTTP キャッシュに古い版が残っていても使わないよう、ネットから取るときは必ずサーバに確かめる（no-cache）。
const CACHE = 'flubato';
const FILES = ['./', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // 公開中の版を確かめるファイルは控えを作らない（電波がないときに古い控えを「最新」と取り違えない）
  if (url.pathname.endsWith('/version.json')) return;
  // 画面そのもの（index.html）は URL の ? 以降に関係なく同じ控えを使う
  const key = req.mode === 'navigate' ? './' : req;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) await cache.put(key, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(key, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
