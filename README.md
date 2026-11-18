# AEM Assets View – Custom Viewer Platform (`aemcustomviewer`)

A Chrome Manifest V3 extension platform that injects interactive, high-performance custom viewers into the **main preview area** of the AEM as a Cloud Service **Assets View** (`CQ-assets-app`) details page for file types AEM does not natively render.

## Built-in Viewer Plugins

| Plugin | Badge | Extensions | Renderer |
|---|---|---|---|
| **3D Gaussian Splatting** (`src/viewers/gsplat`) | `3DGS` | `.splat`, `.ply`, `.splatv` | WebGL2 (`gsplat`) with orbit/pan/zoom/WASD controls, turntable auto-rotate, background switcher, live splat count + FPS HUD, and `.splat` export |
| **Audio Spectrum & Waveform** (`src/viewers/audio`) | `AUDIO` | `.mp3`, `.wav`, `.flac`, `.ogg` | WebAudio FFT spectrum analyzer + HTML5 audio transport |
| **Reference Placeholder** (`src/viewers/placeholder`) | `CUSTOM` | `.xyz` | Minimal template for adding new proprietary format plugins |

## How It Works

1. **Same-Origin Iframe Targeting**: Runs inside `https://experience.adobe.com/thunderbird/solutions/CQ-assets-app` (`all_frames: true`).
2. **Route Watching**: Detects `#/detail/content/dam/<path>` transitions and cleans up immediately on navigation away.
3. **Auth & Content Repository API**:
   - Reads the IMS token (`shellCachedTokens`) and `repoId` directly from Unified Shell's `sessionStorage` (with a `MAIN`-world `fetch`/`XHR` hook in `page-hook.ts` as automatic fallback).
   - Queries `GET https://<repoId>/adobe/repository?path=<damPath>` for `repo:id`, `repo:name`, `dc:format`, `repo:size`, and `_links[rel/primary].href`.
   - Streams the original binary with real-time byte progress (`ReadableStream`) or `HTTP 206` Range requests.
4. **Shadow DOM Overlay**: Mounts a closed Shadow DOM overlay tracked with `ResizeObserver` over `[class*="Detail__previewContainer__"]` (`div.previewContainer`), including a **"Show Adobe preview"** passthrough toggle.

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
2. Register `myFormatViewer` in ` VIEWER_PLUGINS` inside `extension/src/viewers/index.ts`.

## Build & Load in Chrome

```bash
cd extension
npm install
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Open an asset details page in AEM Assets View (`https://experience.adobe.com/?repoId=author-pXXXX-eYYYY.adobeaemcloud.com#/@<org>/assets/detail/content/dam/...`).

## Docs

- `ASSETS_VIEW_CUSTOM_VIEWER.md` — Original problem statement and approach
- `docs/ARCHITECTURE.md` — Platform architecture, plugin lifecycle, and research updates
- `docs/discovery.md` — Verified live DevTools/CDP findings (iframe URL, DOM selectors, APIs, Range support, auth, CSP)
- `docs/research/` — Deep-dive notes on routes, APIs/auth, and MV3 injection/UI Extensibility fallback
