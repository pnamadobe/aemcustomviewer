import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { ViewerPlugin } from '../types';
import type { AnimatedSplatPreview } from '../gsplat';

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

interface LoadedModel {
  root: THREE.Object3D;
  animations: THREE.AnimationClip[];
  vertices: number;
  triangles: number;
  meshes: number;
}

function upgradeLegacyMaterialsToPbr(root: THREE.Object3D) {
  const toRemove: THREE.Object3D[] = [];
  root.traverse((child) => {
    if ((child as THREE.Light).isLight || (child as THREE.Camera).isCamera) {
      toRemove.push(child);
      return;
    }
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry && !mesh.geometry.attributes.normal) {
      mesh.geometry.computeVertexNormals();
    }
    const upgradeOne = (m: THREE.Material): THREE.Material => {
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return m;
      const anyMat = m as any;
      const col: THREE.Color = anyMat.color ? anyMat.color.clone() : new THREE.Color(0xd4d4d8);
      // Desaturate pure CAD layer assignment colors (e.g. #ff00ff magenta on FBX zipper slides)
      const hsl = { h: 0, s: 0, l: 0 };
      col.getHSL(hsl);
      const nameLower = (m.name || '').toLowerCase();
      const isMetalPart = /(slide|pull|zipper|metal|brass|gold|silver|buckle|snap|rivet|eyelet)/.test(nameLower);
      if (hsl.s > 0.85 && (Math.abs(hsl.h - 0.83) < 0.08 || Math.abs(hsl.h - 0.33) < 0.08)) {
        // Pure magenta/green CAD placeholder -> brushed gunmetal or warm brass
        col.setHex(isMetalPart ? 0xd4af37 : 0xcbd5e1);
      }
      return new THREE.MeshStandardMaterial({
        name: m.name,
        color: col,
        map: anyMat.map ?? null,
        normalMap: anyMat.normalMap ?? null,
        bumpMap: anyMat.bumpMap ?? null,
        alphaMap: anyMat.alphaMap ?? null,
        transparent: Boolean(anyMat.transparent),
        opacity: typeof anyMat.opacity === 'number' ? anyMat.opacity : 1,
        roughness: isMetalPart ? 0.28 : 0.42,
        metalness: isMetalPart ? 0.78 : 0.12,
        side: THREE.DoubleSide,
      });
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(upgradeOne)
      : mesh.material
        ? upgradeOne(mesh.material)
        : new THREE.MeshStandardMaterial({ color: 0xd4d4d8, roughness: 0.38, metalness: 0.15, side: THREE.DoubleSide });
  });
  for (const obj of toRemove) obj.parent?.remove(obj);
}

async function parseModelBuffer(buffer: ArrayBuffer, ext: string): Promise<LoadedModel> {
  let root: THREE.Object3D;
  let animations: THREE.AnimationClip[] = [];

  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(buffer, '');
    root = gltf.scene;
    animations = gltf.animations || [];
  } else if (ext === 'fbx') {
    const loader = new FBXLoader();
    root = loader.parse(buffer, '');
    animations = (root as any).animations || [];
    upgradeLegacyMaterialsToPbr(root);
  } else if (ext === 'usdz' || ext === 'usda' || ext === 'usdc' || ext === 'usd') {
    const loader = new USDLoader();
    root = loader.parse(buffer);
    upgradeLegacyMaterialsToPbr(root);
  } else if (ext === 'dae') {
    const text = new TextDecoder().decode(buffer);
    const loader = new ColladaLoader();
    const collada = loader.parse(text, '');
    if (!collada) throw new Error('Invalid Collada DAE');
    root = collada.scene;
    animations = (collada as any).animations || [];
    upgradeLegacyMaterialsToPbr(root);
  } else if (ext === '3mf') {
    const loader = new ThreeMFLoader();
    root = loader.parse(buffer);
    root.rotation.set(-Math.PI / 2, 0, 0);
    upgradeLegacyMaterialsToPbr(root);
  } else if (ext === '3ds') {
    const loader = new TDSLoader();
    root = loader.parse(buffer, '');
    upgradeLegacyMaterialsToPbr(root);
  } else if (ext === 'amf') {
    const loader = new AMFLoader();
    root = loader.parse(buffer);
    upgradeLegacyMaterialsToPbr(root);
  } else if (ext === 'obj') {
    const text = new TextDecoder().decode(buffer);
    const loader = new OBJLoader();
    root = loader.parse(text);
    root.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        (child as THREE.Mesh).material = new THREE.MeshStandardMaterial({
          color: 0xd4d4d8,
          roughness: 0.38,
          metalness: 0.15,
          side: THREE.DoubleSide,
        });
      }
    });
  } else if (ext === 'stl') {
    const loader = new STLLoader();
    const geom = loader.parse(buffer);
    geom.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x93c5fd,
      roughness: 0.32,
      metalness: 0.25,
    });
    root = new THREE.Mesh(geom, mat);
  } else {
    throw new Error(`Unsupported 3D extension: ${ext}`);
  }

  // Normalize scale and center at origin using mesh bounds
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  root.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (m.isMesh && m.geometry) {
      box.expandByObject(m);
    }
  });
  if (box.isEmpty()) box.setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 2.2 / maxDim;

  const wrapper = new THREE.Group();
  root.position.sub(center);
  wrapper.add(root);
  wrapper.scale.setScalar(scale);
  root = wrapper;

  let vertices = 0;
  let triangles = 0;
  let meshes = 0;
  root.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (m.isMesh && m.geometry) {
      meshes++;
      const pos = m.geometry.attributes.position;
      if (pos) vertices += pos.count;
      if (m.geometry.index) {
        triangles += Math.floor(m.geometry.index.count / 3);
      } else if (pos) {
        triangles += Math.floor(pos.count / 3);
      }
    }
  });

  return { root, animations, vertices, triangles, meshes };
}

function setupStudioScene(renderer: THREE.WebGLRenderer): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14151a);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
  keyLight.position.set(3, 5, 4);
  const rimLight = new THREE.DirectionalLight(0x93c5fd, 0.8);
  rimLight.position.set(-4, 2, -3);
  scene.add(keyLight, rimLight);
  return scene;
}

export const model3dViewer: ViewerPlugin = {
  id: 'model3d',
  label: '3D Model & Mesh',
  badge: '3D',
  extensions: ['glb', 'gltf', 'fbx', 'obj', 'stl', 'usdz', 'usda', 'usdc', 'usd', 'dae', '3mf', '3ds', 'amf'],
  mimeTypes: [
    'model/gltf-binary',
    'model/gltf+json',
    'model/obj',
    'model/stl',
    'model/vnd.usdz+zip',
    'model/vnd.usd',
    'model/vnd.collada+xml',
    'model/3mf',
    'application/x-fbx',
    'application/sla',
  ],

  async renderThumbnail(meta, fetchBuffer) {
    const ext = extOf(meta.name);
    const buffer = await fetchBuffer();
    const { root } = await parseModelBuffer(buffer, ext);

    const size = 280;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(size, size, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    const scene = setupStudioScene(renderer);
    scene.add(root);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100);
    const radius = 3.2;
    const baseBeta = 0.32;
    const baseAlpha = 0.55;

    const numFrames = 16;
    const frames: string[] = [];
    for (let f = 0; f < numFrames; f++) {
      const t = f / numFrames;
      const alpha = baseAlpha + (t - 0.5) * 0.62;
      camera.position.set(
        radius * Math.sin(alpha) * Math.cos(baseBeta),
        radius * Math.sin(baseBeta),
        radius * Math.cos(alpha) * Math.cos(baseBeta),
      );
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      frames.push(canvas.toDataURL('image/webp', 0.84));
    }

    renderer.dispose();
    renderer.forceContextLoss();
    const payload: AnimatedSplatPreview = {
      kind: 'acv-anim-v4',
      mode: 'orbit',
      pingPong: true,
      poster: frames[0],
      frames,
    };
    return JSON.stringify(payload);
  },

  async mount(ctx) {
    const ext = extOf(ctx.meta.name);
    ctx.setProgress(5, `Downloading ${ctx.meta.name}…`);
    const buffer = await ctx.fetchBuffer((loaded, total) => {
      if (total) ctx.setProgress((loaded / total) * 88);
    });
    if (ctx.signal.aborted) return () => {};

    ctx.setProgress(94, 'Parsing 3D geometry & materials…');
    const loaded = await parseModelBuffer(buffer, ext);
    ctx.setProgress(null);

    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block', cursor: 'grab' });
    ctx.container.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    const scene = setupStudioScene(renderer);
    scene.add(loaded.root);

    const grid = new THREE.GridHelper(6, 16, 0x3b82f6, 0x27272a);
    grid.position.y = -1.1;
    scene.add(grid);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
    camera.position.set(2.2, 1.3, 2.8);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 1.6;

    // Animation mixer if GLB has animations
    let mixer: THREE.AnimationMixer | null = null;
    let animPlaying = true;
    if (loaded.animations.length > 0) {
      mixer = new THREE.AnimationMixer(loaded.root);
      mixer.clipAction(loaded.animations[0]).play();
    }

    // Store original materials for Clay / Normals / Wireframe switching
    const origMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    loaded.root.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (m.isMesh) origMaterials.set(m, m.material);
    });

    let shadingMode: 'pbr' | 'clay' | 'normals' = 'pbr';
    let wireframe = false;
    let showGrid = true;
    let saveBtnLabel = '🎥 Save Animated Preview';

    const applyShading = () => {
      loaded.root.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (!m.isMesh) return;
        if (shadingMode === 'pbr') {
          m.material = origMaterials.get(m)!;
        } else if (shadingMode === 'clay') {
          m.material = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.42, metalness: 0.05 });
        } else {
          m.material = new THREE.MeshNormalMaterial();
        }
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) (mat as any).wireframe = wireframe;
      });
    };

    const capturePreview = async () => {
      saveBtnLabel = '⏳ Recording…';
      renderToolbar();
      const p = camera.position.clone();
      const radius = p.length() || 3.2;
      const baseBeta = Math.asin(Math.max(-0.98, Math.min(0.98, p.y / radius)));
      const baseAlpha = Math.atan2(p.x, p.z);

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 280;
      thumbCanvas.height = 280;
      const tctx = thumbCanvas.getContext('2d')!;

      const frames: string[] = [];
      for (let f = 0; f < 16; f++) {
        const t = f / 16;
        const alpha = baseAlpha + (t - 0.5) * 0.62;
        camera.position.set(
          radius * Math.sin(alpha) * Math.cos(baseBeta),
          radius * Math.sin(baseBeta),
          radius * Math.cos(alpha) * Math.cos(baseBeta),
        );
        camera.lookAt(controls.target);
        renderer.render(scene, camera);
        const sw = Math.min(canvas.width, canvas.height);
        tctx.drawImage(canvas, (canvas.width - sw) / 2, (canvas.height - sw) / 2, sw, sw, 0, 0, 280, 280);
        frames.push(thumbCanvas.toDataURL('image/webp', 0.84));
      }
      camera.position.copy(p);
      controls.update();

      const payload: AnimatedSplatPreview = {
        kind: 'acv-anim-v4',
        mode: 'orbit',
        pingPong: true,
        poster: frames[0],
        frames,
      };
      await ctx.saveCardThumbnail(JSON.stringify(payload));
      saveBtnLabel = '✓ Preview Saved';
      renderToolbar();
      setTimeout(() => {
        saveBtnLabel = '🎥 Save Animated Preview';
        renderToolbar();
      }, 1800);
    };

    const renderToolbar = () => {
      ctx.setActions([
        {
          id: 'autorotate',
          label: controls.autoRotate ? '⟳ Turntable: ON' : '⟳ Turntable',
          active: controls.autoRotate,
          onClick: () => {
            controls.autoRotate = !controls.autoRotate;
            renderToolbar();
          },
        },
        {
          id: 'shading',
          label: `Shading: ${shadingMode.toUpperCase()}`,
          onClick: () => {
            shadingMode = shadingMode === 'pbr' ? 'clay' : shadingMode === 'clay' ? 'normals' : 'pbr';
            applyShading();
            renderToolbar();
          },
        },
        {
          id: 'wireframe',
          label: wireframe ? 'Wireframe: ON' : 'Wireframe',
          active: wireframe,
          onClick: () => {
            wireframe = !wireframe;
            applyShading();
            renderToolbar();
          },
        },
        {
          id: 'grid',
          label: showGrid ? 'Grid: ON' : 'Grid: OFF',
          active: showGrid,
          onClick: () => {
            showGrid = !showGrid;
            grid.visible = showGrid;
            renderToolbar();
          },
        },
        ...(mixer
          ? [
              {
                id: 'anim',
                label: animPlaying ? '⏸ Anim' : '▶ Anim',
                active: animPlaying,
                onClick: () => {
                  animPlaying = !animPlaying;
                  mixer!.timeScale = animPlaying ? 1 : 0;
                  renderToolbar();
                },
              },
            ]
          : []),
        {
          id: 'save-preview',
          label: saveBtnLabel,
          onClick: capturePreview,
        },
      ]);
    };
    renderToolbar();

    const resize = () => {
      const r = ctx.container.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        camera.aspect = r.width / r.height;
        camera.updateProjectionMatrix();
        renderer.setSize(r.width, r.height, false);
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(ctx.container);
    resize();

    const statsBase = `${loaded.triangles.toLocaleString()} tris · ${loaded.vertices.toLocaleString()} verts · ${loaded.meshes} mesh${loaded.meshes === 1 ? '' : 'es'}`;
    ctx.setStatus(statsBase);

    const clock = new THREE.Clock();
    let raf = 0;
    let frames = 0;
    let lastFps = performance.now();

    const tick = (now: number) => {
      if (ctx.signal.aborted) return;
      const dt = clock.getDelta();
      mixer?.update(dt);
      controls.update();
      renderer.render(scene, camera);

      frames++;
      if (now - lastFps >= 600) {
        const fps = Math.round((frames * 1000) / (now - lastFps));
        ctx.setStatus(`${statsBase} · ${fps} FPS`);
        frames = 0;
        lastFps = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  },
};
