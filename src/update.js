// 開いているアプリが公開中の最新版かを確かめる。
// ホーム画面から開くアプリ（PWA）は、裏に回っても閉じずに残り、戻ってきても読み込み直さないことがある。
// そこで開いたとき・前に出てきたときに version.json（build.mjs が書く）を取り、ビルドが違えば読み込み直す。

/* global __BUILD_INFO__ */
/** このアプリのビルド { id, sha, dirty, time }。npm start の開発用ルートなど、ビルドしていないときは null */
export const BUILD = typeof __BUILD_INFO__ === 'object' ? __BUILD_INFO__ : null;

/** 公開中の版。取れなければ（電波がない・開発用のルート）null */
export async function latestBuild() {
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const v = await res.json();
    return typeof v?.id === 'string' ? v : null;
  } catch {
    return null;
  }
}

// 読み込み直しても同じ古い版が返ってくる（配信が行き渡る前など）と、読み込み直しを繰り返してしまう。
// 一度読み込み直した先の版を覚えておき、同じ版のためには2度は読み込み直さない
const TRIED = 'flubato.updateTried';

/** 新しい版のために読み込み直してよいか（同じ版のためにまだ読み込み直していない） */
export function shouldReload(latest) {
  try { return sessionStorage.getItem(TRIED) !== latest.id; } catch { return true; }
}

/** 新しい版を読み込む。service worker も新しくしてから読み込み直す */
export async function reloadTo(latest) {
  try { sessionStorage.setItem(TRIED, latest.id); } catch { /* 覚えられなくても読み込み直す */ }
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => null);
  await reg?.update().catch(() => {});
  location.reload();
}

/** 版の見出し（commit の短縮ハッシュと、ビルドした日時を手元の時刻で） */
export function describeBuild(b) {
  const d = new Date(b.time);
  const p = n => String(n).padStart(2, '0');
  const when = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return { commit: `${b.sha.slice(0, 7) || 'unknown'}${b.dirty ? '+dirty' : ''}`, when };
}
