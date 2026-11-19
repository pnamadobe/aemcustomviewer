# Architecture – AEM Assets View Custom Viewer Platform

## Runtime Topology
```
experience.adobe.com (Unified Shell, top frame)
└── same-origin iframe: /thunderbird/solutions/CQ-assets-app (id^="exc-app-sandbox-ddam")
    ├── ISOLATED world: content.js (873 KB minified)
    │    ├── auth.ts                 (reads repoId + shellCachedTokens directly from sessionStorage)
    │    ├── router.ts               (watches #/detail/content/dam/... route changes)
    │    ├── overlay.ts              (mounts closed Shadow DOM inside [class*="Detail__previewContainer__"])
    │    ├── thumbnails/
    │    │    ├── store.ts           (persistent IndexedDB cache: acv-thumbnails-v1)
    │    │    └── card-observer.ts   (Card View [role="row"][data-key] custom thumbnails & video hover-scrub)
    │    └── viewers/                (ViewerPlugin registry)
    │         ├── gsplat/            (.splat, .ply, .splatv — WebGL2 + WASM sort + 1GB+ stream decimator)
    │         ├── model3d/           (.glb, .gltf, .obj, .stl — Three.js Studio PBR)
    │         ├── font/              (.ttf, .otf, .woff, .woff2 — FontFace + OpenType fvar sliders)
    │         ├── raw/               (.cr3, .cr2, .nef, .arw, .dng, .raf, .rw2, .orf, .pef, .iiq, .3fr, .hdr, .exr)
    │         └── audio/             (.mp3, .wav, .flac, .ogg — WebAudio FFT + OfflineAudioContext waveform)
    └── MAIN world: page-hook.js     (document_start fallback; intercepts fetch/XHR if sessionStorage changes)
```

## Module Responsibilities
| Module | Responsibility |
|---|---|
| `src/config.ts` | Frame matcher (`CQ-assets-app`), route regexes, Content Repository API endpoints (`/adobe/repository?path=` and `/adobe/repository/?id=`), default `x-api-key` (`aem-assets-frontend-1`) |
| `src/selectors.ts` | Verified DOM anchors for the Details preview container (`[class*="Detail__previewContainer__"]`, `div.previewContainer`) |
| `src/auth.ts` | Synchronous extraction of `repoId` and `shellCachedTokens` from Unified Shell's `sessionStorage` |
| `src/page-hook.ts` & `src/bridge.ts` | Fallback `MAIN`-world `fetch`/`XHR` token capture bridged via nonce `CustomEvent` |
| `src/router.ts` | Emits `details(damPath)` / `other` on SPA hash transitions |
| `src/assets-api.ts` | Calls `/adobe/repository?path=<damPath>` and `/adobe/repository/?id=<assetId>`, streams original binaries with byte progress, supports HTTP 206 Range requests, and fetches pre-signed `;api=block_download` URLs |
| `src/overlay.ts` | Mounts a closed Shadow DOM overlay (`position: absolute; inset: 0; z-index: 2`) inside the native preview container, providing the wrapping header bar, format badge, status telemetry, toolbar actions, progress bar, and **"Show Adobe preview"** passthrough toggle |
| `src/thumbnails/store.ts` | Persistent `IndexedDB` (`acv-thumbnails-v1`) + memory cache keyed by `urn:aaid:aem:<uuid>` and DAM path; survives browser restarts |
| `src/thumbnails/card-observer.ts` | Scans Card View (`div[role="row"][data-key^="urn:aaid:aem:"]`) across Folders, Search Results, and Collections; renders headless plugin thumbnails into `[slot="preview"]`, crossfades 16-frame 3D previews with a flicker-free double-buffered compositor, and attaches 24-frame cached video hover-scrubbing to video cards |
| `src/viewers/gsplat/stream-decimate.ts` & `decimate-memory.ts` | Constant-memory `ReadableStream` chunk decimator for 1 GB+ `.ply`/`.splat` files (2D surfel scale clamping, disk-area × `opacity²` reservoir, P50 median recentering, and `IndexedDB` binary cache `acv-splat-cache-v3`) plus in-place 50% decimation |
| `src/viewers/types.ts` & `src/viewers/index.ts` | `ViewerPlugin` and `ViewerContext` contract + central `VIEWER_PLUGINS` registry |

## Viewer & Thumbnail Lifecycle
1. **Card View (Folders, Search Results, and Collections)**:
   - `card-observer.ts` watches `div[role="row"][data-key^="urn:aaid:aem:"]` via a filtered `MutationObserver`.
   - **Video cards (`.mp4`, `.mov`, `.webm`, `.m4v`, `.ogv`)**: Displays a `⇄ SCRUB` badge. On first hover, streams AEM's `cq5dam.preview.mp4` proxy rendition via `;api=block_download;renditionName=cq5dam.preview.mp4` (with a 15-minute signed URL cache TTL) while extracting a **24-frame WebP scrub strip** in the background and caching it in `IndexedDB` (`⇄ SCRUB · CACHED`). Subsequent hovers scrub directly from `IndexedDB` with zero network requests.
   - **Plugin-matched cards (`.splat`, `.ply`, `.glb`, `.gltf`, `.obj`, `.stl`, `.ttf`, `.otf`, `.woff2`, `.cr3`, `.nef`, `.arw`, `.hdr`, `.exr`, `.mp3`, etc.)**:
     - Checks `IndexedDB` first. If cached, mounts immediately into `[slot="preview"]` and updates the `"Binary"` subtitle in `[slot="description"]`.
     - If uncached, resolves metadata by path (in Folder Browse) or by `urn:aaid:aem:<uuid>` (in Search/Collections), queues `plugin.renderThumbnail(meta, fetchBuffer)` (1 asset at a time), caches the resulting static WebP or 16-frame `acv-anim-v4` WebP animation payload in `IndexedDB`, and swaps it into the card.
     - For Camera RAW files (`> 8 MB`), `renderThumbnail` probes the first 8 MB via `Range: bytes=0-8388607` to extract the embedded JPEG preview without downloading the full RAW container.
   - **Flicker-Free 3D Card Animation (`acv-anim-v4`)**:
     - Scales `gsplat`'s camera focal length (`fx`, `fy`) to the thumbnail canvas size, applies luminance-weighted subject framing and an adaptive gamma LUT (`autoToneMapCanvas`), and composites frames over a permanently opaque base `<img class="acv-layer-base">` so the dark card background never bleeds through.
2. **Details View (`#/detail/content/dam/...`)**:
   - `IDLE → ON_DETAILS(damPath) → METADATA(/adobe/repository) → PICK_PLUGIN → (UNSUPPORTED → IDLE) | WAIT_CONTAINER → MOUNT_OVERLAY → STREAM_BINARY → INTERACTIVE`
   - Any error or route departure aborts in-flight requests, calls `WEBGL_lose_context.loseContext()` / `renderer.forceContextLoss()` and `document.fonts.delete()`, and removes the overlay so the native Adobe UI remains intact.
