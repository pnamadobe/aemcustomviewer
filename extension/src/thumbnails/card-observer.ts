import type { AuthSnapshot } from '../bridge';
import { getMetadata, fetchArrayBufferWithProgress, type AssetMeta } from '../assets-api';
import { pickViewer, type ViewerPlugin } from '../viewers';
import { getThumbnail, saveThumbnail, THUMB_UPDATED_EVENT } from './store';

const CARD_ROW_SELECTOR = 'div[role="row"][data-key^="urn:aaid:aem:"]';
const inFlight = new Set<string>();
const failed = new Set<string>();
let queueChain: Promise<void> = Promise.resolve();

function browseFolderFromHash(): string | null {
  const m = location.hash.match(/#\/(?:browse|assets\/browse)(\/content\/dam\/[^?#]*)/i);
  return m ? decodeURIComponent(m[1]).replace(/\/$/, '') : null;
}

function mountCardPreview(
  previewSlot: HTMLElement,
  descSlot: HTMLElement | null,
  plugin: ViewerPlugin,
  name: string,
  dataUrl: string | null,
) {
  const stateKey = dataUrl ? `ready:${dataUrl.length}` : `loading:${plugin.id}`;
  let wrap = previewSlot.querySelector<HTMLElement>('[data-acv-card-thumb]');
  if (wrap && wrap.getAttribute('data-acv-state') === stateKey) return;

  previewSlot.style.position = 'relative';

  if (descSlot) {
    const spans = descSlot.querySelectorAll('span');
    if (spans.length >= 2 && spans[1].textContent !== plugin.label) {
      spans[1].textContent = plugin.label;
    }
  }

  if (!wrap) {
    wrap = document.createElement('div');
    wrap.setAttribute('data-acv-card-thumb', '');
    wrap.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#141418;overflow:hidden;border-radius:inherit;pointer-events:none;z-index:1;';
    previewSlot.prepend(wrap);
  }
  wrap.setAttribute('data-acv-state', stateKey);

  const badgeHtml = `<span style="position:absolute;top:10px;left:10px;padding:2px 7px;border-radius:4px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font:700 10px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.05em;box-shadow:0 2px 6px rgba(0,0,0,.45);z-index:2">${plugin.badge}</span>`;

  if (dataUrl) {
    wrap.innerHTML = `${badgeHtml}<img src="${dataUrl}" alt="${name}" style="width:100%;height:100%;object-fit:cover;display:block" />`;
  } else {
    wrap.innerHTML = `${badgeHtml}<div style="color:#a1a1aa;font:500 11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:12px">Rendering ${plugin.badge} preview…</div>`;
  }
}

async function processCard(row: HTMLElement, getAuth: () => AuthSnapshot | null) {
  const assetId = row.getAttribute('data-key') || '';
  const previewSlot = row.querySelector<HTMLElement>('[slot="preview"]');
  const descSlot = row.querySelector<HTMLElement>('[slot="description"]');
  const nameSpan = descSlot?.querySelector<HTMLElement>('span');
  const name = nameSpan?.textContent?.trim() || '';
  if (!previewSlot || !name) return;

  const folder = browseFolderFromHash();
  const damPath = folder ? `${folder}/${name}` : `/content/dam/${name}`;
  const pseudoMeta: AssetMeta = { id: assetId, damPath, name, mime: '' };
  const plugin = pickViewer(pseudoMeta);
  if (!plugin) return;

  const keys = [assetId, damPath, name].filter(Boolean);
  const cached = await getThumbnail(keys);
  if (cached) {
    mountCardPreview(previewSlot, descSlot, plugin, name, cached);
    return;
  }

  const lockKey = assetId || damPath;
  if (!plugin.renderThumbnail || inFlight.has(lockKey) || failed.has(lockKey)) return;

  mountCardPreview(previewSlot, descSlot, plugin, name, null);
  inFlight.add(lockKey);

  queueChain = queueChain
    .then(async () => {
      const auth = getAuth();
      if (!auth || !folder) return;
      const ctl = new AbortController();
      const meta = await getMetadata(auth, damPath, ctl.signal);
      const rendered = await plugin.renderThumbnail!(meta, () =>
        fetchArrayBufferWithProgress(auth, meta, ctl.signal),
      );
      if (rendered) {
        await saveThumbnail([meta.id, meta.damPath, meta.name, assetId], rendered);
        if (previewSlot.isConnected) {
          mountCardPreview(previewSlot, descSlot, plugin, name, rendered);
        }
      } else {
        failed.add(lockKey);
      }
    })
    .catch(() => {
      failed.add(lockKey);
    })
    .finally(() => {
      inFlight.delete(lockKey);
    });
}

export function startCardThumbnailObserver(getAuth: () => AuthSnapshot | null): () => void {
  let raf = 0;
  const scan = () => {
    raf = 0;
    document.querySelectorAll<HTMLElement>(CARD_ROW_SELECTOR).forEach((row) => {
      processCard(row, getAuth);
    });
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(scan);
  };

  const mo = new MutationObserver((records) => {
    const external = records.some(
      (r) => !(r.target instanceof Element && r.target.closest('[data-acv-card-thumb], [data-acv-overlay]')),
    );
    if (external) schedule();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener(THUMB_UPDATED_EVENT, schedule);
  schedule();

  return () => {
    if (raf) cancelAnimationFrame(raf);
    mo.disconnect();
    document.removeEventListener(THUMB_UPDATED_EVENT, schedule);
  };
}
