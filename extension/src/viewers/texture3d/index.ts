import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { KTXLoader } from 'three/examples/jsm/loaders/KTXLoader.js';
import { TIFFLoader } from 'three/examples/jsm/loaders/TIFFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { unzipSync } from 'fflate';
import type { ViewerPlugin } from '../types';
import type { AnimatedSplatPreview } from '../gsplat';

export type MapChannel =
  | 'basecolor'
  | 'normal'
  | 'roughness'
  | 'metalness'
  | 'ao'
  | 'displacement'
  | 'alpha'
  | 'specular'
  | 'sheen'
  | 'clearcoat'
  | 'emissive';

const CHANNEL_LABELS: Record<MapChannel, string> = {
  basecolor: 'Base Color',
  normal: 'Normal',
  roughness: 'Roughness',
  metalness: 'Metalness',
  ao: 'Ambient Occlusion',
  displacement: 'Height / Disp',
  alpha: 'Alpha / Opacity',
  specular: 'Specular',
  sheen: 'Sheen',
  clearcoat: 'Clearcoat',
  emissive: 'Emissive',
};

const CHANNEL_ORDER: MapChannel[] = [
  'basecolor',
  'normal',
  'roughness',
  'metalness',
  'ao',
  'displacement',
  'alpha',
  'specular',
  'sheen',
  'clearcoat',
  'emissive',
];

const SRGB_CHANNELS = new Set<MapChannel>(['basecolor', 'sheen', 'emissive', 'specular']);

export interface LoadedTextureMap {
  channel: MapChannel;
  label: string;
  fileName: string;
  width: number;
  height: number;
  texture: THREE.Texture;
  previewUrl: string;
  invert?: boolean; // e.g., when a glossiness map is used for roughness
}

export interface U3mSideSpec {
  baseColor: THREE.Color;
  roughness: number;
  metalness: number;
  normalScale: number;
  displacementScale: number;
  alpha: number;
  ior: number;
  sheen: number;
  sheenColor: THREE.Color;
  sheenRoughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  specularIntensity: number;
  transmission: number;
  physicalWidthCm?: number;
  physicalHeightCm?: number;
  dpi?: number;
  maps: Partial<Record<MapChannel, LoadedTextureMap>>;
}

export interface ParsedMaterialAsset {
  formatLabel: string;
  materialName: string;
  schemaVersion?: string;
  description?: string;
  front: U3mSideSpec;
  back?: U3mSideSpec;
  allMaps: LoadedTextureMap[];
  fabricPhysics: Array<{ label: string; value: string }>;
  rawJsonText?: string;
  /** Present when a .u3ma/.zfab archive is a 3D Trim package containing an embedded .fbx/.obj mesh */
  trimModel?: THREE.Object3D;
  trimParts?: Array<{ name: string; spec: U3mSideSpec }>;
}

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function baseNameOf(path: string): string {
  const norm = path.replace(/\\/g, '/');
  return norm.split('/').pop() || norm;
}

function normPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .trim();
}

function isZipBuffer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const u8 = new Uint8Array(buf, 0, 4);
  return u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07);
}

function defaultSideSpec(): U3mSideSpec {
  return {
    baseColor: new THREE.Color(0xffffff),
    roughness: 0.72,
    metalness: 0.0,
    normalScale: 1.0,
    displacementScale: 0.008,
    alpha: 1.0,
    ior: 1.46,
    sheen: 0.08,
    sheenColor: new THREE.Color(0xffffff),
    sheenRoughness: 0.65,
    clearcoat: 0.0,
    clearcoatRoughness: 0.2,
    specularIntensity: 0.5,
    transmission: 0.0,
    maps: {},
  };
}

function parseColorValue(val: any): THREE.Color | null {
  if (!val) return null;
  if (typeof val === 'string') {
    try {
      return new THREE.Color(val);
    } catch {
      return null;
    }
  }
  if (Array.isArray(val) && val.length >= 3) {
    const [r, g, b] = val.map(Number);
    const scale = r > 1 || g > 1 || b > 1 ? 1 / 255 : 1;
    return new THREE.Color(r * scale, g * scale, b * scale);
  }
  if (typeof val === 'object') {
    const r = Number(val.r ?? val.red ?? val.x);
    const g = Number(val.g ?? val.green ?? val.y);
    const b = Number(val.b ?? val.blue ?? val.z);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      const scale = r > 1 || g > 1 || b > 1 ? 1 / 255 : 1;
      return new THREE.Color(r * scale, g * scale, b * scale);
    }
  }
  return null;
}

function parseNumberValue(val: any): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    if (Number.isFinite(n)) return n;
  }
  if (val && typeof val === 'object') {
    if (typeof val.constant === 'number') return val.constant;
    if (typeof val.value === 'number') return val.value;
    if (typeof val.factor === 'number') return val.factor;
  }
  return null;
}

function classifyChannelFromFilename(filename: string): { channel: MapChannel; invert?: boolean } | null {
  const lower = baseNameOf(filename).toLowerCase().replace(/\.[^.]+$/, '');
  if (/(^|[_\-. ])(basecolor|base_color|diffuse|albedo|color|col|diff|fabric|tex)($|[_\-. 0-9])/.test(lower)) {
    return { channel: 'basecolor' };
  }
  if (/(^|[_\-. ])(normal|norm|nrm|nor|nml|normalgl|normaldx)($|[_\-. 0-9])/.test(lower)) {
    return { channel: 'normal' };
  }
  if (/(^|[_\-. ])(roughness|rough|rgh|specularroughness)($|[_\-. 0-9])/.test(lower)) {
    return { channel: 'roughness' };
  }
  if (/(^|[_\-. ])(glossiness|gloss|gls|smoothness)($|[_\-. 0-9])/.test(lower)) {
    return { channel: 'roughness', invert: true };
  }
  if (/(^|[_\-. ])(metalness|metallic|metal|met|mtl)($|[_\-. 0-9])/.test(lower)) {
    return { channel: 'metalness' };
  }
  if (/(^|[_\-. ])(ambientocclusion|ambient_occlusion|occlusion|ao|occ)($|[_\-. 0-9])/.test(lower)) {
    return { channel: 'ao' };
  }
  if (/(^|[_\-. ])(displacement|disp|height|hgt|bump|bmp)($|[_\-. 0-9])/.test(lower)) {
    return { channel: 'displacement' };
  }
  if (/(^|[_\-. ])(alpha|opacity|opac|transparency|mask|trans)($|[_\-. 0-9])/.test(lower)) {
    return { channel: 'alpha' };
  }
  if (/(^|[_\-. ])(specular|spec|spc|reflection|refl)($|[_\-. 0-9])/.test(lower)) {
    return { channel: 'specular' };
  }
  if (/(^|[_\-. ])(sheen|fuzz|velvet)($|[_\-. 0-9])/.test(lower)) {
    return { channel: 'sheen' };
  }
  if (/(^|[_\-. ])(clearcoat|coat)($|[_\-. 0-9])/.test(lower)) {
    return { channel: 'clearcoat' };
  }
  if (/(^|[_\-. ])(emissive|emission|emit)($|[_\-. 0-9])/.test(lower)) {
    return { channel: 'emissive' };
  }
  return null;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'tga', 'dds', 'ktx']);

function rgbaToPreviewDataUrl(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, flipY = false): {
  canvas: HTMLCanvasElement;
  previewUrl: string;
} {
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = width;
  srcCanvas.height = height;
  const sctx = srcCanvas.getContext('2d')!;
  const clamped = new Uint8ClampedArray(width * height * 4);
  if (flipY) {
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const srcOff = (height - 1 - y) * rowBytes;
      const dstOff = y * rowBytes;
      clamped.set(rgba.subarray(srcOff, srcOff + rowBytes), dstOff);
    }
  } else {
    clamped.set(rgba.subarray(0, width * height * 4));
  }
  sctx.putImageData(new ImageData(clamped, width, height), 0, 0);

  const maxThumb = 256;
  const scale = Math.min(1, maxThumb / Math.max(width, height, 1));
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));
  const thumb = document.createElement('canvas');
  thumb.width = tw;
  thumb.height = th;
  thumb.getContext('2d')!.drawImage(srcCanvas, 0, 0, tw, th);
  return { canvas: srcCanvas, previewUrl: thumb.toDataURL('image/webp', 0.85) };
}

function invertGrayscaleCanvas(src: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0, width, height);
  const imgData = ctx.getImageData(0, 0, width, height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
  ctx.putImageData(imgData, 0, 0);
  return c;
}

async function decodeTextureBytes(
  bytes: Uint8Array,
  fileName: string,
  channel: MapChannel,
  invert = false,
): Promise<LoadedTextureMap> {
  const ext = extOf(fileName);
  const isSrgb = SRGB_CHANNELS.has(channel);
  const sliceBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  let texture: THREE.Texture;
  let width = 512;
  let height = 512;
  let previewUrl = '';

  if (ext === 'dds') {
    const loader = new DDSLoader();
    const dds = loader.parse(sliceBuf, true);
    width = dds.width || 512;
    height = dds.height || 512;
    const compressed = new THREE.CompressedTexture(
      dds.mipmaps as ImageData[],
      width,
      height,
      dds.format as THREE.CompressedPixelFormat,
    );
    if (dds.mipmapCount === 1) compressed.minFilter = THREE.LinearFilter;
    compressed.needsUpdate = true;
    texture = compressed;
    previewUrl = makeBadgePlaceholderDataUrl('DDS', width, height, CHANNEL_LABELS[channel]);
  } else if (ext === 'ktx') {
    const loader = new KTXLoader();
    const ktx = loader.parse(sliceBuf, true);
    width = ktx.width || 512;
    height = ktx.height || 512;
    const compressed = new THREE.CompressedTexture(
      ktx.mipmaps as ImageData[],
      width,
      height,
      ktx.format as THREE.CompressedPixelFormat,
    );
    if (ktx.mipmapCount === 1) compressed.minFilter = THREE.LinearFilter;
    compressed.needsUpdate = true;
    texture = compressed;
    previewUrl = makeBadgePlaceholderDataUrl('KTX', width, height, CHANNEL_LABELS[channel]);
  } else if (ext === 'tga') {
    const loader = new TGALoader();
    const parsed = loader.parse(sliceBuf) as any;
    width = parsed.width || 512;
    height = parsed.height || 512;
    const { canvas, previewUrl: purl } = rgbaToPreviewDataUrl(parsed.data, width, height, Boolean(parsed.flipY));
    const finalCanvas = invert ? invertGrayscaleCanvas(canvas, width, height) : canvas;
    texture = new THREE.CanvasTexture(finalCanvas);
    previewUrl = purl;
  } else if (ext === 'tif' || ext === 'tiff') {
    const loader = new TIFFLoader();
    const parsed = loader.parse(sliceBuf as any) as any;
    width = parsed.width || 512;
    height = parsed.height || 512;
    const { canvas, previewUrl: purl } = rgbaToPreviewDataUrl(parsed.data, width, height, false);
    const finalCanvas = invert ? invertGrayscaleCanvas(canvas, width, height) : canvas;
    texture = new THREE.CanvasTexture(finalCanvas);
    previewUrl = purl;
  } else {
    const mime =
      ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : ext === 'bmp'
              ? 'image/bmp'
              : 'image/jpeg';
    const blob = new Blob([sliceBuf], { type: mime });
    const bmp = await createImageBitmap(blob);
    width = bmp.width;
    height = bmp.height;

    const maxThumb = 256;
    const scale = Math.min(1, maxThumb / Math.max(width, height, 1));
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));
    const thumb = document.createElement('canvas');
    thumb.width = tw;
    thumb.height = th;
    thumb.getContext('2d')!.drawImage(bmp, 0, 0, tw, th);
    previewUrl = thumb.toDataURL('image/webp', 0.85);

    if (invert) {
      const invCanvas = invertGrayscaleCanvas(bmp, width, height);
      bmp.close();
      texture = new THREE.CanvasTexture(invCanvas);
    } else {
      texture = new THREE.Texture(bmp as any);
      texture.needsUpdate = true;
    }
  }

  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = isSrgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  return {
    channel,
    label: CHANNEL_LABELS[channel],
    fileName: baseNameOf(fileName),
    width,
    height,
    texture,
    previewUrl,
    invert,
  };
}

function makeBadgePlaceholderDataUrl(fmt: string, w: number, h: number, label: string): string {
  const c = document.createElement('canvas');
  c.width = 200;
  c.height = 200;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 200, 200);
  grad.addColorStop(0, '#1e293b');
  grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#38bdf8';
  ctx.font = '700 26px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(fmt, 100, 88);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText(label, 100, 118);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 12px ui-monospace, monospace';
  ctx.fillText(`${w}×${h}`, 100, 142);
  return c.toDataURL('image/webp', 0.85);
}

/**
 * Generates procedural fabric weave textures when a standalone .u3m/.mtl/.mtlx
 * has only numeric/color constants and no embedded raster maps.
 */
function buildProceduralWeaveMaps(baseColor: THREE.Color, roughness: number): {
  basecolor: LoadedTextureMap;
  normal: LoadedTextureMap;
} {
  const size = 256;
  const colCanvas = document.createElement('canvas');
  colCanvas.width = size;
  colCanvas.height = size;
  const cctx = colCanvas.getContext('2d')!;

  const rBase = Math.round(baseColor.r * 255);
  const gBase = Math.round(baseColor.g * 255);
  const bBase = Math.round(baseColor.b * 255);

  const colImg = cctx.createImageData(size, size);
  const nrmCanvas = document.createElement('canvas');
  nrmCanvas.width = size;
  nrmCanvas.height = size;
  const nctx = nrmCanvas.getContext('2d')!;
  const nrmImg = nctx.createImageData(size, size);

  const cell = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const gx = Math.floor(x / cell);
      const gy = Math.floor(y / cell);
      const lx = (x % cell) / cell;
      const ly = (y % cell) / cell;
      const isWarp = (gx + gy) % 2 === 0;

      const threadPos = isWarp ? lx : ly;
      const crossPos = isWarp ? ly : lx;
      const profile = Math.sin(threadPos * Math.PI) * (0.85 + 0.15 * Math.sin(crossPos * Math.PI));
      const shade = 0.86 + 0.18 * profile;

      colImg.data[idx] = Math.min(255, Math.round(rBase * shade));
      colImg.data[idx + 1] = Math.min(255, Math.round(gBase * shade));
      colImg.data[idx + 2] = Math.min(255, Math.round(bBase * shade));
      colImg.data[idx + 3] = 255;

      const dTheta = Math.cos(threadPos * Math.PI) * 0.45 * (1 - roughness * 0.4);
      const nx = isWarp ? dTheta : 0;
      const ny = isWarp ? 0 : dTheta;
      nrmImg.data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      nrmImg.data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nrmImg.data[idx + 2] = 235;
      nrmImg.data[idx + 3] = 255;
    }
  }
  cctx.putImageData(colImg, 0, 0);
  nctx.putImageData(nrmImg, 0, 0);

  const colTex = new THREE.CanvasTexture(colCanvas);
  colTex.wrapS = THREE.RepeatWrapping;
  colTex.wrapT = THREE.RepeatWrapping;
  colTex.colorSpace = THREE.SRGBColorSpace;
  colTex.repeat.set(6, 6);

  const nrmTex = new THREE.CanvasTexture(nrmCanvas);
  nrmTex.wrapS = THREE.RepeatWrapping;
  nrmTex.wrapT = THREE.RepeatWrapping;
  nrmTex.colorSpace = THREE.LinearSRGBColorSpace;
  nrmTex.repeat.set(6, 6);

  return {
    basecolor: {
      channel: 'basecolor',
      label: 'Base Color (Procedural Weave)',
      fileName: 'procedural_weave_color',
      width: size,
      height: size,
      texture: colTex,
      previewUrl: colCanvas.toDataURL('image/webp', 0.85),
    },
    normal: {
      channel: 'normal',
      label: 'Normal (Procedural Weave)',
      fileName: 'procedural_weave_normal',
      width: size,
      height: size,
      texture: nrmTex,
      previewUrl: nrmCanvas.toDataURL('image/webp', 0.85),
    },
  };
}

function extractFabricPhysicsFromU3m(u3m: any): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  const push = (label: string, val: any, unit = '') => {
    if (val === undefined || val === null || val === '') return;
    if (seen.has(label.toLowerCase())) return;
    seen.add(label.toLowerCase());
    if (typeof val === 'number') {
      const formatted = Number.isInteger(val) ? String(val) : val.toFixed(2).replace(/\.?0+$/, '');
      out.push({ label, value: unit ? `${formatted} ${unit}` : formatted });
    } else if (typeof val === 'string' || typeof val === 'boolean') {
      out.push({ label, value: String(val) });
    }
  };

  const scanObj = (obj: any) => {
    if (!obj || typeof obj !== 'object') return;
    push('Fabric Type', obj.fabric_type ?? obj.fabricType ?? obj.type ?? obj.weave ?? obj.construction);
    push('Composition', obj.composition ?? obj.fiber ?? obj.content);
    push('Weight / Mass', obj.mass ?? obj.weight ?? obj.gsm ?? obj.area_density ?? obj.density, 'g/m²');
    push('Thickness', obj.thickness ?? obj.gauge, 'mm');
    push('Bend Stiffness', obj.bend ?? obj.bending ?? obj.bend_weft);
    push('Stretch', obj.stretch ?? obj.stretch_weft ?? obj.elasticity);
    push('Shear', obj.shear ?? obj.shearing);
    push('Friction', obj.friction ?? obj.dynamic_friction);
    push('Damping', obj.damping ?? obj.internal_damping);
  };

  const mat = u3m?.material ?? u3m;
  scanObj(mat);
  if (mat?.custom && typeof mat.custom === 'object') {
    scanObj(mat.custom);
    for (const v of Object.values(mat.custom)) {
      if (v && typeof v === 'object') scanObj(v);
    }
  }
  if (mat?.physics && typeof mat.physics === 'object') {
    scanObj(mat.physics);
  }
  if (u3m?.custom && typeof u3m.custom === 'object') {
    scanObj(u3m.custom);
    for (const v of Object.values(u3m.custom)) {
      if (v && typeof v === 'object') scanObj(v);
    }
  }
  return out;
}

const U3M_PROP_TO_CHANNEL: Array<{ keys: string[]; channel: MapChannel; invert?: boolean }> = [
  { keys: ['basecolor', 'base_color', 'diffuse', 'albedo', 'color'], channel: 'basecolor' },
  { keys: ['normal', 'normal_map', 'bump_normal'], channel: 'normal' },
  { keys: ['roughness', 'specular_roughness'], channel: 'roughness' },
  { keys: ['glossiness', 'gloss'], channel: 'roughness', invert: true },
  { keys: ['metalness', 'metallic'], channel: 'metalness' },
  { keys: ['ambient_occlusion', 'ambientocclusion', 'ao', 'occlusion'], channel: 'ao' },
  { keys: ['displacement', 'height', 'bump'], channel: 'displacement' },
  { keys: ['alpha', 'opacity', 'transparency'], channel: 'alpha' },
  { keys: ['specular', 'reflection'], channel: 'specular' },
  { keys: ['sheen', 'sheen_color'], channel: 'sheen' },
  { keys: ['clearcoat', 'coating'], channel: 'clearcoat' },
  { keys: ['emissive', 'emission'], channel: 'emissive' },
];

function extractTexturePathFromProp(prop: any): {
  path: string | null;
  widthCm?: number;
  heightCm?: number;
  dpi?: number;
  factorNumber?: number;
  factorColor?: THREE.Color | null;
} {
  if (!prop || typeof prop !== 'object') return { path: null };
  const tex = prop.texture ?? prop.map ?? prop;
  const img = tex?.image ?? tex?.file ?? tex;
  const rawPath =
    typeof img === 'string'
      ? img
      : typeof img?.path === 'string'
        ? img.path
        : typeof img?.uri === 'string'
          ? img.uri
          : typeof img?.filename === 'string'
            ? img.filename
            : typeof tex?.path === 'string'
              ? tex.path
              : null;

  // In U3M 1.0/1.1, image.width & image.height are physical size in cm (or mm if > 100 and units='mm')
  const rawW = parseNumberValue(img?.width ?? tex?.width);
  const rawH = parseNumberValue(img?.height ?? tex?.height);
  const dpi = parseNumberValue(img?.dpi ?? tex?.dpi) ?? undefined;
  const factorNumber = parseNumberValue(tex?.factor ?? tex?.scale ?? prop.factor ?? prop.scale) ?? undefined;
  const factorColor = parseColorValue(tex?.factor ?? prop.factor);

  return {
    path: rawPath ? normPath(rawPath) : null,
    widthCm: rawW && rawW > 0 ? rawW : undefined,
    heightCm: rawH && rawH > 0 ? rawH : undefined,
    dpi: dpi && dpi > 0 ? dpi : undefined,
    factorNumber,
    factorColor,
  };
}

async function parseU3mSide(
  sideObj: any,
  u3mDir: string,
  findZipEntry: (relPath: string) => { name: string; bytes: Uint8Array } | null,
  usedEntryNames: Set<string>,
  allMaps: LoadedTextureMap[],
): Promise<U3mSideSpec> {
  const spec = defaultSideSpec();
  if (!sideObj || typeof sideObj !== 'object') return spec;

  // Extract scalar/color constants
  const bcProp = sideObj.basecolor ?? sideObj.base_color ?? sideObj.diffuse ?? sideObj.albedo ?? sideObj.color;
  const bcConst = parseColorValue(bcProp?.constant ?? bcProp?.value ?? bcProp);
  if (bcConst) spec.baseColor.copy(bcConst);

  const roughVal = parseNumberValue(sideObj.roughness ?? sideObj.specular_roughness);
  if (roughVal !== null) spec.roughness = Math.max(0, Math.min(1, roughVal));
  else {
    const glossVal = parseNumberValue(sideObj.glossiness ?? sideObj.gloss);
    if (glossVal !== null) spec.roughness = Math.max(0, Math.min(1, 1 - glossVal));
  }

  const metalVal = parseNumberValue(sideObj.metalness ?? sideObj.metallic);
  if (metalVal !== null) spec.metalness = Math.max(0, Math.min(1, metalVal));

  const alphaVal = parseNumberValue(sideObj.alpha ?? sideObj.opacity);
  if (alphaVal !== null) spec.alpha = Math.max(0, Math.min(1, alphaVal));

  const iorVal = parseNumberValue(sideObj.ior ?? sideObj.index_of_refraction);
  if (iorVal !== null && iorVal >= 1 && iorVal <= 3) spec.ior = iorVal;

  const sheenVal = parseNumberValue(sideObj.sheen);
  if (sheenVal !== null) spec.sheen = Math.max(0, Math.min(1, sheenVal));
  const sheenCol = parseColorValue(sideObj.sheen?.constant ?? sideObj.sheen_color?.constant ?? sideObj.sheen_color);
  if (sheenCol) spec.sheenColor.copy(sheenCol);

  const clearcoatVal = parseNumberValue(sideObj.clearcoat ?? sideObj.coating);
  if (clearcoatVal !== null) spec.clearcoat = Math.max(0, Math.min(1, clearcoatVal));

  const specVal = parseNumberValue(sideObj.specular ?? sideObj.specular_value);
  if (specVal !== null) {
    spec.specularIntensity = Math.max(0, Math.min(1, specVal));
    // In Browzwear U3M 1.1 trims (e.g. zipper Pull/Slide), specular_value >= 1.5 denotes metallic hardware
    if (specVal >= 1.5 && spec.metalness === 0) {
      spec.metalness = 0.82;
      spec.roughness = Math.min(spec.roughness, 0.32);
    }
  }

  const transVal = parseNumberValue(sideObj.transmission ?? sideObj.subsurface);
  if (transVal !== null) spec.transmission = Math.max(0, Math.min(1, transVal));

  // Extract texture maps defined on properties
  for (const mapping of U3M_PROP_TO_CHANNEL) {
    if (spec.maps[mapping.channel]) continue;
    for (const key of mapping.keys) {
      const prop = sideObj[key];
      if (!prop) continue;
      const info = extractTexturePathFromProp(prop);
      if (info.widthCm && !spec.physicalWidthCm) spec.physicalWidthCm = info.widthCm;
      if (info.heightCm && !spec.physicalHeightCm) spec.physicalHeightCm = info.heightCm;
      if (info.dpi && !spec.dpi) spec.dpi = info.dpi;

      if (mapping.channel === 'normal' && info.factorNumber !== undefined) {
        spec.normalScale = Math.max(0.1, Math.min(2.5, info.factorNumber));
      }
      if (mapping.channel === 'displacement' && info.factorNumber !== undefined) {
        // In U3M, displacement factor is typically 1.0 (normalized multiplier) or mm;
        // keep 3D world-space macro-displacement subtle so fine thread maps never spike.
        const scaled = info.factorNumber >= 0.1 ? 0.008 : info.factorNumber * 0.08;
        spec.displacementScale = Math.max(0.002, Math.min(0.015, scaled));
      }
      if (mapping.channel === 'basecolor' && info.factorColor) {
        spec.baseColor.copy(info.factorColor);
      }

      if (!info.path) continue;
      const candidatePath = u3mDir ? `${u3mDir}/${info.path}` : info.path;
      const entry = findZipEntry(candidatePath) ?? findZipEntry(info.path);
      if (entry) {
        usedEntryNames.add(entry.name);
        try {
          const loadedMap = await decodeTextureBytes(entry.bytes, entry.name, mapping.channel, mapping.invert);
          spec.maps[mapping.channel] = loadedMap;
          if (!allMaps.some((m) => m.fileName === loadedMap.fileName && m.channel === loadedMap.channel)) {
            allMaps.push(loadedMap);
          }
          break;
        } catch {
          /* continue to fallback */
        }
      }
    }
  }

  // If a basecolor texture is present, keep baseColor multiplier bright unless factor explicitly tinted it
  if (spec.maps.basecolor) {
    const lum = spec.baseColor.r * 0.299 + spec.baseColor.g * 0.587 + spec.baseColor.b * 0.114;
    if (lum < 0.08) spec.baseColor.setHex(0xffffff);
  }

  return spec;
}

function synthesizeNormalFromBasecolor(baseMap: LoadedTextureMap): LoadedTextureMap | null {
  const srcImg = baseMap.texture.image as CanvasImageSource | undefined;
  if (!srcImg) return null;
  const w = Math.min(512, baseMap.width || 256);
  const h = Math.min(512, baseMap.height || 256);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(srcImg, 0, 0, w, h);
  } catch {
    return null;
  }
  const src = ctx.getImageData(0, 0, w, h).data;
  const outImg = ctx.createImageData(w, h);
  const dst = outImg.data;
  const lumAt = (x: number, y: number) => {
    const cx = ((x % w) + w) % w;
    const cy = ((y % h) + h) % h;
    const i = (cy * w + cx) * 4;
    return (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
  };
  const strength = 2.2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx =
        (lumAt(x + 1, y - 1) + 2 * lumAt(x + 1, y) + lumAt(x + 1, y + 1)) -
        (lumAt(x - 1, y - 1) + 2 * lumAt(x - 1, y) + lumAt(x - 1, y + 1));
      const dy =
        (lumAt(x - 1, y + 1) + 2 * lumAt(x, y + 1) + lumAt(x + 1, y + 1)) -
        (lumAt(x - 1, y - 1) + 2 * lumAt(x, y - 1) + lumAt(x + 1, y - 1));
      let nx = -dx * strength;
      let ny = dy * strength;
      let nz = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const idx = (y * w + x) * 4;
      dst[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      dst[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      dst[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      dst[idx + 3] = 255;
    }
  }
  ctx.putImageData(outImg, 0, 0);
  const nrmTex = new THREE.CanvasTexture(c);
  nrmTex.wrapS = THREE.RepeatWrapping;
  nrmTex.wrapT = THREE.RepeatWrapping;
  nrmTex.colorSpace = THREE.LinearSRGBColorSpace;
  nrmTex.anisotropy = 8;
  return {
    channel: 'normal',
    label: 'Normal (Derived Relief)',
    fileName: 'derived_normal.png',
    width: w,
    height: h,
    texture: nrmTex,
    previewUrl: c.toDataURL('image/webp', 0.85),
  };
}

function buildTrimModelFromEntry(
  meshEntry: { name: string; baseLower: string; bytes: Uint8Array },
  trimParts: Array<{ name: string; spec: U3mSideSpec }>,
  fallbackSpec: U3mSideSpec,
): THREE.Object3D | null {
  const ext = extOf(meshEntry.baseLower);
  const sliceBuf = meshEntry.bytes.buffer.slice(
    meshEntry.bytes.byteOffset,
    meshEntry.bytes.byteOffset + meshEntry.bytes.byteLength,
  ) as ArrayBuffer;

  let rawRoot: THREE.Object3D;
  try {
    if (ext === 'fbx') {
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => {
        if (url.startsWith('blob:') || url.startsWith('data:')) return url;
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';
      });
      const loader = new FBXLoader(manager);
      rawRoot = loader.parse(sliceBuf, '');
    } else if (ext === 'obj') {
      const text = new TextDecoder().decode(sliceBuf);
      const loader = new OBJLoader();
      rawRoot = loader.parse(text);
    } else {
      return null;
    }
  } catch {
    return null;
  }

  // Remove embedded FBX cameras & lights so they don't skew bounds or blow out studio lights
  const toRemove: THREE.Object3D[] = [];
  rawRoot.traverse((child) => {
    if ((child as THREE.Light).isLight || (child as THREE.Camera).isCamera) {
      toRemove.push(child);
    }
  });
  for (const obj of toRemove) obj.parent?.remove(obj);

  const findPartSpec = (matName: string): U3mSideSpec => {
    const clean = (matName || '').trim().toLowerCase();
    if (!clean) return trimParts[0]?.spec ?? fallbackSpec;
    return (
      trimParts.find((p) => p.name.toLowerCase() === clean)?.spec ??
      trimParts.find((p) => clean.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(clean))?.spec ??
      trimParts[0]?.spec ??
      fallbackSpec
    );
  };

  rawRoot.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry && !mesh.geometry.attributes.normal) {
      mesh.geometry.computeVertexNormals();
    }
    const buildMat = (origMat: THREE.Material | undefined): THREE.Material => {
      const matName = origMat?.name || mesh.name || '';
      const partSpec = findPartSpec(matName);
      const isMetalName = /(pull|slide|zipper|metal|brass|gold|silver|buckle|snap|rivet)/.test(matName.toLowerCase());
      const mat = createPhysicalMaterialFromSide(partSpec, null, 'standard', false) as THREE.MeshPhysicalMaterial;
      mat.name = matName;
      if (isMetalName && mat.metalness < 0.5) {
        mat.metalness = 0.82;
        mat.roughness = Math.min(mat.roughness, 0.32);
      }
      return mat;
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((m) => buildMat(m))
      : buildMat(mesh.material);
  });

  rawRoot.updateMatrixWorld(true);
  const box = new THREE.Box3();
  rawRoot.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (m.isMesh && m.geometry) box.expandByObject(m);
  });
  if (box.isEmpty()) return null;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 2.05 / maxDim;

  const wrapper = new THREE.Group();
  rawRoot.position.sub(center);
  wrapper.add(rawRoot);
  wrapper.scale.setScalar(scale);
  return wrapper;
}

export async function parseMaterialBuffer(buffer: ArrayBuffer, fileName: string): Promise<ParsedMaterialAsset> {
  const ext = extOf(fileName);
  const cleanTitle = baseNameOf(fileName).replace(/\.[^.]+$/, '');

  // Case 1: ZIP container (.u3ma, .zfab, or zipped .u3m/.sbsar archive)
  if (isZipBuffer(buffer)) {
    const rawEntries = unzipSync(new Uint8Array(buffer));
    const entries: Array<{ name: string; norm: string; lower: string; baseLower: string; bytes: Uint8Array }> = [];

    for (const [rawName, bytes] of Object.entries(rawEntries)) {
      if (!bytes || bytes.byteLength === 0 || rawName.endsWith('/')) continue;
      const norm = normPath(rawName);
      if (norm.startsWith('__MACOSX/') || baseNameOf(norm).startsWith('._')) continue;
      entries.push({
        name: norm,
        norm,
        lower: norm.toLowerCase(),
        baseLower: baseNameOf(norm).toLowerCase(),
        bytes,
      });
    }

    const findZipEntry = (relPath: string) => {
      const target = normPath(relPath).toLowerCase();
      const targetBase = baseNameOf(target);
      return (
        entries.find((e) => e.lower === target) ??
        entries.find((e) => e.lower.endsWith(`/${target}`)) ??
        entries.find((e) => e.baseLower === targetBase) ??
        null
      );
    };

    const usedEntryNames = new Set<string>();
    const allMaps: LoadedTextureMap[] = [];
    let materialName = cleanTitle;
    let schemaVersion: string | undefined;
    let description: string | undefined;
    let rawJsonText: string | undefined;
    let fabricPhysics: Array<{ label: string; value: string }> = [];
    let front = defaultSideSpec();
    let back: U3mSideSpec | undefined;

    // Check for Browzwear 3D Trim group_*.json descriptor
    const groupEntry = entries.find((e) => e.baseLower.startsWith('group_') && e.baseLower.endsWith('.json')) ?? null;
    const u3mEntries = entries.filter((e) => e.baseLower.endsWith('.u3m'));
    const primaryU3mEntry =
      u3mEntries[0] ?? entries.find((e) => e.baseLower.endsWith('.json') && e !== groupEntry) ?? groupEntry;

    if (primaryU3mEntry) {
      usedEntryNames.add(primaryU3mEntry.name);
      try {
        rawJsonText = new TextDecoder().decode(primaryU3mEntry.bytes);
        const u3m = JSON.parse(rawJsonText);
        const u3mDir = primaryU3mEntry.norm.includes('/')
          ? primaryU3mEntry.norm.slice(0, primaryU3mEntry.norm.lastIndexOf('/'))
          : '';

        schemaVersion = typeof u3m.schema === 'string' ? `U3M ${u3m.schema}` : 'U3M 1.0';
        materialName = u3m.material?.name || u3m.name || cleanTitle;
        description = u3m.material?.description || u3m.description;
        fabricPhysics = extractFabricPhysicsFromU3m(u3m);

        const frontRaw = u3m.material?.front ?? u3m.front ?? u3m.material ?? u3m;
        front = await parseU3mSide(frontRaw, u3mDir, findZipEntry, usedEntryNames, allMaps);

        const backRaw = u3m.material?.back ?? u3m.back;
        if (backRaw && typeof backRaw === 'object' && Object.keys(backRaw).length > 0) {
          back = await parseU3mSide(backRaw, u3mDir, findZipEntry, usedEntryNames, allMaps);
        }
      } catch {
        /* fallback to filename heuristics below */
      }
    }

    // Parse all sub-material .u3m files (used by 3D Trims like Button.u3m, Thread.u3m, Pull.u3m, Slide.u3m)
    const trimParts: Array<{ name: string; spec: U3mSideSpec }> = [];
    for (const subEntry of u3mEntries) {
      usedEntryNames.add(subEntry.name);
      try {
        const subText = new TextDecoder().decode(subEntry.bytes);
        const subU3m = JSON.parse(subText);
        const subDir = subEntry.norm.includes('/') ? subEntry.norm.slice(0, subEntry.norm.lastIndexOf('/')) : '';
        const partName =
          subU3m.material?.name || subU3m.name || baseNameOf(subEntry.name).replace(/\.u3m$/i, '');
        const partFront = subU3m.material?.front ?? subU3m.front ?? subU3m.material ?? subU3m;
        const partSpec = await parseU3mSide(partFront, subDir, findZipEntry, usedEntryNames, allMaps);
        trimParts.push({ name: partName, spec: partSpec });
      } catch {
        /* ignore */
      }
    }

    // If a Browzwear group_*.json is present (e.g. 3D Trim button/zipper), extract its composite textures & metadata
    let isTrim3d = false;
    if (groupEntry) {
      usedEntryNames.add(groupEntry.name);
      try {
        const groupText = new TextDecoder().decode(groupEntry.bytes);
        const groupJson = JSON.parse(groupText);
        const bw = groupJson.custom?.Browzwear ?? groupJson.custom?.browzwear;
        if (groupJson.name) materialName = groupJson.name;
        if (bw?.type === 'trim3d') {
          isTrim3d = true;
          schemaVersion = 'U3MA 3D Trim';
        }
        if (bw?.material && typeof bw.material === 'object') {
          const groupSpec = await parseU3mSide(bw.material, '', findZipEntry, usedEntryNames, allMaps);
          for (const [ch, map] of Object.entries(groupSpec.maps)) {
            if (map && !front.maps[ch as MapChannel]) {
              front.maps[ch as MapChannel] = map;
            }
          }
          if (groupSpec.physicalWidthCm && !front.physicalWidthCm) {
            front.physicalWidthCm = groupSpec.physicalWidthCm;
            front.physicalHeightCm = groupSpec.physicalHeightCm;
          }
        }
      } catch {
        /* ignore */
      }
    }

    // Auto-discover any remaining image textures in the archive by filename heuristics
    // (Skip tiny sub-item preview icons when real textures exist)
    const imageEntries = entries.filter(
      (e) => IMAGE_EXTS.has(extOf(e.baseLower)) && !e.lower.includes('/preview.'),
    );
    for (const imgEntry of imageEntries) {
      if (usedEntryNames.has(imgEntry.name)) continue;
      const match = classifyChannelFromFilename(imgEntry.baseLower);
      if (match && !front.maps[match.channel]) {
        try {
          const loaded = await decodeTextureBytes(imgEntry.bytes, imgEntry.name, match.channel, match.invert);
          front.maps[match.channel] = loaded;
          allMaps.push(loaded);
          usedEntryNames.add(imgEntry.name);
        } catch {
          /* ignore broken image */
        }
      }
    }

    // If still no basecolor map, use the largest remaining non-alpha image in the archive as basecolor
    if (!front.maps.basecolor && imageEntries.length > 0) {
      const remaining = imageEntries
        .filter((e) => !usedEntryNames.has(e.name) && !e.baseLower.includes('alpha'))
        .sort((a, b) => b.bytes.byteLength - a.bytes.byteLength);
      const pick = remaining[0] ?? imageEntries[0];
      if (pick) {
        try {
          const loaded = await decodeTextureBytes(pick.bytes, pick.name, 'basecolor');
          front.maps.basecolor = loaded;
          if (!allMaps.some((m) => m.fileName === loaded.fileName)) {
            allMaps.unshift(loaded);
          }
        } catch {
          /* ignore */
        }
      }
    }

    // Check if the .u3ma/.zfab archive embeds a 3D mesh (.fbx or .obj, e.g. 3D Trim button/zipper)
    const meshEntry = entries.find((e) => {
      const mExt = extOf(e.baseLower);
      return mExt === 'fbx' || mExt === 'obj';
    });
    const trimModel = meshEntry ? buildTrimModelFromEntry(meshEntry, trimParts, front) ?? undefined : undefined;
    if (trimModel && !isTrim3d) {
      schemaVersion = 'U3MA 3D Trim';
    }
    if (trimParts.length > 0) {
      fabricPhysics.unshift({
        label: 'Trim Sub-Parts',
        value: trimParts.map((p) => p.name).join(', '),
      });
    }

    allMaps.sort((a, b) => CHANNEL_ORDER.indexOf(a.channel) - CHANNEL_ORDER.indexOf(b.channel));

    return {
      formatLabel: ext === 'zfab' ? 'CLO ZFAB Material' : schemaVersion || 'U3MA 3D Material',
      materialName,
      schemaVersion,
      description,
      front,
      back,
      allMaps,
      fabricPhysics,
      rawJsonText,
      trimModel,
      trimParts: trimParts.length > 0 ? trimParts : undefined,
    };
  }

  // Case 2: Standalone .u3m JSON, .mtlx XML, or .mtl text material
  if (ext === 'u3m' || ext === 'json' || ext === 'mtlx' || ext === 'mtl') {
    const text = new TextDecoder().decode(buffer);
    const front = defaultSideSpec();
    let materialName = cleanTitle;
    let schemaVersion = ext.toUpperCase();
    let fabricPhysics: Array<{ label: string; value: string }> = [];

    if (ext === 'u3m' || ext === 'json' || text.trim().startsWith('{')) {
      try {
        const u3m = JSON.parse(text);
        schemaVersion = typeof u3m.schema === 'string' ? `U3M ${u3m.schema}` : 'U3M';
        materialName = u3m.material?.name || u3m.name || cleanTitle;
        fabricPhysics = extractFabricPhysicsFromU3m(u3m);
        const frontRaw = u3m.material?.front ?? u3m.front ?? u3m.material ?? u3m;
        const parsedSide = await parseU3mSide(frontRaw, '', () => null, new Set(), []);
        Object.assign(front, parsedSide);
      } catch {
        /* ignore */
      }
    } else if (ext === 'mtl') {
      const kd = text.match(/^\s*Kd\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/m);
      if (kd) front.baseColor.setRGB(parseFloat(kd[1]), parseFloat(kd[2]), parseFloat(kd[3]));
      const ns = text.match(/^\s*Ns\s+([\d.]+)/m);
      if (ns) front.roughness = Math.max(0.05, Math.min(1, 1 - parseFloat(ns[1]) / 1000));
    }

    const proc = buildProceduralWeaveMaps(front.baseColor, front.roughness);
    front.maps.basecolor = proc.basecolor;
    front.maps.normal = proc.normal;
    front.baseColor.setHex(0xffffff);

    return {
      formatLabel: schemaVersion,
      materialName,
      schemaVersion,
      front,
      allMaps: [proc.basecolor, proc.normal],
      fabricPhysics,
      rawJsonText: text.slice(0, 20000),
    };
  }

  // Case 3: Single 3D Texture Map (.dds, .ktx, .ktx2, .tga, .tif, .tiff) or .sbsar (Substance rendition or 7z)
  const guessed = classifyChannelFromFilename(fileName)?.channel ?? 'basecolor';
  const front = defaultSideSpec();
  const u8 = new Uint8Array(buffer);

  if (ext === 'sbsar' || ext === 'ktx2') {
    const isPng = u8.byteLength > 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47;
    const isJpg = u8.byteLength > 4 && u8[0] === 0xff && u8[1] === 0xd8;
    const pngSlice = isPng || isJpg ? u8 : extractEmbeddedPng(u8);
    if (pngSlice) {
      const sliceExt = isJpg ? 'jpg' : 'png';
      const loaded = await decodeTextureBytes(pngSlice, `${cleanTitle}.${sliceExt}`, 'basecolor');
      front.maps.basecolor = loaded;
      const allMaps = [loaded];
      const synthNormal = synthesizeNormalFromBasecolor(loaded);
      if (synthNormal) {
        front.maps.normal = synthNormal;
        front.normalScale = 0.75;
        allMaps.push(synthNormal);
      }
      return {
        formatLabel: ext === 'sbsar' ? 'Substance 3D (SBSAR)' : 'KTX2 Texture',
        materialName: cleanTitle,
        front,
        allMaps,
        fabricPhysics: [],
      };
    }
    // If raw 7z .sbsar without an AEM rendition, fall back to procedural weave so viewer never crashes
    if (ext === 'sbsar') {
      const proc = buildProceduralWeaveMaps(new THREE.Color(0x94a3b8), 0.65);
      front.maps.basecolor = proc.basecolor;
      front.maps.normal = proc.normal;
      return {
        formatLabel: 'Substance 3D (SBSAR)',
        materialName: cleanTitle,
        front,
        allMaps: [proc.basecolor, proc.normal],
        fabricPhysics: [],
      };
    }
  }

  const loaded = await decodeTextureBytes(u8, fileName, guessed);
  front.maps[guessed] = loaded;
  if (guessed !== 'basecolor') {
    front.baseColor.setHex(0xd4d4d8);
  }

  return {
    formatLabel: `${ext.toUpperCase()} Texture`,
    materialName: cleanTitle,
    front,
    allMaps: [loaded],
    fabricPhysics: [],
  };
}

function extractEmbeddedPng(u8: Uint8Array): Uint8Array | null {
  const limit = Math.min(u8.byteLength - 16, 16 * 1024 * 1024);
  for (let i = 0; i < limit; i++) {
    if (
      u8[i] === 0x89 &&
      u8[i + 1] === 0x50 &&
      u8[i + 2] === 0x4e &&
      u8[i + 3] === 0x47 &&
      u8[i + 4] === 0x0d &&
      u8[i + 5] === 0x0a &&
      u8[i + 6] === 0x1a &&
      u8[i + 7] === 0x0a
    ) {
      // Find IEND chunk (49 45 4E 44 AE 42 60 82)
      const maxEnd = Math.min(u8.byteLength - 8, i + 8 * 1024 * 1024);
      for (let j = i + 32; j < maxEnd; j++) {
        if (u8[j] === 0x49 && u8[j + 1] === 0x45 && u8[j + 2] === 0x4e && u8[j + 3] === 0x44) {
          return u8.subarray(i, j + 8);
        }
      }
    }
  }
  return null;
}

export type SwatchGeometryKind = 'trim3d' | 'cloth' | 'sphere' | 'pillow' | 'cylinder' | 'plane';

function ensureUv2AndTangents(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  if (geom.attributes.uv && !geom.attributes.uv1) {
    geom.setAttribute('uv1', geom.attributes.uv);
  }
  geom.computeVertexNormals();
  if (geom.index && geom.attributes.position && geom.attributes.normal && geom.attributes.uv) {
    try {
      geom.computeTangents();
    } catch {
      /* ignore */
    }
  }
  return geom;
}

function createSwatchGeometry(kind: SwatchGeometryKind): THREE.BufferGeometry {
  if (kind === 'cloth') {
    // High-resolution C∞ smooth studio fabric drape (no piecewise creases or jagged edges)
    const segs = 192;
    const geom = new THREE.PlaneGeometry(2.3, 2.3, segs, segs);
    geom.rotateX(-Math.PI * 0.36);
    const pos = geom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const u = x / 1.15; // -1..1
      const v = z / 1.15; // -1..1
      const r2 = u * u + v * v;
      const theta = Math.atan2(v, u);

      // Smooth Gaussian crown pedestal + natural radial fabric folds + soft skirt falloff
      const crown = 0.24 * Math.exp(-r2 * 1.45);
      const foldEnv = r2 * Math.exp(-r2 * 0.85);
      const radialFolds =
        foldEnv * (0.085 * Math.sin(4 * theta + 0.55) + 0.04 * Math.cos(7 * theta - 0.35));
      const softWave = 0.035 * Math.sin(u * 2.6 + v * 1.8) * Math.exp(-r2 * 0.45);
      const skirtDrop = -0.14 * r2;

      pos.setY(i, y + crown + radialFolds + softWave + skirtDrop);
    }
    return ensureUv2AndTangents(geom);
  }

  if (kind === 'sphere') {
    // High-res Shader Ball with subtle equatorial bevel groove for specular inspection
    const geom = new THREE.SphereGeometry(1.12, 128, 96);
    const pos = geom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const groove = Math.exp(-Math.pow((y - 0.18) / 0.045, 2)) * 0.035;
      const scale = 1 - groove;
      pos.setXYZ(i, x * scale, y, z * scale);
    }
    return ensureUv2AndTangents(geom);
  }

  if (kind === 'pillow') {
    // Soft upholstered fabric swatch pillow / puffed cushion
    const segs = 96;
    const geom = new THREE.BoxGeometry(1.75, 0.65, 1.75, segs, 32, segs);
    const pos = geom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) / 0.875;
      const y = pos.getY(i) / 0.325;
      const z = pos.getZ(i) / 0.875;
      const r2 = x * x * 0.65 + z * z * 0.65;
      const puff = Math.exp(-r2 * 0.75);
      const seamPinch = 1 - 0.14 * Math.exp(-y * y * 6);
      pos.setXYZ(
        i,
        x * 0.92 * seamPinch,
        y * (0.34 + 0.34 * puff),
        z * 0.92 * seamPinch,
      );
    }
    return ensureUv2AndTangents(geom);
  }

  if (kind === 'cylinder') {
    const geom = new THREE.CylinderGeometry(0.85, 0.85, 1.9, 112, 48, false);
    return ensureUv2AndTangents(geom);
  }

  const geom = new THREE.PlaneGeometry(2.2, 2.2, 128, 128);
  return ensureUv2AndTangents(geom);
}

function defaultRepeatForSide(side: U3mSideSpec): number {
  // Assume swatch mesh represents ~20cm x 20cm of physical textile
  if (side.physicalWidthCm && side.physicalWidthCm > 0) {
    const rawRepeat = 20 / side.physicalWidthCm;
    if (rawRepeat >= 6) return 8;
    if (rawRepeat >= 3) return 4;
    if (rawRepeat >= 1.5) return 2;
    return 1;
  }
  return 2;
}

function applyRepeatToSide(side: U3mSideSpec, repeat: number) {
  const aspect =
    side.physicalWidthCm && side.physicalHeightCm && side.physicalHeightCm > 0
      ? side.physicalWidthCm / side.physicalHeightCm
      : 1;
  const rx = repeat;
  const ry = Math.max(0.25, repeat * aspect);
  for (const map of Object.values(side.maps)) {
    if (!map) continue;
    map.texture.repeat.set(rx, ry);
    map.texture.needsUpdate = true;
  }
}

export type ReliefLevel = 'standard' | 'deep' | 'off';

function createPhysicalMaterialFromSide(
  side: U3mSideSpec,
  soloChannel: MapChannel | null,
  relief: ReliefLevel,
  wireframe: boolean,
): THREE.Material {
  if (soloChannel && side.maps[soloChannel]) {
    return new THREE.MeshBasicMaterial({
      map: side.maps[soloChannel]!.texture,
      side: THREE.DoubleSide,
      wireframe,
    });
  }

  const hasAlphaMap = Boolean(side.maps.alpha);
  const isTransparent = hasAlphaMap || side.alpha < 0.99 || side.transmission > 0.01;
  const reliefMul = relief === 'off' ? 0 : relief === 'deep' ? 1.85 : 1.0;
  const nScale = side.normalScale * reliefMul;

  // Use per-pixel normalMap + per-pixel bumpMap (from height/displacement map) in the fragment shader
  // rather than raw vertex displacementMap, avoiding Nyquist polygon spikes on fine fabric weaves.
  const useBumpFallback = relief !== 'off' && Boolean(side.maps.displacement) && !side.maps.normal;

  const mat = new THREE.MeshPhysicalMaterial({
    color: side.baseColor.clone(),
    map: side.maps.basecolor?.texture ?? null,
    normalMap: relief !== 'off' ? side.maps.normal?.texture ?? null : null,
    normalScale: new THREE.Vector2(nScale, nScale),
    bumpMap: useBumpFallback ? side.maps.displacement?.texture ?? null : null,
    bumpScale: useBumpFallback ? 0.025 * reliefMul : 0,
    roughness: side.maps.roughness ? 1.0 : side.roughness,
    roughnessMap: side.maps.roughness?.texture ?? null,
    metalness: side.maps.metalness ? 1.0 : side.metalness,
    metalnessMap: side.maps.metalness?.texture ?? null,
    aoMap: side.maps.ao?.texture ?? null,
    aoMapIntensity: 1.0,
    alphaMap: side.maps.alpha?.texture ?? null,
    opacity: side.alpha,
    transparent: isTransparent,
    alphaTest: hasAlphaMap ? 0.05 : 0,
    ior: side.ior,
    sheen: side.sheen,
    sheenColor: side.sheenColor.clone(),
    sheenColorMap: side.maps.sheen?.texture ?? null,
    sheenRoughness: side.sheenRoughness,
    clearcoat: side.clearcoat,
    clearcoatMap: side.maps.clearcoat?.texture ?? null,
    clearcoatRoughness: side.clearcoatRoughness,
    specularIntensity: side.specularIntensity,
    emissive: side.maps.emissive ? new THREE.Color(0xffffff) : new THREE.Color(0x000000),
    emissiveMap: side.maps.emissive?.texture ?? null,
    transmission: side.transmission,
    side: THREE.DoubleSide,
    wireframe,
  });

  return mat;
}

type LightingPreset = 'studio' | 'warm' | 'cool' | 'dramatic';

function configureLightingPreset(
  preset: LightingPreset,
  keyLight: THREE.DirectionalLight,
  rimLight: THREE.DirectionalLight,
  fillLight: THREE.DirectionalLight,
  renderer: THREE.WebGLRenderer,
) {
  if (preset === 'studio') {
    keyLight.color.setHex(0xfffbeb);
    keyLight.intensity = 1.65;
    rimLight.color.setHex(0x93c5fd);
    rimLight.intensity = 0.95;
    fillLight.color.setHex(0xe2e8f0);
    fillLight.intensity = 0.45;
    renderer.toneMappingExposure = 1.12;
  } else if (preset === 'warm') {
    keyLight.color.setHex(0xfde68a);
    keyLight.intensity = 1.85;
    rimLight.color.setHex(0xf97316);
    rimLight.intensity = 0.85;
    fillLight.color.setHex(0xfef3c7);
    fillLight.intensity = 0.5;
    renderer.toneMappingExposure = 1.18;
  } else if (preset === 'cool') {
    keyLight.color.setHex(0xe0f2fe);
    keyLight.intensity = 1.6;
    rimLight.color.setHex(0x38bdf8);
    rimLight.intensity = 1.15;
    fillLight.color.setHex(0x818cf8);
    fillLight.intensity = 0.5;
    renderer.toneMappingExposure = 1.1;
  } else {
    // dramatic grazing light to accentuate fabric weave & normal relief
    keyLight.color.setHex(0xffffff);
    keyLight.intensity = 2.4;
    rimLight.color.setHex(0x60a5fa);
    rimLight.intensity = 1.3;
    fillLight.color.setHex(0x1e293b);
    fillLight.intensity = 0.15;
    renderer.toneMappingExposure = 1.05;
  }
}

function disposeParsedAsset(parsed: ParsedMaterialAsset) {
  for (const m of parsed.allMaps) {
    m.texture.dispose();
  }
}

export const texture3dViewer: ViewerPlugin = {
  id: 'texture3d',
  label: '3D Material & Texture (U3MA)',
  badge: 'PBR',
  extensions: ['u3ma', 'u3m', 'zfab', 'sbsar', 'mtlx', 'dds', 'ktx', 'ktx2', 'tga', 'mtl'],
  mimeTypes: [
    'model/u3m',
    'application/u3m',
    'application/x-u3ma',
    'image/vnd-ms.dds',
    'image/ktx',
    'image/ktx2',
    'image/x-tga',
    'image/x-targa',
  ],

  async renderThumbnail(meta, fetchBuffer) {
    const buffer = await fetchBuffer();
    const parsed = await parseMaterialBuffer(buffer, meta.name);
    const repeat = defaultRepeatForSide(parsed.front);
    applyRepeatToSide(parsed.front, repeat);

    const size = 280;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(size, size, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111318);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const keyLight = new THREE.DirectionalLight(0xfffbeb, 1.75);
    keyLight.position.set(2.8, 3.8, 3.2);
    const rimLight = new THREE.DirectionalLight(0x93c5fd, 1.0);
    rimLight.position.set(-3.5, 2.0, -2.8);
    scene.add(keyLight, rimLight);

    // Use embedded 3D Trim mesh (FBX) if present, else Draped Fabric Cloth for .u3ma/.u3m/.zfab/.sbsar, or Shader Ball
    const ext = extOf(meta.name);
    const isFabricFormat = ext === 'u3ma' || ext === 'u3m' || ext === 'zfab' || ext === 'sbsar';
    const geom = createSwatchGeometry(isFabricFormat ? 'cloth' : 'sphere');
    const mat = createPhysicalMaterialFromSide(parsed.front, null, 'standard', false);
    const mesh = new THREE.Mesh(geom, mat);
    if (parsed.trimModel) {
      scene.add(parsed.trimModel);
    } else {
      scene.add(mesh);
    }

    // Prepare a small 2D swatch inset if basecolor preview exists
    let swatchImg: HTMLImageElement | null = null;
    const basePreview = parsed.front.maps.basecolor?.previewUrl ?? parsed.allMaps[0]?.previewUrl;
    if (basePreview) {
      swatchImg = new Image();
      swatchImg.src = basePreview;
      await new Promise<void>((res) => {
        swatchImg!.onload = () => res();
        swatchImg!.onerror = () => res();
      });
    }

    const outCanvas = document.createElement('canvas');
    outCanvas.width = size;
    outCanvas.height = size;
    const octx = outCanvas.getContext('2d')!;

    const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 50);
    const radius = isFabricFormat ? 2.85 : 2.95;
    const baseBeta = isFabricFormat ? 0.42 : 0.28;
    const baseAlpha = 0.48;

    const numFrames = 16;
    const frames: string[] = [];
    for (let f = 0; f < numFrames; f++) {
      const t = f / numFrames;
      const alpha = baseAlpha + (t - 0.5) * 0.68;
      camera.position.set(
        radius * Math.sin(alpha) * Math.cos(baseBeta),
        radius * Math.sin(baseBeta),
        radius * Math.cos(alpha) * Math.cos(baseBeta),
      );
      camera.lookAt(0, -0.04, 0);
      // Orbit key light slightly so specular sheen sweeps across the fabric weave
      keyLight.position.set(2.8 * Math.cos(alpha * 0.7), 3.8, 3.2 * Math.sin(alpha * 0.7) + 1.5);
      renderer.render(scene, camera);

      octx.drawImage(canvas, 0, 0);

      // Draw circular 2D texture swatch inset in bottom-right corner
      if (swatchImg && swatchImg.width > 0) {
        const r = 24;
        const cx = size - r - 12;
        const cy = size - r - 12;
        octx.save();
        octx.beginPath();
        octx.arc(cx, cy, r, 0, Math.PI * 2);
        octx.closePath();
        octx.clip();
        octx.drawImage(swatchImg, cx - r, cy - r, r * 2, r * 2);
        octx.restore();
        octx.beginPath();
        octx.arc(cx, cy, r, 0, Math.PI * 2);
        octx.strokeStyle = 'rgba(255,255,255,0.75)';
        octx.lineWidth = 2;
        octx.stroke();
      }

      frames.push(outCanvas.toDataURL('image/webp', 0.84));
    }

    geom.dispose();
    mat.dispose();
    disposeParsedAsset(parsed);
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
    ctx.setProgress(8, `Downloading ${ctx.meta.name}…`);
    const buffer = await ctx.fetchBuffer((loaded, total) => {
      if (total) ctx.setProgress(Math.min(88, (loaded / total) * 88));
    });
    if (ctx.signal.aborted) return () => {};

    ctx.setProgress(93, 'Unpacking U3MA maps & building PBR shader…');
    const parsed = await parseMaterialBuffer(buffer, ctx.meta.name);
    if (ctx.signal.aborted) {
      disposeParsedAsset(parsed);
      return () => {};
    }
    ctx.setProgress(null);

    const ext = extOf(ctx.meta.name);
    const isFabricDefault = ext === 'u3ma' || ext === 'u3m' || ext === 'zfab' || ext === 'sbsar';

    // State
    let activeSideKey: 'front' | 'back' = 'front';
    const getActiveSide = () => (activeSideKey === 'back' && parsed.back ? parsed.back : parsed.front);
    let repeat = parsed.trimModel ? 1 : defaultRepeatForSide(parsed.front);
    applyRepeatToSide(parsed.front, repeat);
    if (parsed.back) applyRepeatToSide(parsed.back, repeat);

    let meshKind: SwatchGeometryKind = parsed.trimModel ? 'trim3d' : isFabricDefault ? 'cloth' : 'sphere';
    let soloChannel: MapChannel | null = null;
    let viewMode: '3d' | '2d' | 'split' = '3d';
    let lightingPreset: LightingPreset = 'studio';
    let relief: ReliefLevel = 'standard';
    let wireframe = false;
    let showSpecsDrawer = true;
    let saveBtnLabel = '🎥 Save Animated Preview';

    // Root UI wrapper
    const rootWrap = document.createElement('div');
    rootWrap.style.cssText =
      'position:relative;width:100%;height:100%;display:flex;flex-direction:column;background:#111318;overflow:hidden;';
    ctx.container.appendChild(rootWrap);

    const viewportArea = document.createElement('div');
    viewportArea.style.cssText = 'position:relative;flex:1;min-height:0;display:flex;overflow:hidden;';
    rootWrap.appendChild(viewportArea);

    // 3D Viewport Pane
    const pane3d = document.createElement('div');
    pane3d.style.cssText = 'position:relative;flex:1;height:100%;min-width:0;overflow:hidden;';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:grab;';
    pane3d.appendChild(canvas);
    viewportArea.appendChild(pane3d);

    // 2D Texture Tile Inspector Pane (shown in '2d' or 'split' mode)
    const pane2d = document.createElement('div');
    pane2d.style.cssText =
      'position:relative;flex:1;height:100%;min-width:0;display:none;flex-direction:column;align-items:center;justify-content:center;background:repeating-conic-gradient(#18181b 0% 25%, #222228 0% 50%) 50% / 24px 24px;border-left:1px solid rgba(255,255,255,0.08);overflow:hidden;';
    const tileCanvas = document.createElement('canvas');
    tileCanvas.style.cssText =
      'max-width:90%;max-height:84%;object-fit:contain;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.14);';
    const tileCaption = document.createElement('div');
    tileCaption.style.cssText =
      'margin-top:8px;padding:3px 10px;border-radius:999px;background:rgba(15,23,42,0.85);color:#cbd5e1;font:600 11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;border:1px solid rgba(255,255,255,0.1);';
    pane2d.append(tileCanvas, tileCaption);
    viewportArea.appendChild(pane2d);

    // Floating Material & Fabric Spec Card (top-right inside 3D viewport)
    const specCard = document.createElement('div');
    specCard.style.cssText =
      'position:absolute;top:12px;right:12px;width:268px;max-height:calc(100% - 24px);overflow-y:auto;padding:10px 12px;border-radius:10px;background:rgba(15,17,23,0.84);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.1);color:#e2e8f0;font:11px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;z-index:2;pointer-events:auto;';
    pane3d.appendChild(specCard);

    // Bottom Texture Maps Dock
    const mapDock = document.createElement('div');
    mapDock.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(17,19,25,0.95);border-top:1px solid rgba(255,255,255,0.08);overflow-x:auto;z-index:2;';
    rootWrap.appendChild(mapDock);

    // Three.js Studio Setup
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111318);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const keyLight = new THREE.DirectionalLight(0xfffbeb, 1.65);
    keyLight.position.set(2.8, 4.0, 3.2);
    const rimLight = new THREE.DirectionalLight(0x93c5fd, 0.95);
    rimLight.position.set(-3.5, 2.2, -2.8);
    const fillLight = new THREE.DirectionalLight(0xe2e8f0, 0.45);
    fillLight.position.set(0, -2.5, 2.0);
    scene.add(keyLight, rimLight, fillLight);
    configureLightingPreset(lightingPreset, keyLight, rimLight, fillLight, renderer);

    const grid = new THREE.GridHelper(6, 16, 0x3b82f6, 0x222530);
    grid.position.y = -1.18;
    scene.add(grid);

    let currentGeom = createSwatchGeometry(meshKind === 'trim3d' ? 'cloth' : meshKind);
    let currentMat = createPhysicalMaterialFromSide(getActiveSide(), soloChannel, relief, wireframe);
    const swatchMesh = new THREE.Mesh(currentGeom, currentMat);
    scene.add(swatchMesh);
    if (parsed.trimModel) {
      scene.add(parsed.trimModel);
    }
    const syncMeshVisibility = () => {
      if (parsed.trimModel) {
        parsed.trimModel.visible = meshKind === 'trim3d';
        swatchMesh.visible = meshKind !== 'trim3d';
      } else {
        swatchMesh.visible = true;
      }
    };
    syncMeshVisibility();

    const camera = new THREE.PerspectiveCamera(40, 1, 0.02, 100);
    camera.position.set(0.35, 1.15, 2.75);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 1.4;

    const rebuildMaterial = () => {
      const side = getActiveSide();
      applyRepeatToSide(side, repeat);
      currentMat.dispose();
      currentMat = createPhysicalMaterialFromSide(side, soloChannel, relief, wireframe);
      swatchMesh.material = currentMat;
      render2dTilePane();
      renderSpecCard();
      renderMapDock();
    };

    const rebuildGeometry = () => {
      syncMeshVisibility();
      if (meshKind !== 'trim3d') {
        currentGeom.dispose();
        currentGeom = createSwatchGeometry(meshKind);
        swatchMesh.geometry = currentGeom;
      }
    };

    const render2dTilePane = () => {
      pane2d.style.display = viewMode === '3d' ? 'none' : 'flex';
      pane3d.style.display = viewMode === '2d' ? 'none' : 'block';
      if (viewMode === '3d') return;

      const side = getActiveSide();
      const targetMap =
        (soloChannel ? side.maps[soloChannel] : null) ??
        side.maps.basecolor ??
        parsed.allMaps[0] ??
        null;

      if (!targetMap) {
        tileCaption.textContent = 'No raster texture map';
        return;
      }

      const img = new Image();
      img.onload = () => {
        const tileCount = Math.min(4, Math.max(1, Math.round(repeat)));
        const outSize = 640;
        tileCanvas.width = outSize;
        tileCanvas.height = outSize;
        const tctx = tileCanvas.getContext('2d')!;
        tctx.clearRect(0, 0, outSize, outSize);
        const cellW = outSize / tileCount;
        const cellH = outSize / tileCount;
        for (let ty = 0; ty < tileCount; ty++) {
          for (let tx = 0; tx < tileCount; tx++) {
            tctx.drawImage(img, tx * cellW, ty * cellH, cellW, cellH);
          }
        }
        // Subtle seam grid lines when tiled
        if (tileCount > 1) {
          tctx.strokeStyle = 'rgba(56, 189, 248, 0.32)';
          tctx.lineWidth = 1;
          for (let i = 1; i < tileCount; i++) {
            tctx.beginPath();
            tctx.moveTo(i * cellW, 0);
            tctx.lineTo(i * cellW, outSize);
            tctx.moveTo(0, i * cellH);
            tctx.lineTo(outSize, i * cellH);
            tctx.stroke();
          }
        }
      };
      img.src = targetMap.previewUrl;
      tileCaption.textContent = `${targetMap.label} (${targetMap.fileName}) · ${targetMap.width}×${targetMap.height}px · ${repeat}×${repeat} Tiling`;
    };

    const renderSpecCard = () => {
      specCard.style.display = showSpecsDrawer ? 'block' : 'none';
      if (!showSpecsDrawer) return;
      const side = getActiveSide();
      const rows: Array<[string, string]> = [
        ['Format', parsed.formatLabel],
        ['Material', parsed.materialName],
      ];
      if (side.physicalWidthCm && side.physicalHeightCm) {
        rows.push([
          'Physical Repeat',
          `${side.physicalWidthCm.toFixed(1)} × ${side.physicalHeightCm.toFixed(1)} cm${side.dpi ? ` @ ${Math.round(side.dpi)} DPI` : ''}`,
        ]);
      }
      rows.push(
        ['PBR Maps', `${Object.keys(side.maps).length} active (${parsed.allMaps.length} in file)`],
        ['Roughness / Metal', `${side.roughness.toFixed(2)} / ${side.metalness.toFixed(2)}`],
        ['Sheen / IOR', `${side.sheen.toFixed(2)} / ${side.ior.toFixed(2)}`],
      );
      for (const phys of parsed.fabricPhysics) {
        rows.push([phys.label, phys.value]);
      }

      specCard.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.1);">
          <span style="font-weight:700;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#93c5fd;">Material Inspector</span>
          <span style="padding:1px 6px;border-radius:4px;background:rgba(59,130,246,0.2);color:#bfdbfe;font-weight:600;font-size:10px;">${activeSideKey.toUpperCase()}</span>
        </div>
        ${rows
          .map(
            ([k, v]) => `
          <div style="display:flex;justify-content:space-between;gap:8px;padding:2.5px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <span style="color:#94a3b8;flex-shrink:0;">${k}</span>
            <span style="color:#f1f5f9;font-weight:600;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:168px;">${v}</span>
          </div>`,
          )
          .join('')}
      `;
    };

    const renderMapDock = () => {
      mapDock.replaceChildren();
      const side = getActiveSide();

      const makeChip = (
        label: string,
        sub: string,
        active: boolean,
        thumbUrl: string | null,
        onClick: () => void,
      ) => {
        const btn = document.createElement('button');
        btn.style.cssText = `
          display:flex;align-items:center;gap:8px;padding:5px 10px 5px 6px;border-radius:8px;
          border:1px solid ${active ? '#3b82f6' : 'rgba(255,255,255,0.12)'};
          background:${active ? 'rgba(59,130,246,0.22)' : 'rgba(255,255,255,0.04)'};
          color:${active ? '#bfdbfe' : '#e2e8f0'};cursor:pointer;flex-shrink:0;text-align:left;
        `;
        if (thumbUrl) {
          const img = document.createElement('img');
          img.src = thumbUrl;
          img.alt = label;
          img.style.cssText =
            'width:30px;height:30px;border-radius:5px;object-fit:cover;border:1px solid rgba(255,255,255,0.18);background:#09090b;';
          btn.appendChild(img);
        } else {
          const icon = document.createElement('div');
          icon.textContent = 'PBR';
          icon.style.cssText =
            'width:30px;height:30px;border-radius:5px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font:700 9px/1 sans-serif;';
          btn.appendChild(icon);
        }
        const textWrap = document.createElement('div');
        textWrap.style.cssText = 'display:flex;flex-direction:column;line-height:1.25;';
        const titleEl = document.createElement('span');
        titleEl.style.cssText = 'font-size:11px;font-weight:600;';
        titleEl.textContent = label;
        const subEl = document.createElement('span');
        subEl.style.cssText = 'font-size:9.5px;color:#94a3b8;';
        subEl.textContent = sub;
        textWrap.append(titleEl, subEl);
        btn.appendChild(textWrap);
        btn.addEventListener('click', onClick);
        return btn;
      };

      // "Full PBR Composite" chip
      mapDock.appendChild(
        makeChip(
          'Full PBR Shader',
          `${Object.keys(side.maps).length} maps combined`,
          soloChannel === null,
          null,
          () => {
            soloChannel = null;
            rebuildMaterial();
          },
        ),
      );

      // Per-channel map chips
      for (const ch of CHANNEL_ORDER) {
        const m = side.maps[ch];
        if (!m) continue;
        mapDock.appendChild(
          makeChip(
            m.label,
            `${m.width}×${m.height}`,
            soloChannel === ch,
            m.previewUrl,
            () => {
              soloChannel = soloChannel === ch ? null : ch;
              rebuildMaterial();
            },
          ),
        );
      }
    };

    const capturePreview = async () => {
      saveBtnLabel = '⏳ Recording…';
      renderToolbar();
      const p = camera.position.clone();
      const radius = p.length() || 2.85;
      const baseBeta = Math.asin(Math.max(-0.98, Math.min(0.98, p.y / radius)));
      const baseAlpha = Math.atan2(p.x, p.z);

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 280;
      thumbCanvas.height = 280;
      const tctx = thumbCanvas.getContext('2d')!;

      const frames: string[] = [];
      for (let f = 0; f < 16; f++) {
        const t = f / 16;
        const alpha = baseAlpha + (t - 0.5) * 0.68;
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

    const meshOrder: SwatchGeometryKind[] = parsed.trimModel
      ? ['trim3d', 'cloth', 'sphere', 'pillow', 'cylinder', 'plane']
      : ['cloth', 'sphere', 'pillow', 'cylinder', 'plane'];
    const meshLabels: Record<SwatchGeometryKind, string> = {
      trim3d: '3D Trim (FBX)',
      cloth: 'Draped Cloth',
      sphere: 'Shader Ball',
      pillow: 'Fabric Swatch',
      cylinder: 'Roll',
      plane: 'Flat Tile',
    };

    const repeatSteps = [1, 2, 4, 8];
    const lightOrder: LightingPreset[] = ['studio', 'warm', 'cool', 'dramatic'];

    const renderToolbar = () => {
      ctx.setActions([
        {
          id: 'mesh',
          label: `Mesh: ${meshLabels[meshKind]}`,
          title: 'Cycle 3D swatch geometry (Draped Cloth, Shader Ball, Cushion, Roll, Flat Plane)',
          onClick: () => {
            meshKind = meshOrder[(meshOrder.indexOf(meshKind) + 1) % meshOrder.length];
            rebuildGeometry();
            renderToolbar();
          },
        },
        {
          id: 'repeat',
          label: `Repeat: ${repeat}×`,
          title: 'Cycle UV texture tiling density (1×, 2×, 4×, 8×)',
          onClick: () => {
            repeat = repeatSteps[(repeatSteps.indexOf(repeat) + 1) % repeatSteps.length] ?? 2;
            rebuildMaterial();
            renderToolbar();
          },
        },
        {
          id: 'view-mode',
          label: viewMode === '3d' ? 'View: 3D Studio' : viewMode === 'split' ? 'View: 3D + 2D Split' : 'View: 2D Tile',
          active: viewMode !== '3d',
          onClick: () => {
            viewMode = viewMode === '3d' ? 'split' : viewMode === 'split' ? '2d' : '3d';
            render2dTilePane();
            resize();
            renderToolbar();
          },
        },
        {
          id: 'lighting',
          label: `Light: ${lightingPreset.toUpperCase()}`,
          onClick: () => {
            lightingPreset = lightOrder[(lightOrder.indexOf(lightingPreset) + 1) % lightOrder.length];
            configureLightingPreset(lightingPreset, keyLight, rimLight, fillLight, renderer);
            renderToolbar();
          },
        },
        ...(parsed.back
          ? [
              {
                id: 'side',
                label: `Side: ${activeSideKey.toUpperCase()}`,
                active: activeSideKey === 'back',
                onClick: () => {
                  activeSideKey = activeSideKey === 'front' ? 'back' : 'front';
                  rebuildMaterial();
                  renderToolbar();
                },
              },
            ]
          : []),
        {
          id: 'disp',
          label: relief === 'standard' ? 'Relief: 1×' : relief === 'deep' ? 'Relief: 2×' : 'Relief: OFF',
          title: 'Cycle per-pixel weave normal/bump relief intensity (1× Standard, 2× Deep, OFF)',
          active: relief !== 'off',
          onClick: () => {
            relief = relief === 'standard' ? 'deep' : relief === 'deep' ? 'off' : 'standard';
            rebuildMaterial();
            renderToolbar();
          },
        },
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
          id: 'specs',
          label: showSpecsDrawer ? 'Specs: ON' : 'Specs: OFF',
          active: showSpecsDrawer,
          onClick: () => {
            showSpecsDrawer = !showSpecsDrawer;
            renderSpecCard();
            renderToolbar();
          },
        },
        {
          id: 'save-preview',
          label: saveBtnLabel,
          onClick: capturePreview,
        },
      ]);
    };

    renderSpecCard();
    renderMapDock();
    render2dTilePane();
    renderToolbar();

    const resize = () => {
      const r = pane3d.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        camera.aspect = r.width / r.height;
        camera.updateProjectionMatrix();
        renderer.setSize(r.width, r.height, false);
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(pane3d);
    resize();

    const primaryMap = parsed.front.maps.basecolor ?? parsed.allMaps[0];
    const resLabel = primaryMap ? `${primaryMap.width}×${primaryMap.height}` : 'Procedural';
    const physLabel =
      parsed.front.physicalWidthCm && parsed.front.physicalHeightCm
        ? ` · ${parsed.front.physicalWidthCm.toFixed(1)}×${parsed.front.physicalHeightCm.toFixed(1)}cm`
        : '';
    const statsBase = `${parsed.formatLabel} · ${parsed.allMaps.length} map${parsed.allMaps.length === 1 ? '' : 's'} (${resLabel})${physLabel}`;
    ctx.setStatus(statsBase);

    let raf = 0;
    let frames = 0;
    let lastFps = performance.now();

    const tick = (now: number) => {
      if (ctx.signal.aborted) return;
      controls.update();
      if (viewMode !== '2d') {
        renderer.render(scene, camera);
      }

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
      currentGeom.dispose();
      currentMat.dispose();
      disposeParsedAsset(parsed);
      renderer.dispose();
      renderer.forceContextLoss();
      rootWrap.remove();
    };
  },
};
