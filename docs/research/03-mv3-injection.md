# 03 – MV3 Injection into AEM Assets View (experience.adobe.com)

Context: Unified Shell (`https://experience.adobe.com/#/@tenant/assets/...`) hosts the Assets View app in a **cross-origin iframe** (typically `https://experience.adobe.com` shell → app iframe on an `*.adobe.com` / `*.adobeio-static.net` / `assets.adobe.com`-style origin; verify in DevTools → Frames). Hash-based routing in the shell; app uses its own history routing.

Confidence legend: **H** = documented/verified API behavior, **M** = documented but environment-specific, **L** = inference to verify.

---

## 1. Content-script registration

```jsonc
{
  "manifest_version": 3,
  "host_permissions": ["https://experience.adobe.com/*", "https://*.adobe.com/*", "https://*.adobeio-static.net/*"],
  "content_scripts": [
    { // ISOLATED: UI, bridge, chrome.* APIs
      "matches": ["https://*.adobe.com/*", "https://*.adobeio-static.net/*"],
      "all_frames": true,
      "match_origin_as_fallback": true,   // Chrome 119+: about:blank/blob:/data: frames by origin
      "run_at": "document_start",
      "js": ["isolated.js"]
    },
    { // MAIN: fetch/XHR patch, must beat app code
      "matches": ["https://*.adobe.com/*", "https://*.adobeio-static.net/*"],
      "all_frames": true,
      "run_at": "document_start",
      "world": "MAIN",                    // static MAIN world: Chrome 111+
      "js": ["main.js"]
    }
  ]
}
```

- `all_frames: true` is required; matching is per-frame against the **frame's own URL**, not the top page. Narrow it inside the script (`if (location.hostname !== EXPECTED) return;`) to avoid running in every Adobe frame. **H**
- `match_origin_as_fallback` (Chrome 119+; replaces `match_about_blank`) only matters for `about:`/`blob:`/`data:` frames; when true, `matches` paths must be `/*`. **H**
- Static `"world": "MAIN"` (Chrome 111+) with `document_start` is the **only reliable way** to patch `window.fetch`/`XMLHttpRequest` before page scripts run. `chrome.scripting.executeScript({world:'MAIN', injectImmediately:true})` from the service worker is racy (needs `webNavigation.onCommitted` + frameId, often lands after app bootstrap). `chrome.scripting.registerContentScripts({world:'MAIN', runAt:'document_start', allFrames:true})` is equivalent to static and allows dynamic enable/disable. **H**
- MAIN-world scripts have **no `chrome.*` APIs**; communicate via the bridge (§3). **H**
- Patch defensively: keep originals, wrap `fetch` and `XMLHttpRequest.prototype.open/send`, clone responses (`res.clone().json()`) and never alter app behavior; tolerate the app capturing `fetch` early in a worker (service/web workers are **not** patched by content scripts). **M**

## 2. CSP, Trusted Types, Shadow DOM, WASM/WebGL

- Content scripts (both worlds) **bypass page CSP for script execution** of the injected file itself. But code in MAIN world is otherwise subject to page CSP: no `eval`, injected `<script>`/inline handlers blocked, `fetch` subject to `connect-src`. **H**
- **Trusted Types**: if the page sends `require-trusted-types-for 'script'`, MAIN-world `innerHTML =` string assignments throw. ISOLATED-world DOM writes are **exempt** from page TT enforcement (Chrome isolates TT per world). Do all DOM building in ISOLATED world; prefer `createElement`/`textContent` anyway. **M** (check response headers of the Assets View frame)
- **Shadow DOM**: attach overlay host to `document.documentElement` (survives SPA body swaps), `attachShadow({mode:'closed'})`, inject styles via `<style>` text or `adoptedStyleSheets` (constructable sheets avoid `style-src` issues; `<link>` to `chrome-extension://` CSS must be web-accessible). Use `all: initial` on host, high `z-index`, `position: fixed; inset: 0` for full-viewport overlay within the iframe. Note: overlay is bounded by the **iframe viewport**, not the whole shell; for true full-screen use `element.requestFullscreen()` (requires iframe `allow="fullscreen"` — verify) or inject in the top frame too. **M**
- **WASM**: in content scripts, compilation is governed by the **extension's** CSP. MV3 default extension_pages CSP is `script-src 'self'; object-src 'self'`; add `'wasm-unsafe-eval'` (Chrome 103+):
  ```json
  "content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }
  ```
  Load `.wasm` via `fetch(chrome.runtime.getURL('x.wasm'))` → `WebAssembly.instantiate(bytes)` from ISOLATED world; list it in `web_accessible_resources` (`matches` scoped to Adobe origins, `use_dynamic_url: true` to reduce fingerprinting). Isolated-world WASM compile on CSP-strict pages has historically varied; fallback: run WASM in an **offscreen document** or an extension-origin **iframe** (`chrome-extension://…/viewer.html`, web-accessible) inside the shadow root — this also cleanly sidesteps page CSP/TT entirely. **M**
- **WebGL**: canvases in content scripts work normally; no CSP impact. Texture loads from cross-origin URLs need CORS; fetch via extension (host_permissions) and pass `ImageBitmap`/blob. **H**
- Recommended architecture: render the viewer in an **extension-origin iframe** inside the overlay; content script only provides frame + data. Strongest isolation. **H**

## 3. MAIN ↔ ISOLATED bridge

Both worlds share the DOM and `window`, so anything posted is visible to the page. Rules:
- Prefer `CustomEvent` on a **private, non-enumerable target** over `window.postMessage` (which any frame/script can receive). Pattern: ISOLATED creates nonce at `document_start`, but MAIN can't receive it secretly… Practical approach:
  1. MAIN script captures `const dispatch = EventTarget.prototype.dispatchEvent` etc. at start (before app can tamper).
  2. Use event name with random suffix agreed via a one-shot handshake: MAIN generates `nonce = crypto.randomUUID()`, dispatches `new CustomEvent('ext-hello', {detail: nonce})` on `document` immediately (page code hasn't run at document_start so it can't sniff it); ISOLATED listens, stores nonce; thereafter events are named `ext-${nonce}`.
  3. `detail` crossing worlds must be structured-cloneable (strings/JSON); objects from MAIN are cloned in Chrome. **M**
- If using `postMessage`: check `event.source === window`, `event.origin === location.origin`, and a `type`+nonce field; never `'*'` target to other frames. **H**
- **Token hygiene**: don't send IMS bearer tokens MAIN→DOM events beyond minimum; never write tokens to DOM attributes/localStorage; only forward from ISOLATED to the service worker via `chrome.runtime.sendMessage`. Prefer intercepting only the **asset URL/ID** and letting the request ride page cookies, or do authed fetches from MAIN world itself. Treat any data from MAIN as untrusted (page can forge events). **H**

## 4. SPA route detection

- Combine: patch `history.pushState/replaceState` (MAIN) + `popstate` + `hashchange` (shell uses hash) + Navigation API `navigation.addEventListener('navigate')` (Chrome 102+, works in ISOLATED for observing) + fallback `MutationObserver` on a stable container, debounced. **H**
- Key off **semantic state** (asset ID parsed from URL or intercepted API response), not DOM classnames (Spectrum/React class hashes change). Re-entrancy: idempotent `mount()`/`unmount()` keyed by asset ID. **M**
- Top shell and inner iframe navigate independently; top-frame hash changes may not change iframe URL — listen in the frame that owns the route, or relay via `chrome.runtime` with `sender.frameId`. **M**

## 5. Enterprise deployment

- Policy `ExtensionInstallForcelist`: `"<extension_id>;<update_url>"` (CWS: `https://clients2.google.com/service/update2/crx`). Self-hosted needs update manifest XML + CRX; on Windows/macOS off-CWS force-install only works for domain-joined/MDM-managed (CBCM) devices. **H**
- Use `ExtensionSettings` for finer control (`installation_mode: force_installed`, `runtime_allowed_hosts`, block `runtime_blocked_hosts`). Ensure Adobe hosts aren't in `runtime_blocked_hosts`. Unlisted CWS + forcelist is the simplest path. Managed config via `storage.managed` + `managed_schema`. **H**
- Sources: https://chromeenterprise.google/policies/#ExtensionInstallForcelist , https://support.google.com/chrome/a/answer/7532015 , https://support.google.com/chrome/a/answer/9867568

## 6. Supported alternative: AEM UI Extensibility (Assets View)

Verified against AdobeDocs/uix source (Nov 2026) + Experience League. **H** unless noted.

- Built with **Adobe App Builder** + `@adobe/uix-guest` (`register()` in the extension index route, `attach()` in modal/panel routes). Runs as an Adobe-hosted iframe; no browser install. Enabled per environment via Extension Manager.
- **Extension point**: new extensions should use unified **`aem/assets/assetsview/1`** (covers Browse + Details). `aem/assets/details/1` and `aem/assets/browse/1` remain supported for existing extensions. Declared in `src/aem-assets-view-1/ext.config.yaml` style config.
- **Details view**: `detailSidePanel` namespace (custom side-panel tabs) + shared `headerMenu` namespace (custom header buttons; can hide/override built-ins like Download, Assign tasks).
- **Current asset**: `const { path, id } = await guestConnection.host.details.getCurrentResourceInfo();`
- **Modal / dialog (commons Modal API)**: `guestConnection.host.modal.openDialog({ title, contentUrl, type, size, payload })`
  - `type`: `'modal'` (default) or **`'fullscreen'`** → yes, full-screen is supported (fills the Assets View/shell content area; not OS-level fullscreen — `requestFullscreen()` inside depends on host iframe `allow`, **L**).
  - `size`: `S|M|L` (ignored for fullscreen). `payload`: arbitrary object, read in dialog via `modal.getPayload()` → pass `{path, id}` here. Close via `modal.close()`.
  - Note: older AEM UIs (CF console, Universal Editor) use `modal.showUrl(...)`; Assets View uses `openDialog`.
- **Auth**: `guestConnection.sharedContext` exposes `auth` (`imsToken`, `imsOrg`, `apiKey`), `aemHost`, locale/theme (**M** — key names per uix-guest common pattern; confirm with `sharedContext.get('auth')`). Use token for Assets Author/Open API rendition/original fetches; or proxy via App Builder Runtime action.
- WASM/WebGL fine: you control the app's CSP and hosting.
- Trade-offs: officially supported, stable across UI releases, centrally deployed, zero client install; limited to defined slots (header button → fullscreen dialog, side panel), cannot replace/overlay the native viewer itself; requires App Builder entitlement. **Recommended production fallback (arguably primary).**
- Sources:
  - https://developer.adobe.com/uix/docs/services/aem-assets-view/api/
  - https://developer.adobe.com/uix/docs/services/aem-assets-view/api/details-view/
  - https://developer.adobe.com/uix/docs/services/aem-assets-view/api/commons/#modal-api
  - https://developer.adobe.com/uix/docs/services/aem-assets-view/api/header-menu/
  - https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/assets/assets-view/aem-assets-view-ui-extensibility
  - https://experienceleague.adobe.com/en/docs/experience-manager-learn/cloud-service/developing/extensibility/ui/modal

## Sources (MV3)
- Content scripts / world / match_origin_as_fallback: https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts , https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#isolated_world
- scripting API: https://developer.chrome.com/docs/extensions/reference/api/scripting
- Extension CSP / wasm-unsafe-eval: https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
- web_accessible_resources: https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources
- Trusted Types: https://web.dev/articles/trusted-types
- Navigation API: https://developer.chrome.com/docs/web-platform/navigation-api

## Verify before build (L items)
1. Actual Assets View iframe origin + its CSP/TT headers.
2. Whether the iframe has `allow="fullscreen"`.
3. Whether Assets View fetches assets in a service worker (would evade fetch patching → use `chrome.webRequest` observation or DOM/URL parsing instead).
4. Exact `sharedContext` auth key names in Assets View host.
