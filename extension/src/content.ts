import { ASSETS_VIEW_FRAME, DEBUG } from './config';
import { HANDSHAKE_EVENT, randomChannel, type AuthSnapshot, type BridgeMsg } from './bridge';
import { readAuthFromSessionStorage } from './auth';
import { getSettings, loadSettings, subscribeSettings } from './settings';
import { watchRoute, damPathFromUrl } from './router';
import { getMetadata, getOriginal, fetchArrayBufferWithProgress } from './assets-api';
import { waitForPreview, mountOverlay, type Overlay } from './overlay';
import { pickViewer } from './viewers';
import { saveThumbnail, clearAllThumbnails } from './thumbnails/store';
import { startCardThumbnailObserver } from './thumbnails/card-observer';

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

  const currentSyncAuth = (): AuthSnapshot | null => {
    const fromSS = readAuthFromSessionStorage();
    if (fromSS) auth = fromSS;
    return auth;
  };

  const getAuth = (signal: AbortSignal): Promise<AuthSnapshot> => {
    const sync = currentSyncAuth();
    if (sync) return Promise.resolve(sync);
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
    const settings = getSettings();
    if (!settings.enabled || !settings.detailsViewer) return;

    const ctl = new AbortController();
    session = { ctl };
    const s = session;
    try {
      const a = await getAuth(ctl.signal);
      const meta = await getMetadata(a, damPath, ctl.signal);
      const plugin = pickViewer(meta);
      if (!plugin) return log('unsupported or disabled format, leaving native preview intact:', meta.mime, meta.name);

      const container = await waitForPreview(ctl.signal);
      const overlay = mountOverlay(container);
      s.overlay = overlay;
      overlay.setMeta(plugin.badge, meta.name);

      const currentAuth = () => currentSyncAuth() ?? a;

      s.dispose = await plugin.mount({
        meta,
        container: overlay.body,
        signal: ctl.signal,
        fetchBuffer: (onProgress) => fetchArrayBufferWithProgress(currentAuth(), meta, ctl.signal, onProgress),
        fetchResponse: () => getOriginal(currentAuth(), meta, { signal: ctl.signal }),
        fetchRange: async (start, end) => {
          const r = await getOriginal(currentAuth(), meta, { range: [start, end], signal: ctl.signal });
          return new Uint8Array(await r.arrayBuffer());
        },
        setStatus: overlay.setStatus,
        setActions: overlay.setActions,
        setProgress: overlay.setProgress,
        saveCardThumbnail: (dataUrl) => saveThumbnail([meta.id, meta.damPath, meta.name], dataUrl),
      });
      log('mounted viewer plugin', plugin.id, 'for', meta.damPath);
    } catch (err) {
      log('fail-safe teardown', err);
      if (session === s) teardown();
    }
  };

  const start = async () => {
    let lastClearedAt = (await loadSettings()).cacheClearedAt;
    const stopRoute = watchRoute((r) => (r.kind === 'details' ? open(r.damPath) : teardown()));
    const stopCards = startCardThumbnailObserver(currentSyncAuth);
    const unsubSettings = subscribeSettings((next) => {
      if (next.cacheClearedAt && next.cacheClearedAt !== lastClearedAt) {
        lastClearedAt = next.cacheClearedAt;
        clearAllThumbnails();
      }
      const curPath = damPathFromUrl();
      if (!next.enabled || !next.detailsViewer) {
        teardown();
      } else if (curPath) {
        open(curPath);
      }
    });
    (window as any).__acvDispose = () => {
      stopRoute();
      stopCards();
      unsubSettings();
      teardown();
    };
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start, { once: true }) : start();
}
