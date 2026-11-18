# AEM Assets View – Custom Viewer & Thumbnail Platform (Browser Extension)

## Goal
Render proprietary, 3D, spatial, typography, and Camera RAW/HDR file types that AEM Assets View does not natively support — both as an **interactive viewer in the main Details preview area** and as **custom/animated thumbnails (plus video hover-scrubbing) in Card View**.

## Status
Working Chrome Manifest V3 extension (`extension/`), verified live against AEM as a Cloud Service Assets View (`CQ-assets-app`).

## Capabilities Built

### 1. Interactive Details Viewers & Headless Card View Thumbnails (`extension/src/viewers/`)
| Plugin | Badge | Formats | Details Viewer | Card View Thumbnail |
|---|---|---|---|---|
| **3D Gaussian Splatting** (`gsplat`) | `3DGS` | `.splat`, `.ply`, `.splatv` | WebGL2 + WASM depth-sort viewer with orbit/pan/zoom/WASD, scene-vs-object motion presets (`Orbit`, `Slow Push`, `Fixed Rotate`), background switcher, and animated preview recorder | 16-frame slow-drift (~12s crossfaded) WebP preview (`ORBIT` for objects, `PUSH` for scenes) + horizontal hover-scrub |
| **3D Models & CAD Meshes** (`model3d`) | `3D` | `.glb`, `.gltf`, `.obj`, `.stl` | Three.js studio PBR (`RoomEnvironment`), `PBR` / `CLAY` / `NORMALS` shading switcher, Wireframe & Grid toggles, GLTF animation playback, and triangle/vertex/FPS telemetry | 16-frame studio-lit PBR slow-drift WebP preview + hover-scrub |
| **Fonts & Variable Fonts** (`font`) | `FONT` | `.ttf`, `.otf`, `.woff`, `.woff2` | Native `FontFace` loader + OpenType `fvar`/`maxp` binary parser, live **Variable Font axis sliders** (`wght`, `wdth`, `slnt`, `opsz`), editable hero tester, Size Waterfall, Glyph Map grid, and Dark/Paper themes | Typography specimen card (`"Aa"`, alphabet, glyph count & Variable Font axes) |
| **Camera RAW & 32-bit HDR** (`raw-image`) | `RAW` | `.cr3`, `.cr2`, `.nef`, `.arw`, `.dng`, `.raf`, `.rw2`, `.orf`, `.pef`, `.srw`, `.iiq`, `.3fr`, `.hdr`, `.exr` | Darkroom inspector with **Exposure (`-3` to `+3 EV`) slider**, live **RGB Parade Histogram**, Camera EXIF Make/Model detection, and 1:1 Loupe zoom | Instant embedded full-res JPEG extractor (RAW) & ACES Filmic tone-mapped card (`.hdr`/`.exr`) |
| **Audio Spectrum & Waveform** (`audio-spectrum`) | `AUDIO` | `.mp3`, `.wav`, `.flac`, `.ogg` | Real-time WebAudio FFT frequency spectrum analyzer + HTML5 audio transport | 64-bar stereo waveform card via `OfflineAudioContext` |

### 2. Card View Hover-Scrub Video Thumbnails (`extension/src/thumbnails/card-observer.ts`)
- Attaches to `.mp4`, `.mov`, `.webm`, `.m4v`, and `.ogv` cards in Card View (`⇄ SCRUB`).
- On first hover, streams AEM's `cq5dam.preview.mp4` proxy rendition via `;api=block_download;renditionName=cq5dam.preview.mp4` for immediate mouse-scrubbing while extracting a **24-frame WebP scrub strip** in the background and saving it to `IndexedDB` (`⇄ SCRUB · CACHED`).
- All subsequent hovers scrub instantaneously from `IndexedDB` with zero network traffic.

### 3. Persistent `IndexedDB` Cache (`extension/src/thumbnails/store.ts`)
- All generated thumbnails, 16-frame 3D animation loops, and 24-frame video scrub strips are stored persistently in `IndexedDB` (`acv-thumbnails-v1`) keyed by `urn:aaid:aem:<uuid>` and DAM path, surviving page reloads and browser restarts.

## Project Structure
```
extension/
  manifest.json                # MV3, all_frames content scripts on https://experience.adobe.com/*
  package.json                 # esbuild + TypeScript build pipeline
  src/
    config.ts                  # CQ-assets-app frame matcher, DAM path regexes, Content Repository API URLs
    selectors.ts               # Verified DOM anchors ([class*="Detail__previewContainer__"], div.previewContainer)
    auth.ts                    # Synchronous sessionStorage reader (repoId + shellCachedTokens)
    page-hook.ts               # MAIN-world fetch/XHR interception fallback
    bridge.ts                  # Nonce CustomEvent bridge
    router.ts                  # SPA hash route watcher (#/detail/content/dam/...)
    assets-api.ts              # /adobe/repository metadata, streaming binary loader, signed block_download URLs
    overlay.ts                 # Closed Shadow DOM overlay host, toolbar, progress bar, Adobe preview toggle
    thumbnails/
      store.ts                 # Persistent IndexedDB cache (acv-thumbnails-v1)
      card-observer.ts         # Card View custom thumbnail injector + video hover-scrubbing
    viewers/
      types.ts                 # ViewerPlugin & ViewerContext interfaces
      index.ts                 # VIEWER_PLUGINS registry
      gsplat/index.ts          # 3D Gaussian Splatting (.splat, .ply, .splatv)
      model3d/index.ts         # 3D Models & Meshes (.glb, .gltf, .obj, .stl)
      font/index.ts            # Fonts & Variable Fonts (.ttf, .otf, .woff, .woff2)
      raw/index.ts             # Camera RAW & 32-bit HDR (.cr3, .nef, .arw, .dng, .hdr, .exr, ...)
      audio/index.ts           # Audio Spectrum & Waveform (.mp3, .wav, .flac, .ogg)
      placeholder.ts           # Minimal template for new viewer plugins
  ui/overlay.css
docs/
  ARCHITECTURE.md              # Runtime topology, module responsibilities, and lifecycle
  discovery.md                 # Verified live CDP/DevTools findings against AEM Assets View
  research/                    # Initial fanout research notes (01-iframe-routes, 02-api-auth, 03-mv3-injection)
```

## Discovery Checklist (Completed)
- [x] Confirm the Assets View iframe origin and URL pattern (`https://experience.adobe.com/thunderbird/solutions/CQ-assets-app#/detail/content/dam/...`).
- [x] Find stable anchors for Details (`[class*="Detail__previewContainer__"]`, `div.previewContainer`) and Card View (`div[role="row"][data-key^="urn:aaid:aem:"] [slot="preview"]`).
- [x] Record the API calls made by Assets View (`/adobe/repository?path=...`, `;api=block_download`, `/content/dam/...` with HTTP 206 Range support).
- [x] Confirm token source (`sessionStorage.shellCachedTokens` + `x-api-key: aem-assets-frontend-1`).
- [x] Confirm CSP (`blob:` and `data:` allowed; no `script-src` or `worker-src` blocks).
