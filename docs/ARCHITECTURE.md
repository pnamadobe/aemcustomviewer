# Architecture – AEM Assets View Custom Viewer Platform

## Runtime Topology
```
experience.adobe.com (Unified Shell, top frame)
└── same-origin iframe: /thunderbird/solutions/CQ-assets-app (id^="exc-app-sandbox-ddam")
    ├── ISOLATED world: content.js
    │    ├── auth.ts                 (reads repoId + shellCachedTokens directly from sessionStorage)
    │    ├── router.ts               (watches #/detail/content/dam/... route changes)
    │    ├── overlay.ts              (mounts closed Shadow DOM over [class*="Detail__previewContainer__"])
    │    ├── thumbnails/
    │    │    ├── store.ts           (persistent IndexedDB cache: acv-thumbnails-v1)
    │    │    └── card-observer.ts   (Card View [role="row"][data-key] custom thumbnails & video hover-scrub)
    │    └── viewers/                (ViewerPlugin registry)
    │         ├── gsplat/            (.splat, .ply, .splatv — WebGL2 + WASM sort worker)
    │         ├── model3d/           (.glb, .gltf, .obj, .stl — Three.js Studio PBR)
    │         ├── font/              (.ttf, .otf, .woff, .woff2 — FontFace + OpenType fvar sliders)
    │         ├── raw/               (.cr3, .cr2, .nef, .arw, .dng, .raf, .rw2, .orf, .pef, .iiq, .3fr, .hdr, .exr)
    │         └── audio/             (.mp3, .wav, .flac, .ogg — WebAudio FFT + OfflineAudioContext waveform)
    └── MAIN world: page-hook.js     (document_start fallback; intercepts fetch/XHR if sessionStorage changes)
```

## Module Responsibilities
| Module | Responsibility |
|---|---|
| `src/config.ts` | Frame matcher (`CQ-assets-app`), route regexes, Content Repository API endpoints, default `x-api-key` (`aem-assets-frontend-1`) |
| `src/selectors.ts` | Verified DOM anchors for the Details preview container (`[class*="Detail__previewContainer__"]`, `div.previewContainer`) |
| `src/auth.ts` | Synchronous extraction of `repoId` and `shellCachedTokens` from Unified Shell's `sessionStorage` |
| `src/page-hook.ts` & `src/bridge.ts` | Fallback `MAIN`-world `fetch`/`XHR` token capture bridged via nonce `CustomEvent` |
| `src/router.ts` | Emits `details(damPath)` / `other` on SPA hash transitions |
| `src/assets-api.ts` | Calls `/adobe/repository?path=<damPath>`, streams original binaries with byte progress, and fetches pre-signed `;api=block_download` URLs |
| `src/overlay.ts` | Anchors a closed Shadow DOM overlay over the native preview container using `ResizeObserver`, providing the shared header bar, format badge, status telemetry, toolbar actions, progress bar, and **"Show Adobe preview"** passthrough toggle |
| `src/thumbnails/store.ts` | Persistent `IndexedDB` (`acv-thumbnails-v1`) + memory cache keyed by `urn:aaid:aem:<uuid>` and DAM path; survives browser restarts |
| `src/thumbnails/card-observer.ts` | Scans Card View (`div[role="row"][data-key^="urn:aaid:aem:"]`), renders headless plugin thumbnails into `[slot="preview"]`, crossfades 16-frame 3D previews over a calm ~12s cycle, and attaches 24-frame cached video hover-scrubbing to video cards |
| `src/viewers/types.ts` & `src/viewers/index.ts` | `ViewerPlugin` and `ViewerContext` contract + central `VIEWER_PLUGINS` registry |

## Viewer & Thumbnail Lifecycle
1. **Card View (`#/browse/content/dam/...`)**:
   - `card-observer.ts` watches `div[role="row"][data-key^="urn:aaid:aem:"]` via a filtered `MutationObserver`.
   - **Video cards (`.mp4`, `.mov`, `.webm`, `.m4v`, `.ogv`)**: Displays a `⇄ SCRUB` badge. On first hover, streams AEM's `cq5dam.preview.mp4` proxy rendition via `;api=block_download;renditionName=cq5dam.preview.mp4` for immediate seeking while extracting a **24-frame WebP scrub strip** in the background and caching it in `IndexedDB` (`⇄ SCRUB · CACHED`). Subsequent hovers scrub directly from `IndexedDB` with zero network requests.
   - **Plugin-matched cards (`.splat`, `.ply`, `.glb`, `.gltf`, `.obj`, `.stl`, `.ttf`, `.otf`, `.woff2`, `.cr3`, `.nef`, `.arw`, `.hdr`, `.exr`, `.mp3`, etc.)**:
     - Checks `IndexedDB` first. If cached, mounts immediately into `[slot="preview"]` and updates the `"Binary"` subtitle in `[slot="description"]`.
     - If uncached, queues `plugin.renderThumbnail(meta, fetchBuffer)` (1 asset at a time), caches the resulting static WebP or 16-frame `acv-anim-v2` WebP animation payload in `IndexedDB`, and swaps it into the card.
   - **3D Card Animation (`acv-anim-v2`)**:
     - Uses a gentle camera excursion (`±18°` orbit for bounded objects, `14%` slow dolly push for unbounded scenes, or `±12°` tripod pan) and steps every `380ms` with a `340ms` CSS opacity crossfade (~12s full cycle, random phase per card) so 30+ cards on screen remain calm. Hovering a card enables instant horizontal mouse scrubbing across the 16 frames.
2. **Details View (`#/detail/content/dam/...`)**:
   - `IDLE → ON_DETAILS(damPath) → METADATA(/adobe/repository) → PICK_PLUGIN → (UNSUPPORTED → IDLE) | WAIT_CONTAINER → MOUNT_OVERLAY → STREAM_BINARY → INTERACTIVE`
   - Any error or route departure aborts in-flight requests, disposes WebGL/WebAudio contexts, and removes the overlay so the native Adobe UI remains intact.
