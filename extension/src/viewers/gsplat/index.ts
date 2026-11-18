import * as SPLAT from 'gsplat';
import type { ViewerPlugin } from '../types';

const BACKGROUNDS: { label: string; color: [number, number, number, number]; css: string }[] = [
  { label: 'BG: Dark', color: [20, 20, 22, 255], css: '#141416' },
  { label: 'BG: Slate', color: [42, 46, 55, 255], css: '#2a2e37' },
  { label: 'BG: Light', color: [232, 234, 238, 255], css: '#e8eaee' },
];

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const gsplatViewer: ViewerPlugin = {
  id: 'gsplat',
  label: '3D Gaussian Splat Viewer',
  badge: '3DGS',
  extensions: ['splat', 'ply', 'splatv'],
  mimeTypes: ['application/x-splat', 'model/x-splat'],
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

    ctx.setProgress(2, `Downloading ${ctx.meta.name}…`);
    const buffer = await ctx.fetchBuffer((loaded, total) => {
      if (total && total > 0) {
        const pct = (loaded / total) * 90;
        ctx.setProgress(pct, `Downloading ${formatMB(loaded)} / ${formatMB(total)} (${Math.round((loaded / total) * 100)}%)`);
      } else {
        ctx.setProgress(50, `Downloading ${formatMB(loaded)}…`);
      }
    });
    if (ctx.signal.aborted) return () => {};

    ctx.setProgress(95, 'Parsing Gaussian Splats & uploading to WebGL2…');

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

    if (ext === 'ply') {
      activeSplat = SPLAT.PLYLoader.LoadFromArrayBuffer(buffer, scene);
      splatCount = activeSplat.data.vertexCount;
    } else if (ext === 'splatv') {
      const file = new File([buffer], ctx.meta.name);
      const sv = await SPLAT.SplatvLoader.LoadFromFileAsync(file, scene, camera);
      splatCount = sv.data.vertexCount;
    } else {
      activeSplat = SPLAT.Loader.LoadFromArrayBuffer(buffer, scene);
      splatCount = activeSplat.data.vertexCount;
    }

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

    let autoRotate = false;
    let rotAngle = 0.5;
    const resetCamera = () => {
      controls.dispose();
      controls = new SPLAT.OrbitControls(camera, canvas);
      rotAngle = 0.5;
    };

    const renderToolbar = () => {
      ctx.setActions([
        {
          id: 'autorotate',
          label: autoRotate ? '⟳ Auto-Rotate: ON' : '⟳ Auto-Rotate',
          active: autoRotate,
          title: 'Orbit camera continuously around the scene',
          onClick: () => {
            autoRotate = !autoRotate;
            renderToolbar();
          },
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
        ...(activeSplat
          ? [
              {
                id: 'export-splat',
                label: 'Export .splat',
                title: 'Download normalized .splat binary',
                onClick: () => activeSplat?.saveToFile(ctx.meta.name.replace(/\.[^.]+$/, '.splat'), 'splat'),
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
    const countLabel = `${splatCount.toLocaleString()} splats · ${sizeLabel}`;
    ctx.setStatus(countLabel);

    const tick = (now: number) => {
      if (ctx.signal.aborted) return;
      if (autoRotate) {
        rotAngle += 0.006;
        const radius = 4.0;
        camera.position = new SPLAT.Vector3(Math.sin(rotAngle) * radius, -0.4, Math.cos(rotAngle) * radius);
        controls.setCameraTarget(new SPLAT.Vector3(0, 0, 0));
      }
      controls.update();
      renderer.render(scene, camera);

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
