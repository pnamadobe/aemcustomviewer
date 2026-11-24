# AEM Assets View – Custom Viewer & Thumbnail Platform (Browser Extension)

## Goal
Render proprietary, 3D, spatial, typography, and Camera RAW/HDR file types that AEM Assets View does not natively support — both as an **interactive viewer in the main Details preview area** and as **custom/animated thumbnails (plus video hover-scrubbing) in Card View**.

## Status
Working Chrome Manifest V3 extension (`extension/`, v0.3.0, `1.1 MB` minified bundle), verified live against AEM as a Cloud Service Assets View (`CQ-assets-app`).

## Demo Video
▶️ **[Watch the demo on YouTube](https://youtu.be/sXPfwydOvTk)**

## Capabilities Built

### 1. Interactive Details Viewers & Headless Card View Thumbnails (`extension/src/viewers/`)
| Plugin | Badge | Formats | Details Viewer | Card View Thumbnail |
|---|---|---|---|---|
| **3D Gaussian Splatting** (`gsplat`) | `3DGS` | `.splat`, `.ply`, `.splatv` | WebGL2 + WASM depth-sort viewer with in-browser `ReadableStream` chunk decimation for 1 GB+ `.ply`/`.splat` files, 2D surfel support, in-place 50% decimation (`✂ -50%`), local 1 GB+ file decimator (`📂 Local File…`), `🏠 Inside Room` / `🔭 Outside` camera presets, and `IndexedDB` binary cache (`acv-splat-cache-v3`) | 16-frame slow-drift (~12s flicker-free double-buffered) WebP preview (`acv-anim-v4`) with scaled focal length, luminance-weighted framing, and auto-gamma tone mapping |
| **3D Models, CAD & OpenUSD** (`model3d`) | `3D` | `.glb`, `.gltf`, `.fbx`, `.obj`, `.stl`, `.usdz`, `.usda`, `.usdc`, `.usd`, `.dae`, `.3mf`, `.3ds`, `.amf` | Three.js studio PBR (`RoomEnvironment`), automatic FBX/Collada Phong-to-PBR material upgrade, `PBR` / `CLAY` / `NORMALS` shading switcher, Wireframe & Grid toggles, GLTF/FBX animation playback, and triangle/vertex/FPS telemetry | 16-frame studio-lit PBR slow-drift WebP preview + hover-scrub |
| **3D Materials, Trims & Substance / U3MA** (`texture3d`) | `PBR` | `.u3ma`, `.u3m`, `.zfab`, `.sbsar`, `.mtlx`, `.dds`, `.ktx`, `.ktx2`, `.tga`, `.mtl` | In-memory `.u3ma`/`.zfab` ZIP unpacker (`fflate`), **Browzwear 3D Trim (`trim3d` `.u3ma` with embedded `.fbx` + multi-part `.u3m` sub-materials)**, **Adobe Substance 3D (`.sbsar`)**, Three.js `MeshPhysicalMaterial`, 6 meshes (`3D Trim (FBX)`, `Draped Cloth`, `Shader Ball`, `Fabric Swatch`, `Roll`, `Flat Tile`), interactive PBR Map Dock, `3D + 2D Split` seamless tiling inspector, `1×`–`8×` UV repeat, and physical fabric/trim telemetry | 16-frame studio-lit 3D Trim / Draped Cloth / Shader Ball orbit WebP preview with 2D swatch inset + hover-scrub |
| **Fonts & Variable Fonts** (`font`) | `FONT` | `.ttf`, `.otf`, `.woff`, `.woff2` | Native `FontFace` loader + OpenType `fvar`/`maxp` binary parser, live **Variable Font axis sliders** (`wght`, `wdth`, `slnt`, `opsz`), editable hero tester, Size Waterfall, Glyph Map grid, and Dark/Paper themes | Typography specimen card (`"Aa"`, alphabet, glyph count & Variable Font axes) |
| **Camera RAW & 32-bit HDR** (`raw-image`) | `RAW` | `.cr3`, `.cr2`, `.nef`, `.arw`, `.dng`, `.raf`, `.rw2`, `.orf`, `.pef`, `.srw`, `.iiq`, `.3fr`, `.hdr`, `.exr` | Darkroom inspector with 8 MB HTTP 206 `Range` preview probe, **Exposure (`-3` to `+3 EV`) slider**, live **RGB Parade Histogram**, Camera EXIF Make/Model detection, and 1:1 Loupe zoom | Fast 8 MB Range embedded JPEG extractor (RAW) & ACES Filmic tone-mapped card (`.hdr`/`.exr`) |
| **Audio Spectrum & Waveform** (`audio-spectrum`) | `AUDIO` | `.mp3`, `.wav`, `.flac`, `.ogg` | Real-time WebAudio FFT frequency spectrum analyzer + HTML5 audio transport | 64-bar stereo waveform card via `OfflineAudioContext` |

### 2. Card View Hover-Scrub Video Thumbnails (`extension/src/thumbnails/card-observer.ts`)
- Attaches to `.mp4`, `.mov`, `.webm`, `.m4v`, and `.ogv` cards across **Folders, Search Results, and Collections** (`⇄ SCRUB`).
- On first hover, streams AEM's `cq5dam.preview.mp4` proxy rendition via `;api=block_download;renditionName=cq5dam.preview.mp4` for immediate mouse-scrubbing while extracting a **24-frame WebP scrub strip** in the background and saving it to `IndexedDB` (`⇄ SCRUB · CACHED`).
- All subsequent hovers scrub instantaneously from `IndexedDB` with zero network traffic.

### 3. Persistent `IndexedDB` Caches
- **`acv-thumbnails-v1`** (`extension/src/thumbnails/store.ts`): Stores generated static thumbnails, 16-frame 3D animation loops (`acv-anim-v4`), and 24-frame video scrub strips keyed by `urn:aaid:aem:<uuid>` and DAM path.
- **`acv-splat-cache-v3`** (`extension/src/viewers/gsplat/stream-decimate.ts`): Caches stream-decimated `.splat` binaries for huge (>25 MB / 1 GB+) `.ply` and `.splat` assets so reopening them takes ~0.2 seconds.

## Enterprise Production Path vs. Prototype
- **Ingest-Time (Asset Compute Custom Workers)**: In an enterprise deployment, heavy decimation (`scripts/decimate-splat.mjs`), RAW preview extraction, font specimen rendering, and video scrub-strip generation run **once on upload** in Adobe I/O Runtime and write standard AEM renditions (`cq5dam.thumbnail.319.319.png`, `cq5dam.web.splat`).
- **View-Time (Details Viewer)**: Loads the lightweight pre-decimated rendition via Assets View's internal `app_plugins` renderer or a UI Extensibility preview slot.

## Project Structure
```
extension/
  manifest.json                # MV3, scoped to https://experience.adobe.com/*solutions/CQ-assets-app*
  package.json                 # esbuild (--minify) + TypeScript build pipeline
  src/
    config.ts                  # CQ-assets-app frame matcher, DAM path regexes, Content Repository API URLs
    selectors.ts               # Verified DOM anchors ([class*="Detail__previewContainer__"], div.previewContainer)
    auth.ts                    # Synchronous sessionStorage reader (repoId + shellCachedTokens)
    page-hook.ts               # MAIN-world fetch/XHR interception fallback
    bridge.ts                  # Nonce CustomEvent bridge
    router.ts                  # SPA hash route watcher (#/detail/content/dam/...)
    assets-api.ts              # /adobe/repository metadata (by path & UUID), Range requests, signed block_download URLs
    overlay.ts                 # Closed Shadow DOM overlay host mounted inside target preview container
    thumbnails/
      store.ts                 # Persistent IndexedDB cache (acv-thumbnails-v1)
      card-observer.ts         # Card View custom thumbnail injector + video hover-scrubbing
    viewers/
      types.ts                 # ViewerPlugin & ViewerContext interfaces
      index.ts                 # VIEWER_PLUGINS registry
      gsplat/
        index.ts               # 3D Gaussian Splatting viewer & auto-gamma thumbnail renderer
        stream-decimate.ts     # In-browser ReadableStream chunk decimator & IndexedDB binary cache
        decimate-memory.ts     # Interactive 50% in-place surfel-aware decimator
      model3d/index.ts         # 3D Models, CAD & OpenUSD (.glb, .gltf, .fbx, .obj, .stl, .usdz, .usd, .dae, .3mf, .3ds, .amf)
      texture3d/index.ts       # 3D Materials, Trims & Substance (.u3ma, .u3m, .zfab, .sbsar, .mtlx, .dds, .ktx, .tga, .mtl)
      font/index.ts            # Fonts & Variable Fonts (.ttf, .otf, .woff, .woff2)
      raw/index.ts             # Camera RAW & 32-bit HDR (.cr3, .nef, .arw, .dng, .hdr, .exr, ...)
      audio/index.ts           # Audio Spectrum & Waveform (.mp3, .wav, .flac, .ogg)
      placeholder.ts           # Minimal template for new viewer plugins
  ui/overlay.css
scripts/
  decimate-splat.mjs           # Node CLI decimator & .ply -> .splat converter for 1 GB+ files
docs/
  ARCHITECTURE.md              # Runtime topology, module responsibilities, and lifecycle
  discovery.md                 # Verified live CDP/DevTools findings against AEM Assets View
  research/                    # Initial fanout research notes (01-iframe-routes, 02-api-auth, 03-mv3-injection)
```
