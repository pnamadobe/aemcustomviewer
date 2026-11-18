import * as SPLAT from 'gsplat';
import type { ViewerPlugin } from '../types';
import {
  getCachedDecimatedSplat,
  saveCachedDecimatedSplat,
  streamAndDecimateSplatResponse,
} from './stream-decimate';

export type SplatMotionMode = 'orbit' | 'push' | 'pan';

export interface AnimatedSplatPreview {
  kind: 'acv-anim-v2';
  mode: SplatMotionMode;
  pingPong: boolean;
  poster: string;
  frames: string[];
}

const BACKGROUNDS: { label: string; color: [number, number, number, number]; css: string }[] = [
  { label: 'BG: Dark', color: [20, 20, 22, 255], css: '#141416' },
  { label: 'BG: Slate', color: [42, 46, 55, 255], css: '#2a2e37' },
  { label: 'BG: Light', color: [232, 234, 238, 255], css: '#e8eaee' },
];

const MOTION_MODES: { mode: SplatMotionMode; label: string; badge: string }[] = [
  { mode: 'orbit', label: 'Motion: Orbit (Object)', badge: 'ORBIT' },
  { mode: 'push', label: 'Motion: Slow Push (Scene)', badge: 'PUSH' },
  { mode: 'pan', label: 'Motion: Fixed Rotate (Scene)', badge: 'PAN' },
];

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Heuristic to distinguish bounded object splats from unbounded room/environment scenes:
 * Samples splat radial distances around the centroid and compares the 90th-percentile
 * radius (outer background/walls) to the median radius (foreground core).
 */
function detectSplatMotionMode(splat: SPLAT.Splat | null): SplatMotionMode {
  if (!splat) return 'orbit';
  const pos = splat.data.positions;
  const n = splat.data.vertexCount;
  if (!pos || n < 100) return 'orbit';

  const step = Math.max(1, Math.floor(n / 600));
  let cx = 0,
    cy = 0,
    cz = 0,
    count = 0;
  for (let i = 0; i < n; i += step) {
    cx += pos[i * 3];
    cy += pos[i * 3 + 1];
    cz += pos[i * 3 + 2];
    count++;
  }
  cx /= count;
  cy /= count;
  cz /= count;

  const radii: number[] = [];
  for (let i = 0; i < n; i += step) {
    const dx = pos[i * 3] - cx;
    const dy = pos[i * 3 + 1] - cy;
    const dz = pos[i * 3 + 2] - cz;
    radii.push(Math.hypot(dx, dy, dz));
  }
  radii.sort((a, b) => a - b);
  const r50 = radii[Math.floor(radii.length * 0.5)] || 1;
  const r90 = radii[Math.floor(radii.length * 0.9)] || 1;

  // Wide outer distribution relative to core => environment/scene splat => slow dolly push
  return r90 / r50 > 2.8 ? 'push' : 'orbit';
}

/**
 * Computes camera position and target for frame t in [0..1) given a starting spherical
 * camera pose and motion mode.
 */
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
    // Calm ±18° turntable arc (ping-pong) so all 16 frames stay densely packed & subtle
    alpha = baseAlpha + (t - 0.5) * 0.62;
    beta = baseBeta + Math.sin(t * Math.PI) * 0.03;
  } else if (mode === 'push') {
    // Slow, subtle 14% cinema dolly push-in + gentle ±5° parallax drift
    radius = baseRadius * (1 - 0.14 * t);
    alpha = baseAlpha + Math.sin(t * Math.PI) * 0.09;
    beta = baseBeta - Math.sin(t * Math.PI) * 0.025;
  } else {
    // Subtle fixed-tripod ±12° horizontal pan
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
    const size = 280;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const scene = new SPLAT.Scene();
    const camera = new SPLAT.Camera();
    const renderer = new SPLAT.WebGLRenderer(canvas, []);
    renderer.backgroundColor = new SPLAT.Color32(20, 22, 28, 255);
    renderer.setSize(size, size);

    const controls = new SPLAT.OrbitControls(camera, canvas, 0.5, 0.32, 4.2, false);
    const splat =
      ext === 'ply'
        ? SPLAT.PLYLoader.LoadFromArrayBuffer(buffer, scene)
        : SPLAT.Loader.LoadFromArrayBuffer(buffer, scene);

    const mode = detectSplatMotionMode(splat);
    const target = new SPLAT.Vector3(0, 0, 0);

    // Warm up WASM depth-sort worker on initial pose
    for (let i = 0; i < 16; i++) {
      controls.update();
      renderer.render(scene, camera);
      await new Promise((r) => setTimeout(r, 30));
      const updating = (renderer.renderProgram as any)?._renderData?.updating;
      if (i >= 4 && !updating) break;
    }

    const numFrames = 16;
    const frames: string[] = [];
    for (let f = 0; f < numFrames; f++) {
      const t = f / numFrames;
      applyCameraMotion(camera, controls, 0.5, 0.32, 4.2, target, mode, t);
      // Allow sort worker to sort new camera angle
      renderer.render(scene, camera);
      await new Promise((r) => setTimeout(r, 45));
      renderer.render(scene, camera);
      frames.push(canvas.toDataURL('image/webp', 0.82));
    }

    controls.dispose();
    renderer.dispose();

    const payload: AnimatedSplatPreview = {
      kind: 'acv-anim-v2',
      mode,
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
          maxSplats: 600_000,
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

    let controls = new SPLAT.OrbitControls(camera, canvas);
    let splatCount = 0;
    let activeSplat: SPLAT.Splat | null = null;

    if (ext === 'splatv') {
      const file = new File([buffer], ctx.meta.name);
      const sv = await SPLAT.SplatvLoader.LoadFromFileAsync(file, scene, camera);
      splatCount = sv.data.vertexCount;
    } else {
      // streamAndDecimateSplatResponse always outputs normalized 32-byte .splat records (even when input was .ply)
      activeSplat = SPLAT.Loader.LoadFromArrayBuffer(buffer, scene);
      splatCount = activeSplat.data.vertexCount;
    }

    const detectedMode = detectSplatMotionMode(activeSplat);
    let motionIdx = Math.max(0, MOTION_MODES.findIndex((m) => m.mode === detectedMode));

    ctx.setProgress(null);

    const resize = () => {
      const r = ctx.container.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        renderer.setSize(r.width, r.height);
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(ctx.container);
    resize();

    let autoPlay = false;
    let animPhase = 0;
    let isCapturingGif = false;
    let thumbBtnLabel = '🎥 Save Animated Preview';

    const resetCamera = () => {
      controls.dispose();
      controls = new SPLAT.OrbitControls(camera, canvas);
      animPhase = 0;
    };

    const captureAnimatedCardPreview = async () => {
      if (isCapturingGif) return;
      isCapturingGif = true;
      const mode = MOTION_MODES[motionIdx].mode;
      thumbBtnLabel = `⏳ Recording ${mode.toUpperCase()}…`;
      renderToolbar();

      // Snapshot user's current spherical camera pose relative to origin
      const p = camera.position;
      const baseRadius = Math.max(0.5, Math.hypot(p.x, p.y, p.z));
      const baseBeta = Math.asin(Math.max(-0.98, Math.min(0.98, -p.y / baseRadius)));
      const baseAlpha = Math.atan2(p.x, -p.z);
      const target = new SPLAT.Vector3(0, 0, 0);

      // Small offscreen canvas to scale down each captured frame cleanly
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 280;
      thumbCanvas.height = 280;
      const tctx = thumbCanvas.getContext('2d')!;

      const numFrames = 16;
      const frames: string[] = [];
      for (let f = 0; f < numFrames; f++) {
        if (ctx.signal.aborted) break;
        const t = f / numFrames;
        applyCameraMotion(camera, controls, baseAlpha, baseBeta, baseRadius, target, mode, t);
        renderer.render(scene, camera);
        await new Promise((r) => setTimeout(r, 45));
        renderer.render(scene, camera);

        // Center-crop square from live WebGL2 canvas
        const sw = Math.min(canvas.width, canvas.height);
        const sx = (canvas.width - sw) / 2;
        const sy = (canvas.height - sw) / 2;
        tctx.drawImage(canvas, sx, sy, sw, sw, 0, 0, 280, 280);
        frames.push(thumbCanvas.toDataURL('image/webp', 0.82));
      }

      // Restore user's starting camera pose
      applyCameraMotion(camera, controls, baseAlpha, baseBeta, baseRadius, target, 'orbit', 0);

      if (frames.length > 0) {
        const payload: AnimatedSplatPreview = {
          kind: 'acv-anim-v2',
          mode,
          pingPong: true,
          poster: frames[0],
          frames,
        };
        await ctx.saveCardThumbnail(JSON.stringify(payload));
      }

      isCapturingGif = false;
      thumbBtnLabel = `✓ ${mode.toUpperCase()} Preview Saved`;
      renderToolbar();
      setTimeout(() => {
        thumbBtnLabel = '🎥 Save Animated Preview';
        renderToolbar();
      }, 2000);
    };

    const renderToolbar = () => {
      const m = MOTION_MODES[motionIdx];
      ctx.setActions([
        {
          id: 'autoplay',
          label: autoPlay ? `▶ Preview ${m.badge}: ON` : `▶ Preview ${m.badge}`,
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
          id: 'reset',
          label: 'Reset View',
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
        ...(wasDecimated && activeSplat
          ? [
              {
                id: 'export-decimated',
                label: `⬇ Export Decimated (${formatMB(buffer!.byteLength)})`,
                title: 'Download the decimated .splat binary',
                onClick: () =>
                  activeSplat?.saveToFile(ctx.meta.name.replace(/\.[^.]+$/, '.decimated.splat'), 'splat'),
              },
            ]
          : []),
      ]);
    };
    renderToolbar();

    let rafId = 0;
    let frames = 0;
    let lastFpsTick = performance.now();
    const sizeLabel = formatMB(buffer.byteLength);
    const decLabel =
      wasDecimated && origSplats > splatCount
        ? `${splatCount.toLocaleString()} / ${origSplats.toLocaleString()} splats (decimated to ${sizeLabel})`
        : `${splatCount.toLocaleString()} splats · ${sizeLabel}`;
    const countLabel = decLabel;
    ctx.setStatus(countLabel);

    const tick = (now: number) => {
      if (ctx.signal.aborted) return;
      if (!isCapturingGif) {
        if (autoPlay) {
          animPhase = (animPhase + 0.0018) % 1;
          const mode = MOTION_MODES[motionIdx].mode;
          const t = 0.5 - 0.5 * Math.cos(animPhase * Math.PI * 2);
          applyCameraMotion(camera, controls, 0.5, 0.32, 4.0, new SPLAT.Vector3(0, 0, 0), mode, t);
        } else {
          controls.update();
        }
        renderer.render(scene, camera);
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
      renderer.dispose();
      canvas.remove();
      hint.remove();
    };
  },
};
