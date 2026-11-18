import type { AuthSnapshot } from '../bridge';
import { getMetadata, fetchArrayBufferWithProgress, getSignedVideoUrl, type AssetMeta } from '../assets-api';
import { pickViewer, type ViewerPlugin } from '../viewers';
import type { AnimatedSplatPreview } from '../viewers/gsplat';
import { getThumbnail, saveThumbnail, THUMB_UPDATED_EVENT } from './store';

const CARD_ROW_SELECTOR = 'div[role="row"][data-key^="urn:aaid:aem:"]';
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'm4v', 'ogv']);
const SCRUB_FRAMES = 24;
const inFlight = new Set<string>();
const failed = new Set<string>();
const signedVideoCache = new Map<string, Promise<string>>();
let queueChain: Promise<void> = Promise.resolve();

type CachedScrubStrip = {
  duration: number;
  frames: string[];
};

function browseFolderFromHash(): string | null {
  const m = location.hash.match(/#\/(?:browse|assets\/browse)(\/content\/dam\/[^?#]*)/i);
  return m ? decodeURIComponent(m[1]).replace(/\/$/, '') : null;
}

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function parseAnimatedPreview(raw: string | null): AnimatedSplatPreview | null {
  if (!raw || !raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.kind === 'acv-anim-v2' && Array.isArray(parsed.frames) ? parsed : null;
  } catch {
    return null;
  }
}

async function generateScrubStrip(videoUrl: string): Promise<CachedScrubStrip | null> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.src = videoUrl;

  await new Promise<void>((res, rej) => {
    v.onloadedmetadata = () => res();
    v.onerror = () => rej(new Error('video metadata error'));
  });

  const duration = v.duration;
  if (!Number.isFinite(duration) || duration <= 0) return null;

  const h = 220;
  const w = Math.max(160, Math.round((v.videoWidth / (v.videoHeight || 1)) * h) || 320);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  const frames: string[] = [];
  for (let i = 0; i < SCRUB_FRAMES; i++) {
    const t = ((i + 0.5) / SCRUB_FRAMES) * duration;
    v.currentTime = t;
    await new Promise<void>((res) => {
      const onSeek = () => {
        v.removeEventListener('seeked', onSeek);
        res();
      };
      v.addEventListener('seeked', onSeek);
    });
    ctx.drawImage(v, 0, 0, w, h);
    frames.push(canvas.toDataURL('image/webp', 0.72));
  }
  v.src = '';
  return { duration, frames };
}

function attachVideoHoverScrub(
  row: HTMLElement,
  previewSlot: HTMLElement,
  assetId: string,
  damPath: string,
  getAuth: () => AuthSnapshot | null,
) {
  if (previewSlot.hasAttribute('data-acv-video-scrub')) return;
  previewSlot.setAttribute('data-acv-video-scrub', '1');
  previewSlot.style.position = 'relative';

  const scrubCacheKeys = [`scrub:${assetId}`, `scrub:${damPath}`].filter((k) => k !== 'scrub:');

  const hintBadge = document.createElement('span');
  hintBadge.setAttribute('data-acv-scrub-badge', '');
  hintBadge.textContent = '⇄ SCRUB';
  hintBadge.style.cssText =
    'position:absolute;top:14px;left:44px;padding:2px 6px;border-radius:4px;background:rgba(15,23,42,0.78);color:#e2e8f0;font:700 9px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.05em;z-index:2;pointer-events:none;backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,0.14);';
  previewSlot.appendChild(hintBadge);

  let scrubWrap: HTMLElement | null = null;
  let frameImg: HTMLImageElement | null = null;
  let video: HTMLVideoElement | null = null;
  let fillBar: HTMLElement | null = null;
  let timePill: HTMLElement | null = null;
  let strip: CachedScrubStrip | null = null;
  let stripBuilding = false;
  let seeking = false;
  let pendingPct: number | null = null;

  getThumbnail(scrubCacheKeys).then((raw) => {
    if (raw) {
      try {
        strip = JSON.parse(raw) as CachedScrubStrip;
        hintBadge.textContent = '⇄ SCRUB · CACHED';
      } catch {
        /* ignore */
      }
    }
  });

  const ensureUi = async () => {
    if (!scrubWrap) {
      scrubWrap = document.createElement('div');
      scrubWrap.setAttribute('data-acv-card-thumb', '');
      scrubWrap.style.cssText =
        'position:absolute;inset:0;display:none;background:#09090b;overflow:hidden;border-radius:inherit;pointer-events:none;z-index:3;';

      frameImg = document.createElement('img');
      frameImg.style.cssText = 'width:100%;height:100%;object-fit:contain;display:none;background:#09090b;';

      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#09090b;';

      timePill = document.createElement('span');
      timePill.style.cssText =
        'position:absolute;bottom:10px;right:10px;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,0.78);color:#fff;font:600 10px/1.3 ui-monospace,SFMono-Regular,monospace;z-index:4;';
      timePill.textContent = '0:00';

      const track = document.createElement('div');
      track.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(255,255,255,0.22);z-index:4;';
      fillBar = document.createElement('div');
      fillBar.style.cssText = 'height:100%;width:0%;background:linear-gradient(90deg,#3b82f6,#ec4899);';
      track.appendChild(fillBar);

      scrubWrap.append(frameImg, video, timePill, track);
      previewSlot.appendChild(scrubWrap);

      video.addEventListener('seeked', () => {
        seeking = false;
        if (pendingPct !== null && video && Number.isFinite(video.duration)) {
          const p = pendingPct;
          pendingPct = null;
          seeking = true;
          video.currentTime = p * video.duration;
        }
      });
    }

    if (strip) {
      if (frameImg) frameImg.style.display = 'block';
      if (video) video.style.display = 'none';
      return;
    }

    const auth = getAuth();
    if (!auth || !video) return;
    let urlPromise = signedVideoCache.get(damPath);
    if (!urlPromise) {
      urlPromise = getSignedVideoUrl(auth, damPath);
      signedVideoCache.set(damPath, urlPromise);
    }
    const signedUrl = await urlPromise;
    if (!video.src) video.src = signedUrl;

    if (!stripBuilding) {
      stripBuilding = true;
      generateScrubStrip(signedUrl)
        .then(async (built) => {
          if (built && built.frames.length > 0) {
            strip = built;
            hintBadge.textContent = '⇄ SCRUB · CACHED';
            await saveThumbnail(scrubCacheKeys, JSON.stringify(built));
            if (frameImg && video) {
              frameImg.style.display = 'block';
              video.style.display = 'none';
            }
          }
        })
        .catch(() => {});
    }
  };

  const seekToPct = (pct: number) => {
    const clamped = Math.max(0, Math.min(0.999, pct));
    if (fillBar) fillBar.style.width = `${(clamped * 100).toFixed(1)}%`;

    if (strip && frameImg) {
      const idx = Math.min(strip.frames.length - 1, Math.floor(clamped * strip.frames.length));
      frameImg.src = strip.frames[idx];
      if (timePill) {
        timePill.textContent = `${formatTime(clamped * strip.duration)} / ${formatTime(strip.duration)}`;
      }
      return;
    }

    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const targetSec = clamped * video.duration;
    if (timePill) timePill.textContent = `${formatTime(targetSec)} / ${formatTime(video.duration)}`;
    if (seeking) {
      pendingPct = clamped;
    } else {
      seeking = true;
      video.currentTime = targetSec;
    }
  };

  row.addEventListener('mouseenter', async () => {
    await ensureUi();
    if (scrubWrap) scrubWrap.style.display = 'block';
  });

  row.addEventListener('mousemove', (e: MouseEvent) => {
    const r = previewSlot.getBoundingClientRect();
    if (r.width <= 0) return;
    if (scrubWrap && scrubWrap.style.display === 'none') {
      scrubWrap.style.display = 'block';
    }
    seekToPct((e.clientX - r.left) / r.width);
  });

  row.addEventListener('mouseleave', () => {
    if (scrubWrap) scrubWrap.style.display = 'none';
  });
}

function mountCardPreview(
  row: HTMLElement,
  previewSlot: HTMLElement,
  descSlot: HTMLElement | null,
  plugin: ViewerPlugin,
  name: string,
  rawPayload: string | null,
) {
  const stateKey = rawPayload ? `ready:${rawPayload.length}` : `loading:${plugin.id}`;
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

  // Clean up any previous animation timer on this card
  if ((wrap as any).__acvTimer) {
    clearInterval((wrap as any).__acvTimer);
    (wrap as any).__acvTimer = null;
  }

  const anim = parseAnimatedPreview(rawPayload);
  const badgeText = anim ? `${plugin.badge} · ${anim.mode.toUpperCase()}` : plugin.badge;
  const badgeHtml = `<span style="position:absolute;top:14px;left:44px;padding:2px 7px;border-radius:4px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font:700 10px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.05em;box-shadow:0 2px 6px rgba(0,0,0,.45);z-index:2">${badgeText}</span>`;

  if (anim && anim.frames.length > 0) {
    wrap.innerHTML = `${badgeHtml}
      <img class="acv-layer-a" src="${anim.poster}" alt="${name}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;transition:opacity 340ms ease-in-out;opacity:1" />
      <img class="acv-layer-b" src="${anim.poster}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;transition:opacity 340ms ease-in-out;opacity:0" />`;
    const imgA = wrap.querySelector<HTMLImageElement>('.acv-layer-a')!;
    const imgB = wrap.querySelector<HTMLImageElement>('.acv-layer-b')!;
    let showingA = true;
    let hovering = false;

    const seq: number[] = [];
    for (let i = 0; i < anim.frames.length; i++) seq.push(i);
    if (anim.pingPong && anim.frames.length > 2) {
      for (let i = anim.frames.length - 2; i >= 1; i--) seq.push(i);
    }

    // Stagger starting phase per card so 30 cards don't move in lockstep
    let tick = Math.floor(Math.random() * seq.length);

    // Slow, ambient "living photo" drift (~12s full cycle, 380ms per crossfaded step)
    (wrap as any).__acvTimer = setInterval(() => {
      if (!wrap!.isConnected) {
        clearInterval((wrap as any).__acvTimer);
        return;
      }
      if (hovering) return;
      tick = (tick + 1) % seq.length;
      const nextSrc = anim.frames[seq[tick]];
      if (showingA) {
        imgB.src = nextSrc;
        imgB.style.opacity = '1';
        imgA.style.opacity = '0';
      } else {
        imgA.src = nextSrc;
        imgA.style.opacity = '1';
        imgB.style.opacity = '0';
      }
      showingA = !showingA;
    }, 380);

    // On hover, let the user scrub directly with crisp instant frame response
    if (!(row as any).__acvAnimBound) {
      (row as any).__acvAnimBound = true;
      row.addEventListener('mouseenter', () => {
        hovering = true;
      });
      row.addEventListener('mousemove', (e: MouseEvent) => {
        const r = previewSlot.getBoundingClientRect();
        if (r.width <= 0) return;
        const pct = Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width));
        const idx = Math.floor(pct * anim.frames.length);
        imgA.style.transition = 'none';
        imgB.style.transition = 'none';
        imgA.src = anim.frames[idx];
        imgA.style.opacity = '1';
        imgB.style.opacity = '0';
        showingA = true;
      });
      row.addEventListener('mouseleave', () => {
        imgA.style.transition = 'opacity 340ms ease-in-out';
        imgB.style.transition = 'opacity 340ms ease-in-out';
        hovering = false;
      });
    }
  } else if (rawPayload) {
    wrap.innerHTML = `${badgeHtml}<img src="${rawPayload}" alt="${name}" style="width:100%;height:100%;object-fit:cover;display:block" />`;
  } else {
    wrap.innerHTML = `${badgeHtml}<div style="color:#a1a1aa;font:500 11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:12px">Rendering animated ${plugin.badge} preview…</div>`;
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

  // 1. Video Hover-Scrubbing for MP4/MOV/WebM cards
  if (VIDEO_EXTS.has(extOf(name)) && folder) {
    attachVideoHoverScrub(row, previewSlot, assetId, damPath, getAuth);
    return;
  }

  // 2. Custom Plugin Thumbnails (Animated 3DGS, Audio Waveform, etc.)
  const pseudoMeta: AssetMeta = { id: assetId, damPath, name, mime: '' };
  const plugin = pickViewer(pseudoMeta);
  if (!plugin) return;

  const keys = [assetId, damPath, name].filter(Boolean);
  const cached = await getThumbnail(keys);
  // Upgrade old static or v1 fast-loop 3DGS thumbnails to slow-drift acv-anim-v2 automatically
  const isOutdatedSplat = plugin.id === 'gsplat' && cached && !parseAnimatedPreview(cached);
  if (cached && !isOutdatedSplat) {
    mountCardPreview(row, previewSlot, descSlot, plugin, name, cached);
    return;
  }

  const lockKey = assetId || damPath;
  if (!plugin.renderThumbnail || inFlight.has(lockKey) || failed.has(lockKey)) return;

  mountCardPreview(row, previewSlot, descSlot, plugin, name, null);
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
          mountCardPreview(row, previewSlot, descSlot, plugin, name, rendered);
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
