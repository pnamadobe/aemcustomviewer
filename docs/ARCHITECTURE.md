# Architecture – Assets View Custom Viewer

## Runtime topology
```
experience.adobe.com (Unified Shell, top frame)
└── iframe: Assets View origin (TBD → docs/research/01)
    ├── MAIN world:     page-hook.js   (document_start; wraps fetch/XHR, reads Authorization)
    │        │  CustomEvent on a per-load random channel (nonce handshake)
    ├── ISOLATED world: content.js     (router, DOM observer, asset resolver, overlay host)
    │        └── Shadow DOM overlay → viewer registry → <format> renderer (canvas/WebGL/WASM)
    └── (optional) service worker: settings, enable/disable, allowlist by org
```

## Modules
| Module | Responsibility | Depends on |
|---|---|---|
| `config.ts` | Origins, API base, header names, format allowlist. Every unverified value lives here | – |
| `selectors.ts` | All DOM anchors, with an ordered fallback list per anchor | – |
| `page-hook.ts` | MAIN world. Captures the bearer token and api-key/org headers from the app's own requests. Never logs or stores them | config |
| `bridge.ts` | Typed MAIN↔ISOLATED messaging with nonce and source checks | – |
| `router.ts` | Emits `route:details(assetId)` / `route:leave`. Uses a pushState patch, popstate/hashchange, and URL polling as a fallback | config |
| `asset-resolver.ts` | Gets the assetId (URL first, DOM second) and then metadata (mime, name, size) | assets-api |
| `assets-api.ts` | `getMetadata(id)`, `getOriginal(id, range?)` using captured auth | bridge, config |
| `overlay.ts` | Finds the preview container, mounts an absolutely positioned Shadow-DOM host, tracks it with ResizeObserver, adds a "Show Adobe preview" toggle, tears down | selectors |
| `viewers/index.ts` | Registry: `{ match(meta) → boolean, mount(el, src) → dispose }` | – |
| `content.ts` | Orchestrator and state machine | all |

## State machine (content.ts)
`IDLE → ON_DETAILS(id) → RESOLVING → (UNSUPPORTED → IDLE) | WAIT_CONTAINER → MOUNTED → (route change) → TEARDOWN → IDLE`
Any error moves to TEARDOWN and leaves the native UI as it was (fail safe).

## Key decisions
1. **Overlay, not replacement.** React owns the preview DOM.
2. **Shadow DOM.** Isolates styles in both directions.
3. **Token stays in memory.** It is used only for requests to the allowlisted API origin.
4. **Feature detection for all selectors and endpoints.** If something is missing, the extension does nothing.
5. **Renderer contract is format-agnostic.** The existing proprietary renderer plugs in through `viewers/<format>.ts`.
6. **Fallback path.** Reuse the same `viewers/` package in a supported header-menu modal (App Builder UIX), so the renderer is written once.

## Research-driven updates
- **Rendering host:** heavy renderers (WASM/WebGL) run in an extension-origin iframe (`web_accessible_resources`) inside the Shadow DOM. This avoids the page's CSP and Trusted Types. The bytes are sent with `postMessage` as a transferable `ArrayBuffer`.
- **Token capture:**
  - Plan A: `chrome.webRequest.onSendHeaders` (`extraHeaders`) in the service worker. It is passive, sees the real `x-api-key`, and puts no token in the page.
  - Plan B: the MAIN-world fetch/XHR hook (current scaffold).
  - Plan C: `adobeIMS.getAccessToken()` in the top frame.
  - With any plan, re-capture the token after a 401.
- **Binary fetch:**
  - Endpoint: `GET /adobe/assets/{id}/original/as/{name}`. It may redirect to a signed blob URL, and Range support is unverified.
  - Consider making the request from the service worker, which avoids CORS.
- **Supported fallback:**
  - Extension point: `aem/assets/assetsview/1`. Add a header-menu button that calls `modal.openDialog({ type: 'fullscreen' })`.
  - It gets the asset through `details.getCurrentResourceInfo()` and auth through `sharedContext`.
  - It reuses the same `viewers/` package.
  - It needs Assets Ultimate and a support ticket to enable.

## Open questions (answered by docs/research/*)
- Iframe origin and details route pattern (01)
- Original-binary endpoint, required headers, Range/CORS (02)
- Static `world: MAIN` vs executeScript, CSP/Trusted Types, WASM (03)
