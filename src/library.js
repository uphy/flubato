// 開いた曲のファイルをブラウザに取っておく（ライブラリ）。次からはファイルを選ばずに開ける。
// ファイルは数百KB〜数MBあり、localStorage（文字列だけ・合わせて5MBほど）には収まらないので IndexedDB に置く。
// 同じ中身のファイルは、名前が違っても1曲として扱う（id は中身から作る）。

const DB = 'flubato', STORE = 'songs';

let dbp = null;
function db() {
  dbp ??= new Promise((ok, ng) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => ok(req.result);
    req.onerror = () => ng(req.error);
  });
  return dbp;
}

async function run(mode, fn) {
  const tx = (await db()).transaction(STORE, mode);
  const req = fn(tx.objectStore(STORE));
  return new Promise((ok, ng) => {
    tx.oncomplete = () => ok(req?.result);
    tx.onerror = tx.onabort = () => ng(tx.error);
  });
}

/** ファイルの中身から id を作る（FNV-1a を2通りの初期値で回した 64bit ぶん + 長さ） */
export function songId(bytes) {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul(b ^ bytes[i], 0x01000193) ^ (b >>> 15);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}-${bytes.length}`;
}

/** 保存した曲の一覧（最近開いた順）。中身（bytes）は含めない */
export async function listSongs() {
  const all = await run('readonly', s => s.getAll());
  return all.map(({ bytes, ...meta }) => ({ ...meta, size: bytes.length })).sort((x, y) => y.openedAt - x.openedAt);
}

export const getSong = id => run('readonly', s => s.get(id));

/** 曲を足す。同じ中身がすでにあれば、開いた日時だけ新しくする（トラックの選択は残す） */
export async function saveSong({ name, title, bytes }) {
  const id = songId(bytes), now = Date.now();
  const old = await getSong(id);
  await run('readwrite', s => s.put({ ...old, id, name, title, bytes, addedAt: old?.addedAt ?? now, openedAt: now }));
  // 空き容量が足りなくなってもブラウザに消されないよう頼む（断られても保存はできている）
  navigator.storage?.persist?.().catch(() => {});
  return id;
}

/** 開いた日時・トラックなど、中身以外を書き換える */
export async function touchSong(id, patch) {
  const old = await getSong(id);
  if (old) await run('readwrite', s => s.put({ ...old, ...patch }));
}

export const removeSong = id => run('readwrite', s => s.delete(id));

/** 保存した曲をすべて消す（データベースごと） */
export async function clearSongs() {
  if (dbp) { (await dbp.catch(() => null))?.close(); dbp = null; }
  await new Promise((ok, ng) => {
    const req = indexedDB.deleteDatabase(DB);
    req.onsuccess = () => ok();
    req.onerror = () => ng(req.error);
    req.onblocked = () => ok(); // 別のタブが開いていると、そのタブを閉じたときに消える
  });
}
