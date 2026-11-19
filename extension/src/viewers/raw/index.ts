import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import type { ViewerPlugin } from '../types';
import { getSettings } from '../../settings';

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Scans a buffer (first 128 KB) for TIFF IFD headers ("II*\0" or "MM\0*") — which appear
 * at byte 0 in .dng/.nef/.arw/.cr2/.orf/.pef/.rw2 and inside the CMT1 box in Canon .cr3 —
 * and returns the EXIF Orientation tag (0x0112, values 1..8, default 1).
 */
function extractExifOrientation(buf: ArrayBuffer, maxScanBytes = 131072): number {
  const len = Math.min(buf.byteLength, maxScanBytes);
  const u8 = new Uint8Array(buf, 0, len);
  const dv = new DataView(buf, 0, len);

  for (let i = 0; i < len - 16; i++) {
    const isII = u8[i] === 0x49 && u8[i + 1] === 0x49 && u8[i + 2] === 0x2a && u8[i + 3] === 0x00;
    const isMM = u8[i] === 0x4d && u8[i + 1] === 0x4d && u8[i + 2] === 0x00 && u8[i + 3] === 0x2a;
    if (!isII && !isMM) continue;

    const le = isII;
    const ifdRel = dv.getUint32(i + 4, le);
    if (ifdRel < 8 || i + ifdRel + 2 >= len) continue;

    const count = dv.getUint16(i + ifdRel, le);
    if (count === 0 || count > 250 || i + ifdRel + 2 + count * 12 > len) continue;

    for (let e = 0; e < count; e++) {
      const eOff = i + ifdRel + 2 + e * 12;
      const tag = dv.getUint16(eOff, le);
      const type = dv.getUint16(eOff + 2, le);
      if (tag === 0x0112) {
        const val = type === 3 ? dv.getUint16(eOff + 8, le) : dv.getUint32(eOff + 8, le);
        if (val >= 1 && val <= 8) return val;
      }
    }
  }
  return 1;
}

/**
 * Draws an ImageBitmap onto a canvas while applying EXIF Orientation (1..8).
 */
function drawBitmapWithOrientation(bmp: ImageBitmap, orientation: number): HTMLCanvasElement {
  const sw = bmp.width;
  const sh = bmp.height;
  const swapDims = orientation >= 5 && orientation <= 8;
  const out = document.createElement('canvas');
  out.width = swapDims ? sh : sw;
  out.height = swapDims ? sw : sh;
  const ctx = out.getContext('2d')!;

  switch (orientation) {
    case 2:
      ctx.translate(sw, 0);
      ctx.scale(-1, 1);
      break;
    case 3:
      ctx.translate(sw, sh);
      ctx.rotate(Math.PI);
      break;
    case 4:
      ctx.translate(0, sh);
      ctx.scale(1, -1);
      break;
    case 5:
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(1, -1);
      break;
    case 6:
      ctx.translate(sh, 0);
      ctx.rotate(0.5 * Math.PI);
      break;
    case 7:
      ctx.translate(sh, sw);
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(-1, 1);
      break;
    case 8:
      ctx.translate(0, sw);
      ctx.rotate(-0.5 * Math.PI);
      break;
    default:
      break;
  }
  ctx.drawImage(bmp, 0, 0);
  return out;
}

/**
 * Finds the largest embedded JPEG stream (SOI 0xFFD8FF .. EOI 0xFFD9) inside a Camera RAW
 * container (.cr3 ISOBMFF, .cr2, .nef, .arw, .dng, .raf, .rw2, .orf, .pef, .iiq, .3fr).
 */
function extractLargestEmbeddedJpeg(buf: ArrayBuffer): Uint8Array | null {
  const b = new Uint8Array(buf);
  const len = b.length;
  let bestStart = -1;
  let bestEnd = -1;
  let bestSize = 0;

  let i = 0;
  while (i < len - 4) {
    if (b[i] === 0xff && b[i + 1] === 0xd8 && b[i + 2] === 0xff) {
      const m = b[i + 3];
      if (m === 0xe0 || m === 0xe1 || m === 0xdb || m === 0xc0 || m === 0xc4 || m === 0xfe) {
        const start = i;
        let j = start + 4096;
        let lastEoi = -1;
        while (j < len - 1) {
          if (b[j] === 0xff && b[j + 1] === 0xd9) {
            lastEoi = j + 2;
            if (lastEoi - start > bestSize) {
              bestStart = start;
              bestEnd = lastEoi;
              bestSize = lastEoi - start;
            }
            if (lastEoi - start > 150000) break;
          }
          j++;
        }
        i = lastEoi > start ? lastEoi : start + 2;
        continue;
      }
    }
    i++;
  }

  if (bestStart >= 0 && bestEnd > bestStart && bestSize > 4096) {
    return b.subarray(bestStart, bestEnd);
  }
  return null;
}

function extractCameraSummary(buf: ArrayBuffer, ext: string): string {
  const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, 65536));
  const ascii = new TextDecoder('latin1').decode(head);
  const brands = [
    /(Canon EOS [A-Za-z0-9\- ]{1,18})/,
    /(NIKON Z [A-Za-z0-9_]{1,12}|NIKON D[0-9A-Za-z]{1,8}|Nikon COOLSCAN [A-Za-z0-9 ]{1,14})/,
    /(ILCE-[0-9A-Za-z]{2,10}|Sony [A-Za-z0-9\-]{2,14})/,
    /(FUJIFILM X-[A-Za-z0-9]{1,10}|GFX[0-9A-Za-z]{2,8})/,
    /(Hasselblad [A-Za-z0-9\- ]{2,16})/,
    /(Phase One [A-Za-z0-9\- ]{2,16})/,
    /(LEICA [A-Za-z0-9\- ]{2,14})/,
    /(DC-S[0-9A-Za-z]{1,8}|DC-GH[0-9A-Za-z]{1,6})/,
  ];
  for (const re of brands) {
    const m = ascii.match(re);
    if (m) return `${m[1].trim()} · ${ext.toUpperCase()} RAW`;
  }
  return `${ext.toUpperCase()} Image`;
}

async function decodeRawOrHdrToCanvas(
  buf: ArrayBuffer,
  ext: string,
  exposureEv = 0,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number; isFloatHdr: boolean }> {
  if (ext === 'hdr' || ext === 'exr') {
    const texData = ext === 'hdr' ? new RGBELoader().parse(buf) : new EXRLoader().parse(buf);
    const w = texData.width || 512;
    const h = texData.height || 512;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const renderer = new THREE.WebGLRenderer({ canvas });
    renderer.setSize(w, h, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = Math.pow(2, exposureEv);

    const tex = new THREE.DataTexture(texData.data as any, w, h, THREE.RGBAFormat, texData.type);
    tex.needsUpdate = true;

    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: tex }),
    );
    scene.add(quad);
    renderer.render(scene, cam);

    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d')!.drawImage(canvas, 0, 0);
    tex.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    return { canvas: out, width: w, height: h, isFloatHdr: true };
  }

  // Extract outer RAW container EXIF Orientation (e.g. DNG/NEF/ARW TIFF IFD0 or CR3 CMT1)
  const containerOrientation = extractExifOrientation(buf);
  const jpegBytes = extractLargestEmbeddedJpeg(buf);
  const blob = jpegBytes
    ? new Blob([jpegBytes.buffer.slice(jpegBytes.byteOffset, jpegBytes.byteOffset + jpegBytes.byteLength) as ArrayBuffer], {
        type: 'image/jpeg',
      })
    : new Blob([buf]);

  // Decode raw sensor pixels without browser auto-orienting so we never double-rotate,
  // then apply the authoritative container (or embedded JPEG) EXIF orientation.
  const embeddedOrientation = jpegBytes
    ? extractExifOrientation(
        jpegBytes.buffer.slice(jpegBytes.byteOffset, jpegBytes.byteOffset + Math.min(jpegBytes.byteLength, 65536)) as ArrayBuffer,
      )
    : 1;
  const effectiveOrientation = containerOrientation !== 1 ? containerOrientation : embeddedOrientation;

  const bmp = await createImageBitmap(blob, { imageOrientation: 'none' });
  const out = drawBitmapWithOrientation(bmp, effectiveOrientation);
  bmp.close();
  return { canvas: out, width: out.width, height: out.height, isFloatHdr: false };
}

function drawHistogram(source: HTMLCanvasElement, target: HTMLCanvasElement) {
  const sw = 160;
  const sh = 100;
  const tmp = document.createElement('canvas');
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext('2d')!;
  tctx.drawImage(source, 0, 0, sw, sh);
  const data = tctx.getImageData(0, 0, sw, sh).data;

  const rBins = new Uint32Array(64);
  const gBins = new Uint32Array(64);
  const bBins = new Uint32Array(64);
  for (let i = 0; i < data.length; i += 4) {
    rBins[data[i] >> 2]++;
    gBins[data[i + 1] >> 2]++;
    bBins[data[i + 2] >> 2]++;
  }
  const maxVal = Math.max(...rBins, ...gBins, ...bBins, 1);

  target.width = 192;
  target.height = 68;
  const c = target.getContext('2d')!;
  c.clearRect(0, 0, 192, 68);
  c.globalCompositeOperation = 'screen';

  const drawChannel = (bins: Uint32Array, color: string) => {
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(0, 68);
    for (let i = 0; i < 64; i++) {
      const h = (bins[i] / maxVal) * 60;
      c.lineTo(i * 3, 68 - h);
    }
    c.lineTo(192, 68);
    c.closePath();
    c.fill();
  };
  drawChannel(rBins, 'rgba(239, 68, 68, 0.75)');
  drawChannel(gBins, 'rgba(34, 197, 94, 0.75)');
  drawChannel(bBins, 'rgba(59, 130, 246, 0.75)');
}

export const UNSUPPORTED_BY_AEM_RAW_EXTS = [
  'hdr',
  'exr',
  'crm',
  'braw',
  'r3d',
  'ari',
  'bay',
  'cap',
  'eip',
  'dcs',
  'drf',
  'mdc',
  'ptx',
  'rwz',
] as const;

export const AEM_ACR_FALLBACK_RAW_EXTS = [
  'cr3',
  'cr2',
  'crw',
  'nef',
  'nrw',
  'arw',
  'srf',
  'srw',
  'dng',
  'raf',
  'rw2',
  'rwl',
  'orf',
  'pef',
  'iiq',
  '3fr',
  'dcr',
  'erf',
  'fff',
  'gpr',
  'kdc',
  'mef',
  'mfw',
  'mos',
  'mrw',
  'raw',
  'x3f',
] as const;

const ALWAYS_SET = new Set<string>(UNSUPPORTED_BY_AEM_RAW_EXTS);
const FALLBACK_SET = new Set<string>(AEM_ACR_FALLBACK_RAW_EXTS);

export const rawImageViewer: ViewerPlugin = {
  id: 'raw-image',
  label: 'Camera RAW & HDR',
  badge: 'RAW',
  extensions: [...UNSUPPORTED_BY_AEM_RAW_EXTS],
  mimeTypes: ['image/vnd.radiance', 'image/x-exr'],
  match(meta) {
    const s = getSettings();
    const ext = extOf(meta.name || meta.damPath);
    if (ALWAYS_SET.has(ext)) return s.formats.raw;
    if (FALLBACK_SET.has(ext)) {
      if (s.formats.rawAcrFallback) return true;
      // Also step in automatically when AEM failed to generate a native rendition (e.g. 023A9867.CR3)
      if (s.formats.raw && meta.hasNativeRendition === false) return true;
    }
    return false;
  },

  async renderThumbnail(meta, fetchBuffer) {
    const ext = extOf(meta.name);
    let buf: ArrayBuffer;
    if (ext !== 'hdr' && ext !== 'exr' && (!meta.size || meta.size > 8 * 1024 * 1024)) {
      const headBuf = await fetchBuffer([0, 8 * 1024 * 1024 - 1]);
      buf = extractLargestEmbeddedJpeg(headBuf) ? headBuf : await fetchBuffer();
    } else {
      buf = await fetchBuffer();
    }
    const { canvas } = await decodeRawOrHdrToCanvas(buf, ext, 0);

    const thumb = document.createElement('canvas');
    thumb.width = 360;
    thumb.height = 360;
    const c = thumb.getContext('2d')!;
    const sw = Math.min(canvas.width, canvas.height);
    c.drawImage(canvas, (canvas.width - sw) / 2, (canvas.height - sw) / 2, sw, sw, 0, 0, 360, 360);
    return thumb.toDataURL('image/webp', 0.88);
  },

  async mount(ctx) {
    const ext = extOf(ctx.meta.name);
    ctx.setProgress(5, `Downloading ${ctx.meta.name}…`);
    let buf: ArrayBuffer;
    if (ext !== 'hdr' && ext !== 'exr' && ctx.meta.size && ctx.meta.size > 8 * 1024 * 1024) {
      ctx.setProgress(25, `Reading embedded preview from first 8 MB of ${ctx.meta.name}…`);
      const rangeBytes = await ctx.fetchRange(0, 8 * 1024 * 1024 - 1);
      const sliceBuf = rangeBytes.buffer.slice(
        rangeBytes.byteOffset,
        rangeBytes.byteOffset + rangeBytes.byteLength,
      ) as ArrayBuffer;
      if (extractLargestEmbeddedJpeg(sliceBuf)) {
        buf = sliceBuf;
      } else {
        buf = await ctx.fetchBuffer((loaded, total) => {
          if (total) ctx.setProgress((loaded / total) * 88);
        });
      }
    } else {
      buf = await ctx.fetchBuffer((loaded, total) => {
        if (total) ctx.setProgress((loaded / total) * 88);
      });
    }
    if (ctx.signal.aborted) return () => {};

    ctx.setProgress(94, `Decoding ${ext.toUpperCase()} image…`);
    let decoded = await decodeRawOrHdrToCanvas(buf, ext, 0);
    const camSummary = extractCameraSummary(buf, ext);
    ctx.setProgress(null);

    ctx.setStatus(
      `${decoded.width}×${decoded.height} · ${( (ctx.meta.size || buf.byteLength) / 1048576 ).toFixed(1)} MB · ${camSummary}`,
    );

    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#0e0f12;overflow:hidden;';

    const displayCanvas = document.createElement('canvas');
    displayCanvas.width = decoded.width;
    displayCanvas.height = decoded.height;
    displayCanvas.style.cssText =
      'max-width:94%;max-height:92%;object-fit:contain;box-shadow:0 12px 40px rgba(0,0,0,.6);transition:transform 0.08s ease-out;cursor:zoom-in;';

    const hud = document.createElement('div');
    hud.style.cssText =
      'position:absolute;top:12px;right:12px;padding:10px 12px;border-radius:10px;background:rgba(15,17,23,0.85);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.1);display:flex;flex-direction:column;gap:8px;z-index:2;width:192px;';
    const histCanvas = document.createElement('canvas');
    histCanvas.style.cssText = 'width:192px;height:68px;border-radius:4px;background:rgba(0,0,0,0.35);';

    const evRow = document.createElement('div');
    evRow.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;color:#cbd5e1;font-weight:600;';
    evRow.innerHTML = `<span>Exposure</span><span class="ev-val">0.0 EV</span>`;
    const evVal = evRow.querySelector<HTMLElement>('.ev-val')!;

    const evSlider = document.createElement('input');
    evSlider.type = 'range';
    evSlider.min = '-3';
    evSlider.max = '3';
    evSlider.step = '0.1';
    evSlider.value = '0';

    hud.append(histCanvas, evRow, evSlider);
    wrap.append(displayCanvas, hud);
    ctx.container.appendChild(wrap);

    let exposure = 0;
    let zoom = 1;
    let extraRotDeg = 0;

    const applyTransform = () => {
      displayCanvas.style.transform = `scale(${zoom}) rotate(${extraRotDeg}deg)`;
    };

    const redraw = async () => {
      const dctx = displayCanvas.getContext('2d')!;
      if (decoded.isFloatHdr) {
        decoded = await decodeRawOrHdrToCanvas(buf, ext, exposure);
        dctx.drawImage(decoded.canvas, 0, 0);
      } else {
        const brightness = Math.round(Math.pow(2, exposure) * 100);
        dctx.filter = `brightness(${brightness}%)`;
        dctx.drawImage(decoded.canvas, 0, 0);
        dctx.filter = 'none';
      }
      drawHistogram(displayCanvas, histCanvas);
    };

    evSlider.oninput = () => {
      exposure = Number(evSlider.value);
      evVal.textContent = `${exposure >= 0 ? '+' : ''}${exposure.toFixed(1)} EV`;
      redraw();
    };

    displayCanvas.onclick = () => {
      zoom = zoom === 1 ? 2.2 : 1;
      applyTransform();
      displayCanvas.style.cursor = zoom > 1 ? 'zoom-out' : 'zoom-in';
    };

    await redraw();

    const saveOrientedThumb = async () => {
      const thumb = document.createElement('canvas');
      thumb.width = 360;
      thumb.height = 360;
      const sw = Math.min(displayCanvas.width, displayCanvas.height);
      thumb
        .getContext('2d')!
        .drawImage(
          displayCanvas,
          (displayCanvas.width - sw) / 2,
          (displayCanvas.height - sw) / 2,
          sw,
          sw,
          0,
          0,
          360,
          360,
        );
      await ctx.saveCardThumbnail(thumb.toDataURL('image/webp', 0.88));
    };

    // Auto-save properly oriented card thumbnail on open
    saveOrientedThumb().catch(() => {});

    ctx.setActions([
      {
        id: 'rotate',
        label: '⟳ Rotate 90°',
        title: 'Rotate preview 90° clockwise',
        onClick: () => {
          extraRotDeg = (extraRotDeg + 90) % 360;
          applyTransform();
        },
      },
      {
        id: 'reset-ev',
        label: 'Reset 0 EV',
        onClick: () => {
          exposure = 0;
          evSlider.value = '0';
          evVal.textContent = '0.0 EV';
          redraw();
        },
      },
      {
        id: 'zoom',
        label: '1:1 Loupe',
        onClick: () => displayCanvas.click(),
      },
      {
        id: 'thumb',
        label: '📷 Set Thumbnail',
        onClick: saveOrientedThumb,
      },
    ]);

    return () => {
      wrap.remove();
    };
  },
};
