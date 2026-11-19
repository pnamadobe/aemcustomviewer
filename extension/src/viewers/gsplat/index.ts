import * as SPLAT from 'gsplat';
import type { ViewerPlugin } from '../types';
import {
  getCachedDecimatedSplat,
  saveCachedDecimatedSplat,
  streamAndDecimateSplatResponse,
} from './stream-decimate';
import { decimateSplatBufferInMemory } from './decimate-memory';

export type SplatMotionMode = 'orbit' | 'push' | 'pan';

export interface AnimatedSplatPreview {
  kind: 'acv-anim-v4';
  mode: SplatMotionMode;
  pingPong: boolean;
  poster: string;
  frames: string[];
}

const BACKGROUNDS: { label: string; color: [number, number, number, number]; css: string }[] = [
  { label: 'BG: Dark', color: [24, 26, 34, 255], css: '#181a22' },
  { label: 'BG: Slate', color: [42, 46, 55, 255], css: '#2a2e37' },
  { label: 'BG: Light', color: [232, 234, 238, 255], css: '#e8eaee' },
];

const MOTION_MODES: { mode: SplatMotionMode; label: string; badge: string }[] = [
  { mode: 'orbit', label: 'Mode: Orbit', badge: 'ORBIT' },
  { mode: 'push', label: 'Mode: Push', badge: 'PUSH' },
  { mode: 'pan', label: 'Mode: Pan', badge: 'PAN' },
];

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface SplatSceneStats {
  mode: SplatMotionMode;
  target: SPLAT.Vector3;
  idealRadius: number;
}

/**
 * Analyzes the splat point cloud, weighting samples toward bright, opaque foreground splats
 * so dark room backgrounds (like in bonsai.splat) don't pull the camera away from the subject.
 */
function analyzeSplatScene(splat: SPLAT.Splat | null, fileName = ''): SplatSceneStats {
  const fallback: SplatSceneStats = {
    mode: 'orbit',
    target: new SPLAT.Vector3(0, 0, 0),
    idealRadius: 2.2,
  };
  if (!splat) return fallback;

  const pos = splat.data.positions;
  const colors = splat.data.colors;
  const n = splat.data.vertexCount;
  if (!pos || n < 100) return fallback;

  const step = Math.max(1, Math.floor(n / 3000));
  const allXs: number[] = [];
  const allYs: number[] = [];
  const allZs: number[] = [];
  const brightXs: number[] = [];
  const brightYs: number[] = [];
  const brightZs: number[] = [];

  for (let i = 0; i < n; i += step) {
    const a = colors ? colors[i * 4 + 3] : 255;
    if (a < 90) continue;
    const r = colors ? colors[i * 4 + 0] : 180;
    const g = colors ? colors[i * 4 + 1] : 180;
    const b = colors ? colors[i * 4 + 2] : 180;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    allXs.push(x);
    allYs.push(y);
    allZs.push(z);

    // Bright hero splats (like the glowing pink bonsai foliage & pot)
    if (luma > 55) {
      brightXs.push(x);
      brightYs.push(y);
      brightZs.push(z);
    }
  }
  if (allXs.length < 20) return fallback;

  const useBright = brightXs.length >= 60;
  const xs = (useBright ? brightXs : allXs).slice().sort((a, b) => a - b);
  const ys = (useBright ? brightYs : allYs).slice().sort((a, b) => a - b);
  const zs = (useBright ? brightZs : allZs).slice().sort((a, b) => a - b);

  allXs.sort((a, b) => a - b);
  allYs.sort((a, b) => a - b);
  allZs.sort((a, b) => a - b);

  const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const cx = q(xs, 0.5);
  // Bias Y toward the upper-middle of the bright subject (in Y-down space, 35th percentile is upper canopy)
  const cy = q(ys, 0.35);
  const cz = q(zs, 0.5);

  const iqrSpan = Math.hypot(
    q(allXs, 0.75) - q(allXs, 0.25),
    q(allYs, 0.75) - q(allYs, 0.25),
    q(allZs, 0.75) - q(allZs, 0.25),
  );

  const radii: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    radii.push(Math.hypot(xs[i] - cx, ys[i] - cy, zs[i] - cz));
  }
  radii.sort((a, b) => a - b);
  const r50 = q(radii, 0.5) || 1;
  const r90 = q(radii, 0.9) || 1;

  const isRoomScene =
    r90 / r50 > 2.6 || iqrSpan > 3.2 || /room|shop|indoor|house|street|scene|milano/i.test(fileName);

  if (isRoomScene) {
    return {
      mode: 'push',
      target: new SPLAT.Vector3(cx, cy, cz),
      idealRadius: Math.max(0.85, Math.min(1.45, r50 * 0.6)),
    };
  }

  return {
    mode: 'orbit',
    target: new SPLAT.Vector3(cx, cy, cz),
    // Tighter framing on the bright hero object (1.65m for bonsai)
    idealRadius: Math.max(1.4, Math.min(2.2, r50 * 1.45)),
  };
}

function updateCameraFocalLength(
  renderer: SPLAT.WebGLRenderer,
  camera: SPLAT.Camera,
  width: number,
  height: number,
  fovFactor: number,
) {
  const f = Math.min(width, height) * fovFactor;
  camera.data.fx = f;
  camera.data.fy = f;
  camera.data.setSize(width, height);
  camera.update();

  try {
    const gl = renderer.gl;
    const prog = renderer.renderProgram?.program;
    if (gl && prog) {
      gl.useProgram(prog);
      const loc = gl.getUniformLocation(prog, 'focal');
      if (loc) gl.uniform2fv(loc, new Float32Array([f, f]));
    }
  } catch {
    /* ignore */
  }
}

/**
 * Automatic gamma & shadow-lift tone-mapper for dark Gaussian Splat thumbnails.
 * Measures mean pixel luminance of the rendered frame and applies a 256-entry LUT curve
 * (`v^gamma`) plus a subtle saturation boost so dark captures (like bonsai.splat) pop in Card View.
 */
function autoToneMapCanvas(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  let lumaSum = 0;
  const totalPx = w * h;

  for (let i = 0; i < d.length; i += 16) {
    lumaSum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  const meanLuma = lumaSum / (totalPx / 4);

  // Target a healthy mean luminance of ~88/255; clamp gamma between 0.52 (strong lift for dark scenes) and 0.92
  const currentNorm = Math.max(0.08, Math.min(0.85, meanLuma / 255));
  const targetNorm = 0.36;
  const gamma = Math.max(0.52, Math.min(0.92, Math.log(targetNorm) / Math.log(currentNorm)));

  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const norm = v / 255;
    // Gamma lift + soft S-curve contrast
    const lifted = Math.pow(norm, gamma) * 1.06;
    lut[v] = Math.max(0, Math.min(255, Math.round(lifted * 255)));
  }

  const sat = 1.18;
  for (let i = 0; i < d.length; i += 4) {
    const r = lut[d[i]];
    const g = lut[d[i + 1]];
    const b = lut[d[i + 2]];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    d[i] = Math.max(0, Math.min(255, gray + (r - gray) * sat));
    d[i + 1] = Math.max(0, Math.min(255, gray + (g - gray) * sat));
    d[i + 2] = Math.max(0, Math.min(255, gray + (b - gray) * sat));
    d[i + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
}

function applyCameraMotion(
  camera: SPLAT.Camera,
  controls: SPLAT.OrbitControls,
  baseAlpha: number,
  baseBeta: number,
  baseRadius: number,
  target: SPLAT.Vector3,
  mode: SplatMotionMode,
  t: number, // 0..1
) {
  let alpha = baseAlpha;
  let beta = baseBeta;
  let radius = baseRadius;

  if (mode === 'orbit') {
    alpha = baseAlpha + (t - 0.5) * 0.58;
    beta = baseBeta + Math.sin(t * Math.PI) * 0.03;
  } else if (mode === 'push') {
    radius = baseRadius * (1 - 0.16 * t);
    alpha = baseAlpha + Math.sin(t * Math.PI) * 0.12;
    beta = baseBeta - Math.sin(t * Math.PI) * 0.02;
  } else {
    alpha = baseAlpha + (t - 0.5) * 0.42;
    beta = baseBeta + Math.sin(t * Math.PI) * 0.025;
  }

  const x = target.x + radius * Math.sin(alpha) * Math.cos(beta);
  const y = target.y - radius * Math.sin(beta);
  const z = target.z - radius * Math.cos(alpha) * Math.cos(beta);
  camera.position = new SPLAT.Vector3(x, y, z);
  controls.setCameraTarget(target);
  controls.update();
}

export const gsplatViewer: ViewerPlugin = {
  id: 'gsplat',
  label: '3D Gaussian Splat',
  badge: '3DGS',
  extensions: ['splat', 'ply', 'splatv'],
  mimeTypes: ['application/x-splat', 'model/x-splat'],

  async renderThumbnail(meta, fetchBuffer) {
    const ext = extOf(meta.name);
    if (ext === 'splatv') return null;
    const buffer = await fetchBuffer();

    const size = 360;
    const glCanvas = document.createElement('canvas');
    glCanvas.width = size;
    glCanvas.height = size;

    const scene = new SPLAT.Scene();
    const camera = new SPLAT.Camera();
    const splat =
      ext === 'ply'
        ? SPLAT.PLYLoader.LoadFromArrayBuffer(buffer, scene)
        : SPLAT.Loader.LoadFromArrayBuffer(buffer, scene);

    const stats = analyzeSplatScene(splat, meta.name);
    const fovFactor = stats.mode === 'push' ? 0.54 : 0.78;

    camera.data.fx = size * fovFactor;
    camera.data.fy = size * fovFactor;
    camera.data.setSize(size, size);

    const renderer = new SPLAT.WebGLRenderer(glCanvas, []);
    renderer.backgroundColor = new SPLAT.Color32(28, 30, 40, 255);
    renderer.setSize(size, size);
    updateCameraFocalLength(renderer, camera, size, size, fovFactor);

    const baseAlpha = stats.mode === 'push' ? -0.35 : 0.42;
    const baseBeta = stats.mode === 'push' ? 0.10 : 0.22;
    const controls = new SPLAT.OrbitControls(
      camera,
      glCanvas,
      baseAlpha,
      baseBeta,
      stats.idealRadius,
      false,
      stats.target,
    );
    controls.dampening = 1.0;

    // Wait until the WASM sort worker finishes its initial sort and populates _depthIndex
    for (let i = 0; i < 30; i++) {
      controls.update();
      renderer.render(scene, camera);
      await new Promise((r) => setTimeout(r, 45));
      const depthLen = (renderer.renderProgram as any)?._depthIndex?.length ?? 0;
      const updating = (renderer.renderProgram as any)?._renderData?.updating;
      if (i >= 6 && depthLen > 0 && !updating) break;
    }

    const outCanvas = document.createElement('canvas');
    outCanvas.width = 300;
    outCanvas.height = 300;
    const outCtx = outCanvas.getContext('2d', { willReadFrequently: true })!;

    const numFrames = 16;
    const frames: string[] = [];
    for (let f = 0; f < numFrames; f++) {
      const t = f / numFrames;
      applyCameraMotion(camera, controls, baseAlpha, baseBeta, stats.idealRadius, stats.target, stats.mode, t);
      // Trigger worker sort for new viewProj, wait for worker to finish, then render sorted frame
      renderer.render(scene, camera);
      await new Promise((r) => setTimeout(r, 75));
      renderer.render(scene, camera);

      outCtx.fillStyle = '#1c1e28';
      outCtx.fillRect(0, 0, 300, 300);
      outCtx.drawImage(glCanvas, 0, 0, size, size, 0, 0, 300, 300);
      autoToneMapCanvas(outCtx, 300, 300);
      frames.push(outCanvas.toDataURL('image/webp', 0.86));
    }

    controls.dispose();
    const gl = renderer.gl;
    renderer.dispose();
    gl?.getExtension('WEBGL_lose_context')?.loseContext();

    const payload: AnimatedSplatPreview = {
      kind: 'acv-anim-v4',
      mode: stats.mode,
      pingPong: true,
      poster: frames[0],
      frames,
    };
    return JSON.stringify(payload);
  },

  async mount(ctx) {
    const ext = extOf(ctx.meta.name);
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      width: '100%',
      height: '100%',
      display: 'block',
      cursor: 'grab',
    });
    ctx.container.appendChild(canvas);

    const hint = document.createElement('div');
    hint.className = 'hud-hint';
    hint.textContent = 'Left-drag: Orbit · Right-drag: Pan · Scroll: Zoom · WASD: Move';
    ctx.container.appendChild(hint);

    ctx.setProgress(2, `Checking cache for ${ctx.meta.name}…`);
    const cacheKey = `${ctx.meta.id || ctx.meta.damPath}:${ctx.meta.size || 0}`;
    let buffer: ArrayBuffer | null = null;
    let wasDecimated = false;
    let origSplats = 0;

    if (ext !== 'splatv') {
      buffer = await getCachedDecimatedSplat(cacheKey);
      if (buffer) wasDecimated = true;
    }

    if (!buffer) {
      if (ext === 'splatv') {
        buffer = await ctx.fetchBuffer((loaded, total) => {
          if (total && total > 0) {
            ctx.setProgress((loaded / total) * 90, `Downloading ${formatMB(loaded)} / ${formatMB(total)}`);
          }
        });
      } else {
        const res = await ctx.fetchResponse();
        const streamed = await streamAndDecimateSplatResponse(res, {
          ext,
          totalBytes: ctx.meta.size,
          maxSplats: 900_000,
          signal: ctx.signal,
          onProgress: (loaded, total, kept) => {
            if (total && total > 0) {
              const pct = (loaded / total) * 90;
              const decNote = total > 25 * 1048576 && kept ? ` · ${kept.toLocaleString()} splats kept` : '';
              ctx.setProgress(
                pct,
                `Streaming ${formatMB(loaded)} / ${formatMB(total)} (${Math.round((loaded / total) * 100)}%)${decNote}`,
              );
            } else {
              ctx.setProgress(50, `Streaming ${formatMB(loaded)}…`);
            }
          },
        });
        buffer = streamed.buffer;
        wasDecimated = streamed.wasDecimated;
        origSplats = streamed.originalSplats;
        if (wasDecimated || (ctx.meta.size && ctx.meta.size > 25 * 1048576)) {
          saveCachedDecimatedSplat(cacheKey, buffer).catch(() => {});
        }
      }
    }
    if (ctx.signal.aborted) return () => {};

    ctx.setProgress(95, 'Uploading Gaussian Splats to WebGL2…');

    const scene = new SPLAT.Scene();
    const camera = new SPLAT.Camera();
    const renderer = new SPLAT.WebGLRenderer(canvas);

    let bgIdx = 0;
    const applyBg = () => {
      const [r, g, b, a] = BACKGROUNDS[bgIdx].color;
      renderer.backgroundColor = new SPLAT.Color32(r, g, b, a);
      canvas.style.background = BACKGROUNDS[bgIdx].css;
    };
    applyBg();

    let controls = new SPLAT.OrbitControls(camera, canvas, 0.5, 0.5, 5, false);
    let splatCount = 0;
    let activeSplat: SPLAT.Splat | null = null;

    if (ext === 'splatv') {
      const file = new File([buffer], ctx.meta.name);
      const sv = await SPLAT.SplatvLoader.LoadFromFileAsync(file, scene, camera);
      splatCount = sv.data.vertexCount;
    } else {
      activeSplat = SPLAT.Loader.LoadFromArrayBuffer(buffer, scene);
      splatCount = activeSplat.data.vertexCount;
    }

    const stats = analyzeSplatScene(activeSplat, ctx.meta.name);
    let motionIdx = Math.max(0, MOTION_MODES.findIndex((m) => m.mode === stats.mode));
    let insideMode = stats.mode === 'push';

    const resize = () => {
      const r = ctx.container.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        renderer.setSize(r.width, r.height);
        updateCameraFocalLength(renderer, camera, r.width, r.height, insideMode ? 0.56 : 0.80);
      }
    };

    const applyCameraPreset = (inside: boolean) => {
      insideMode = inside;
      controls.dispose();
      // Pass enableKeyboardControls=false so typing into AEM metadata inputs in the side panel never moves the 3D camera
      controls = inside
        ? new SPLAT.OrbitControls(camera, canvas, -0.35, 0.10, stats.idealRadius, false, stats.target)
        : new SPLAT.OrbitControls(camera, canvas, 0.42, 0.22, Math.max(1.8, stats.idealRadius), false, stats.target);
      resize();
    };
    applyCameraPreset(insideMode);

    ctx.setProgress(null);

    const ro = new ResizeObserver(resize);
    ro.observe(ctx.container);

    let autoPlay = false;
    let animPhase = 0;
    let isCapturingGif = false;
    let thumbBtnLabel = '🎥 Save Card Anim';

    const resetCamera = () => {
      applyCameraPreset(insideMode);
      animPhase = 0;
    };

    const captureAnimatedCardPreview = async () => {
      if (isCapturingGif) return;
      isCapturingGif = true;
      const mode = MOTION_MODES[motionIdx].mode;
      thumbBtnLabel = `⏳ Recording ${mode.toUpperCase()}…`;
      renderToolbar();

      const p = camera.position;
      const dx = p.x - stats.target.x;
      const dy = p.y - stats.target.y;
      const dz = p.z - stats.target.z;
      const baseRadius = Math.max(0.4, Math.hypot(dx, dy, dz));
      const baseBeta = Math.asin(Math.max(-0.98, Math.min(0.98, -dy / baseRadius)));
      const baseAlpha = Math.atan2(dx, -dz);

      const prevDamp = controls.dampening;
      controls.dampening = 1.0;

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 300;
      thumbCanvas.height = 300;
      const tctx = thumbCanvas.getContext('2d', { willReadFrequently: true })!;

      const numFrames = 16;
      const frames: string[] = [];
      for (let f = 0; f < numFrames; f++) {
        if (ctx.signal.aborted) break;
        const t = f / numFrames;
        applyCameraMotion(camera, controls, baseAlpha, baseBeta, baseRadius, stats.target, mode, t);
        renderer.render(scene, camera);
        await new Promise((r) => setTimeout(r, 70));
        renderer.render(scene, camera);

        const sw = Math.min(canvas.width, canvas.height);
        const sx = (canvas.width - sw) / 2;
        const sy = (canvas.height - sw) / 2;
        tctx.fillStyle = '#1c1e28';
        tctx.fillRect(0, 0, 300, 300);
        tctx.drawImage(canvas, sx, sy, sw, sw, 0, 0, 300, 300);
        autoToneMapCanvas(tctx, 300, 300);
        frames.push(thumbCanvas.toDataURL('image/webp', 0.86));
      }

      applyCameraMotion(camera, controls, baseAlpha, baseBeta, baseRadius, stats.target, 'orbit', 0.5);
      controls.dampening = prevDamp;

      if (frames.length > 0) {
        const payload: AnimatedSplatPreview = {
          kind: 'acv-anim-v4',
          mode,
          pingPong: true,
          poster: frames[0],
          frames,
        };
        await ctx.saveCardThumbnail(JSON.stringify(payload));
      }

      isCapturingGif = false;
      thumbBtnLabel = `✓ ${mode.toUpperCase()} Saved`;
      renderToolbar();
      setTimeout(() => {
        thumbBtnLabel = '🎥 Save Card Anim';
        renderToolbar();
      }, 2000);
    };

    let countLabel =
      wasDecimated && origSplats > splatCount
        ? `${splatCount.toLocaleString()} / ${origSplats.toLocaleString()} splats (decimated to ${formatMB(buffer.byteLength)})`
        : `${splatCount.toLocaleString()} splats · ${formatMB(buffer.byteLength)}`;

    const reloadBufferIntoScene = (newBuf: ArrayBuffer, newOrigSplats?: number) => {
      buffer = newBuf;
      wasDecimated = true;
      if (newOrigSplats) origSplats = newOrigSplats;
      else if (!origSplats) origSplats = splatCount;
      if (activeSplat) scene.removeObject(activeSplat);
      activeSplat = SPLAT.Loader.LoadFromArrayBuffer(buffer, scene);
      splatCount = activeSplat.data.vertexCount;
      countLabel = `${splatCount.toLocaleString()} / ${origSplats.toLocaleString()} splats (decimated to ${formatMB(buffer.byteLength)})`;
      ctx.setStatus(countLabel);
      saveCachedDecimatedSplat(cacheKey, buffer).catch(() => {});
      renderToolbar();
    };

    const decimate50Percent = () => {
      if (!buffer || ext === 'splatv') return;
      const nextBuf = decimateSplatBufferInMemory(buffer, 0.5);
      reloadBufferIntoScene(nextBuf);
    };

    const pickAndDecimateLocalFile = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.splat,.ply';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const fileExt = extOf(file.name) || 'splat';
        ctx.setProgress(2, `Streaming local file ${file.name} (${formatMB(file.size)})…`);
        const fakeRes = new Response(file.stream(), {
          headers: { 'content-length': String(file.size) },
        });
        const streamed = await streamAndDecimateSplatResponse(fakeRes, {
          ext: fileExt,
          totalBytes: file.size,
          maxSplats: 800_000,
          signal: ctx.signal,
          onProgress: (loaded, total, kept) => {
            const pct = total ? (loaded / total) * 95 : 50;
            ctx.setProgress(
              pct,
              `Decimating ${file.name}: ${formatMB(loaded)} / ${formatMB(total || loaded)} · ${(kept || 0).toLocaleString()} splats kept`,
            );
          },
        });
        ctx.setProgress(null);
        reloadBufferIntoScene(streamed.buffer, streamed.originalSplats);
      };
      input.click();
    };

    const renderToolbar = () => {
      const m = MOTION_MODES[motionIdx];
      ctx.setActions([
        {
          id: 'autoplay',
          label: autoPlay ? `⏸ ${m.badge}` : `▶ ${m.badge}`,
          active: autoPlay,
          title: 'Preview the selected camera motion live in the viewer',
          onClick: () => {
            autoPlay = !autoPlay;
            renderToolbar();
          },
        },
        {
          id: 'motion-mode',
          label: m.label,
          title: 'Switch camera motion between Object Orbit, Scene Slow Push, and Scene Fixed Rotate',
          onClick: () => {
            motionIdx = (motionIdx + 1) % MOTION_MODES.length;
            renderToolbar();
          },
        },
        {
          id: 'capture-anim',
          label: thumbBtnLabel,
          title: 'Record a 16-frame animated Card View preview starting from the current camera angle',
          onClick: captureAnimatedCardPreview,
        },
        {
          id: 'decimate-50',
          label: '✂ -50%',
          title: 'Prune the least-visible 50% of splats in-place (by disk area × opacity²)',
          onClick: decimate50Percent,
        },
        {
          id: 'decimate-local',
          label: '📂 Local File…',
          title: 'Pick a massive .ply or .splat from your Mac, stream-decimate it in the browser, and export',
          onClick: pickAndDecimateLocalFile,
        },
        ...(activeSplat
          ? [
              {
                id: 'export-decimated',
                label: `⬇ .splat (${formatMB(buffer!.byteLength)})`,
                title: 'Download the current decimated .splat binary',
                onClick: () =>
                  activeSplat?.saveToFile(ctx.meta.name.replace(/\.[^.]+$/, '.decimated.splat'), 'splat'),
              },
            ]
          : []),
        {
          id: 'cam-preset',
          label: insideMode ? '🏠 Cam: Inside Room' : '🔭 Cam: Outside',
          title: 'Toggle camera between standing inside a room scene vs orbiting outside an object',
          onClick: () => {
            applyCameraPreset(!insideMode);
            renderToolbar();
          },
        },
        {
          id: 'reset',
          label: 'Reset',
          title: 'Reset camera position and target',
          onClick: resetCamera,
        },
        {
          id: 'bg',
          label: BACKGROUNDS[bgIdx].label,
          title: 'Cycle viewer background color',
          onClick: () => {
            bgIdx = (bgIdx + 1) % BACKGROUNDS.length;
            applyBg();
            renderToolbar();
          },
        },
      ]);
    };
    renderToolbar();

    let rafId = 0;
    let frames = 0;
    let totalFrames = 0;
    let autoSavedThumb = false;
    let lastFpsTick = performance.now();
    ctx.setStatus(countLabel);

    const tick = (now: number) => {
      if (ctx.signal.aborted) return;
      if (!isCapturingGif) {
        if (autoPlay) {
          animPhase = (animPhase + 0.0018) % 1;
          const mode = MOTION_MODES[motionIdx].mode;
          const t = 0.5 - 0.5 * Math.cos(animPhase * Math.PI * 2);
          applyCameraMotion(
            camera,
            controls,
            insideMode ? -0.35 : 0.42,
            insideMode ? 0.10 : 0.22,
            stats.idealRadius,
            stats.target,
            mode,
            t,
          );
        } else {
          controls.update();
        }
        renderer.render(scene, camera);
        totalFrames++;
        if (!autoSavedThumb && totalFrames === 90) {
          autoSavedThumb = true;
          captureAnimatedCardPreview().catch(() => {});
        }
      }

      frames++;
      if (now - lastFpsTick >= 600) {
        const fps = Math.round((frames * 1000) / (now - lastFpsTick));
        ctx.setStatus(`${countLabel} · ${fps} FPS`);
        frames = 0;
        lastFpsTick = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      const gl = renderer.gl;
      renderer.dispose();
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
      hint.remove();
    };
  },
};
