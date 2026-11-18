import { DAM_PATH_PATTERNS } from './config';

export type RouteEvent = { kind: 'details'; damPath: string } | { kind: 'other' };

export function damPathFromUrl(href = location.href): string | null {
  for (const re of DAM_PATH_PATTERNS) {
    const m = href.match(re);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

export function watchRoute(cb: (e: RouteEvent) => void): () => void {
  let last = '';
  const check = () => {
    if (location.href === last) return;
    last = location.href;
    const damPath = damPathFromUrl();
    cb(damPath ? { kind: 'details', damPath } : { kind: 'other' });
  };
  addEventListener('popstate', check);
  addEventListener('hashchange', check);
  const t = setInterval(check, 300);
  check();
  return () => {
    clearInterval(t);
    removeEventListener('popstate', check);
    removeEventListener('hashchange', check);
  };
}
