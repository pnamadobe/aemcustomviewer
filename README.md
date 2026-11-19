# AEM Assets View – Custom Viewer Platform (`aemcustomviewer`)

A Chrome Manifest V3 extension platform that injects interactive, high-performance custom viewers into the **main preview area** of the AEM as a Cloud Service **Assets View** (`CQ-assets-app`) details page — plus **animated/custom Card View thumbnails** and **hover-scrub video previews** — for file types AEM does not natively render.

## Demo Video

[![AEM Assets View – Custom Viewer Platform Demo](https://img.youtube.com/vi/sXPfwydOvTk/maxresdefault.jpg)](https://youtu.be/sXPfwydOvTk)

▶️ **[Watch the demo on YouTube](https://youtu.be/sXPfwydOvTk)**

## Built-in Viewer Plugins

| Plugin | Badge | Extensions | Details Viewer & Card View Thumbnail |
|---|---|---|---|
| **3D Gaussian Splatting** (`src/viewers/gsplat`) | `3DGS` | `.splat`, `.ply`, `.splatv` | **Card View**: 16-frame slow-drift (~12s flicker-free double-buffered) WebP preview with auto-gamma tone mapping, bright-subject framing, and scene-vs-object motion detection (`ORBIT` vs `PUSH`/`PAN`).<br>**Details**: WebGL2 viewer (`gsplat`) with in-browser `ReadableStream` chunk decimation for 1 GB+ `.ply`/`.splat` files (`stream-decimate.ts`), 2D surfel support, in-place 50% decimation (`✂ -50%`), local 1 GB+ file decimator (`📂 Local File…`), `🏠 Inside Room` / `🔭 Outside` camera presets, and `IndexedDB` binary cache (`acv-splat-cache-v3`). |
| **3D Models & CAD Meshes** (`src/viewers/model3d`) | `3D` | `.glb`, `.gltf`, `.obj`, `.stl` | **Card View**: 16-frame studio-lit PBR slow-drift preview.<br>**Details**: Three.js PBR studio (`RoomEnvironment`), PBR/Clay/Normals shading switcher, Wireframe toggle, Grid toggle, GLTF animation transport, and poly/vertex telemetry. |
| **Fonts & Variable Fonts** (`src/viewers/font`) | `FONT` | `.ttf`, `.otf`, `.woff`, `.woff2` | **Card View**: Typography specimen card (`"Aa"`, alphabet, glyph count & Variable Font axes).<br>**Details**: Live editable type tester, interactive **Variable Font axis sliders** (`fvar` table: `wght`, `wdth`, `opsz`, `slnt`), Size Waterfall (`14px`–`56px`), Glyph Map grid, and Dark/Paper theme. |
| **Camera RAW & 32-bit HDR** (`src/viewers/raw`) | `RAW` | `.cr3`, `.cr2`, `.nef`, `.arw`, `.dng`, `.raf`, `.rw2`, `.orf`, `.pef`, `.srw`, `.iiq`, `.3fr`, `.hdr`, `.exr` | **Card View**: Fast 8 MB HTTP 206 `Range` probe extracts the embedded full-res RAW preview JPEG in milliseconds (or ACES Filmic tone-maps `.hdr`/`.exr`).<br>**Details**: Darkroom inspector with **Exposure (`-3` to `+3 EV`) slider**, live **RGB Parade Histogram**, Camera EXIF detection, and 1:1 Loupe zoom. |
| **Audio Spectrum & Waveform** (`src/viewers/audio`) | `AUDIO` | `.mp3`, `.wav`, `.flac`, `.ogg` | **Card View**: 64-bar stereo waveform card.<br>**Details**: Real-time WebAudio FFT spectrum analyzer + HTML5 audio transport. |
| **Video Hover-Scrubbing** (`src/thumbnails/card-observer`) | `⇄ SCRUB` | `.mp4`, `.mov`, `.webm`, `.m4v`, `.ogv` | **Card View**: Streams `cq5dam.preview.mp4` on first hover and caches a **24-frame WebP scrub strip** in `IndexedDB` for instant 0-network horizontal mouse scrubbing with timestamp HUD. |

## How It Works

1. **Scoped Same-Origin Iframe Targeting**: Content scripts match only `https://experience.adobe.com/*solutions/CQ-assets-app*` (`all_frames: true`), avoiding unnecessary execution in the outer Unified Shell frame.
2. **Route & Card Watching**:
   - Watches `#/detail/content/dam/<path>` transitions for the Details viewer.
   - Watches `div[role="row"][data-key^="urn:aaid:aem:"]` across **Folders, Search Results, and Collections** for Card View thumbnails and video hover-scrubbing.
3. **Auth & Content Repository API**:
   - Reads the IMS token (`shellCachedTokens`) and `repoId` directly from Unified Shell's `sessionStorage` (with a `MAIN`-world `fetch`/`XHR` hook in `page-hook.ts` as automatic fallback).
   - Queries `GET /adobe/repository?path=<damPath>` (or `GET /adobe/repository/?id=<urn:aaid:aem:uuid>` in Search/Collections) for metadata and download links.
   - Uses `ReadableStream` chunk processing and `HTTP 206` Range requests for large binaries.
4. **Shadow DOM Overlay**: Mounts a closed Shadow DOM overlay (`position: absolute; inset: 0`) directly inside `[class*="Detail__previewContainer__"]` (`div.previewContainer`), including a **"Show Adobe preview"** passthrough toggle.

## CLI Splat Decimator (`scripts/decimate-splat.mjs`)

For shrinking 1 GB+ raw `.ply` or `.splat` exports offline before uploading to AEM:

```bash
node scripts/decimate-splat.mjs /path/to/input.ply --max-splats 800000
```

## Adding a New Viewer Plugin

1. Create `extension/src/viewers/<format>/index.ts` implementing `ViewerPlugin` (`extension/src/viewers/types.ts`):
   ```ts
   import type { ViewerPlugin } from '../types';

   export const myFormatViewer: ViewerPlugin = {
     id: 'my-format',
     label: 'My Proprietary Viewer',
     badge: 'CAD',
     extensions: ['step', 'stp', 'iges'],
     async mount(ctx) {
       const buffer = await ctx.fetchBuffer((loaded, total) => {
         if (total) ctx.setProgress((loaded / total) * 100);
       });
       ctx.setProgress(null);
       // Render into ctx.container, register toolbar buttons via ctx.setActions(...)
       return () => {
         // Dispose WebGL/WASM/DOM resources on route change
       };
     },
   };
   ```
2. Register `myFormatViewer` in `VIEWER_PLUGINS` inside `extension/src/viewers/index.ts`.

## Build & Load in Chrome

```bash
cd extension
npm install
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Open an asset details page or folder in AEM Assets View (`https://experience.adobe.com/?repoId=author-pXXXX-eYYYY.adobeaemcloud.com#/@<org>/assets/...`).

## Docs

- `ASSETS_VIEW_CUSTOM_VIEWER.md` — Problem statement, capabilities summary, and enterprise production path
- `docs/ARCHITECTURE.md` — Runtime topology, module responsibilities, and lifecycle
- `docs/discovery.md` — Verified live DevTools/CDP findings (iframe URL, DOM selectors, APIs, Range support, auth, CSP, and native `app_plugins` 3D viewer analysis)
- `docs/research/` — Deep-dive notes on routes, APIs/auth, and MV3 injection/UI Extensibility fallback
