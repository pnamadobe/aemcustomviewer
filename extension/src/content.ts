import { ASSETS_VIEW_FRAME, DEBUG } from './config';
import { HANDSHAKE_EVENT, randomChannel, type AuthSnapshot, type BridgeMsg } from './bridge';
import { readAuthFromSessionStorage } from './auth';
import { watchRoute } from './router';
import { getMetadata, getOriginal, fetchArrayBufferWithProgress } from './assets-api';
import { waitForPreview, mountOverlay, type Overlay } from './overlay';
import { pickViewer } from './viewers';

const log = (...a: unknown[]) => DEBUG && console.debug('[acv]', ...a);

if (ASSETS_VIEW_FRAME(location)) {
  (window as any).__acvDispose?.();
  let auth: AuthSnapshot | null = null;
  const authWaiters: ((a: AuthSnapshot) => void)[] = [];
  const channel = randomChannel();

  document.addEventListener(channel, (e) => {
    try {
      const msg = JSON.parse((e as CustomEvent).detail) as BridgeMsg;
      if (msg.type === 'auth') {
        auth = msg.data;
        authWaiters.splice(0).forEach((w) => w(msg.data));
      }
    } catch {
      /* ignore */
    }
  });
  document.dispatchEvent(new CustomEvent(HANDSHAKE_EVENT, { detail: channel }));

  const getAuth = (signal: AbortSignal): Promise<AuthSnapshot> => {
    const fromSS = readAuthFromSessionStorage();
    if (fromSS) {
      auth = fromSS;
      return Promise.resolve(fromSS);
    }
    if (auth) return Promise.resolve(auth);
    return new Promise<AuthSnapshot>((res, rej) => {
      authWaiters.push(res);
      signal.addEventListener('abort', () => rej(signal.reason));
    });
  };

  let session: { ctl: AbortController; overlay?: Overlay; dispose?: () => void } | null = null;

  const teardown = () => {
    if (!session) return;
    session.ctl.abort();
    try {
      session.dispose?.();
    } catch {}
    session.overlay?.dispose();
    session = null;
  };

  const open = async (damPath: string) => {
    teardown();
    const ctl = new AbortController();
    session = { ctl };
    const s = session;
    try {
      const a = await getAuth(ctl.signal);
      const meta = await getMetadata(a, damPath, ctl.signal);
      const plugin = pickViewer(meta);
      if (!plugin) return log('unsupported format, leaving native preview intact:', meta.mime, meta.name);

      const container = await waitForPreview(ctl.signal);
      const overlay = mountOverlay(container);
      s.overlay = overlay;
      overlay.setMeta(plugin.badge, meta.name);

      const currentAuth = () => readAuthFromSessionStorage() ?? auth ?? a;

      s.dispose = await plugin.mount({
        meta,
        container: overlay.body,
        signal: ctl.signal,
        fetchBuffer: (onProgress) => fetchArrayBufferWithProgress(currentAuth(), meta, ctl.signal, onProgress),
        fetchRange: async (start, end) => {
          const r = await getOriginal(currentAuth(), meta, { range: [start, end], signal: ctl.signal });
          return new Uint8Array(await r.arrayBuffer());
        },
        setStatus: overlay.setStatus,
        setActions: overlay.setActions,
        setProgress: overlay.setProgress,
      });
      log('mounted viewer plugin', plugin.id, 'for', meta.damPath);
    } catch (err) {
      log('fail-safe teardown', err);
      if (session === s) teardown();
    }
  };

  const start = () => {
    const stopRoute = watchRoute((r) => (r.kind === 'details' ? open(r.damPath) : teardown()));
    (window as any).__acvDispose = () => {
      stopRoute();
      teardown();
    };
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start, { once: true }) : start();
}
