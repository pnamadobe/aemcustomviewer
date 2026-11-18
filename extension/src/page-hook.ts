// MAIN world, document_start. Captures auth from the app's own API calls.
// Token is held in a closure only; never logged, never persisted.
import { API_ORIGIN_PATTERN } from './config';
import { HANDSHAKE_EVENT, type AuthSnapshot } from './bridge';

(() => {
  let latest: AuthSnapshot | null = null;
  let channel: string | null = null;
  const KEEP = ['x-api-key', 'x-gw-ims-org-id', 'x-adobe-accept-experimental'];

  const record = (url: string, h: Headers) => {
    if (!API_ORIGIN_PATTERN.test(url)) return;
    const authorization = h.get('authorization');
    if (!authorization?.startsWith('Bearer ')) return;
    const headers: Record<string, string> = {};
    for (const k of KEEP) { const v = h.get(k); if (v) headers[k] = v; }
    latest = { authorization, apiBase: new URL(url).origin, headers };
    emit();
  };

  const emit = () => {
    if (channel && latest) document.dispatchEvent(new CustomEvent(channel, { detail: JSON.stringify({ type: 'auth', data: latest }) }));
  };

  const origFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    try {
      const url = input instanceof Request ? input.url : String(input);
      const h = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers) new Headers(init.headers).forEach((v, k) => h.set(k, v));
      record(url, h);
    } catch { /* never break the host app */ }
    return origFetch.apply(this, [input, init] as any);
  };

  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.setRequestHeader, xsend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m: string, u: string | URL, ...r: any[]) { (this as any).__acvUrl = String(u); (this as any).__acvH = new Headers(); return (xo as any).call(this, m, u, ...r); };
  XMLHttpRequest.prototype.setRequestHeader = function (k: string, v: string) { try { (this as any).__acvH?.set(k, v); } catch {} return xs.call(this, k, v); };
  XMLHttpRequest.prototype.send = function (b?: any) { try { record((this as any).__acvUrl, (this as any).__acvH); } catch {} return xsend.call(this, b); };

  // One-time handshake: ISOLATED world announces its random channel.
  document.addEventListener(HANDSHAKE_EVENT, (e) => {
    if (channel) return;
    const c = (e as CustomEvent).detail;
    if (typeof c === 'string' && c.startsWith('__acv_')) { channel = c; emit(); }
  });
})();
