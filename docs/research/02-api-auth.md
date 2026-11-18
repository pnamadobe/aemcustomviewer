# 02 – AEM Assets APIs & Auth (for fetching metadata + original binaries by asset ID)

Confidence: **H** = from official OpenAPI spec / docs, **M** = docs + common knowledge, **L** = inference, needs DevTools check.

## Sources
- Assets Author API (stable, v2026.10): https://developer.adobe.com/experience-cloud/experience-manager-apis/api/stable/assets/author/ (spec: `https://api.redocly.com/registry/bundle/adobe-developers/AEM-assets-author/stable/openapi.yaml?branch=prod`)
- Assets Author API "metaall" experimental: https://developer.adobe.com/experience-cloud/experience-manager-apis/api/experimental/assets/author/ (server `https://{bucket}.adobeaemcloud.com/adobe/experimental/metaall-expires-20991231/assets`)
- Delivery API (stable): https://developer.adobe.com/experience-cloud/experience-manager-apis/api/stable/assets/delivery/ (spec: `.../AEM-assets-delivery/stable/openapi.yaml?branch=prod`)
- Experience League – Delivery APIs: https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/assets/dynamicmedia/dynamic-media-open-apis/deliver-assets-apis
- Experience League – Bearer/IMS auth to AEM Author (Asset Link): https://experienceleague.adobe.com/en/docs/experience-manager-learn/assets/integrations/adobe-asset-link/authentication

## 1. Assets Author API — base `https://author-pXXXX-eYYYY.adobeaemcloud.com/adobe/assets` (H)
| Purpose | Method + path | Notes |
|---|---|---|
| Asset info | `GET /{assetId}` | `assetId` = `urn:aaid:aem:<uuid>` (URL-encode not required in practice; verify) |
| Metadata | `GET`/`HEAD /{assetId}/metadata` | `PATCH` for edits requires `If-Match: <ETag>` (H) |
| Original binary | `GET /{assetId}/original/as/{seoName}` | 200 `application/octet-stream`, `Content-Disposition`, `ETag`; 304 via `If-None-Match`. Alias for rendition `original`. |
| Rendition list | `GET /{assetId}/renditions` | |
| Rendition binary | `GET /{assetId}/renditions/{renditionName}/as/{seoName}` | optional `attachment` param |
| Relations, search, import, jobs | `/{assetId}/relations`, `POST /search`, `/import/fromUrl`, `/jobs/...` | |

Security schemes: `Authorization: Bearer <IMS JWT>` + `X-Api-Key` (H). Spec does **not** declare `Range`/206 for binary GETs (the only Range mention is a requirement on *source* URLs for `/import/fromUrl`) → Range support is **L**.
`X-Adobe-Accept-Experimental: 1` is needed only for experimental paths (H, delivery spec declares it; metaall spec is experimental).

## 2. Delivery API — same host pattern, `/adobe/assets` on **delivery-pXXXX-eYYYY.adobeaemcloud.com** (H)
- `GET /{assetId}/original/as/{seoName}` — security `{}` or Bearer (public for approved+published assets; Bearer for restricted).
- Also `/{assetId}/as/{seoName}.{format}` (DM transforms), `/renditions`, `/metadata`, `/play`, `/manifest.{format}`, `/deliver/{assetId}/{seoName}`, `/token`, `/search`.
- Only works for assets Approved and activated for delivery; not suitable as a general author-side original fetch (M).
- `X-Adobe-Subject-Token` header exists for restricted delivery (H).

## 3. Headers used by Assets View (L — verify)
- `Authorization: Bearer <token>` (H).
- `x-api-key`: Assets View's client ID. Commonly observed value `aem-assets-frontend-1` (L). Other IMS client IDs seen in Unified Shell apps differ per app; **read it from a real request**.
- `x-adobe-accept-experimental: 1` on experimental endpoints (M).
- `If-Match` only for writes (H). `If-None-Match` for caching (H).
- Original GET may respond with **302 redirect to a signed blob URL** (Azure/S3 binary-less download) (M — typical AEMaaCS direct binary access). The redirect target typically supports Range and has its own CORS (L).

## 4. CORS (L)
Assets View runs at `experience.adobe.com` (Unified Shell) and calls `author-*.adobeaemcloud.com/adobe/assets` cross-origin, so the author tier must return `Access-Control-Allow-Origin: https://experience.adobe.com` and allow `Authorization, x-api-key, x-adobe-accept-experimental` in preflight. A browser extension with `host_permissions` for `*.adobeaemcloud.com` bypasses CORS from its service worker anyway. Signed blob redirects: `fetch` follows them; Authorization is stripped cross-origin (fine, URL is pre-signed).

## 5. IMS token (M)
- JWT-format access token (`eyJ...`), claims include `created_at`, `expires_in` (ms, typically 86400000 = 24h), `client_id`, `user_id`, `scope`. Decode payload to get expiry.
- In Unified Shell, the shell owns IMS; child app iframes get the token via the shell runtime (`@adobe/exc-app` → `runtime.on('ready', ({imsToken, imsOrg}))`, and `user.get('imsToken')`), refreshed by shell before expiry and re-pushed via `configuration`/`ready` events.
- `window.adobeIMS.getAccessToken()` exists on pages loading imslib (top-level `experience.adobe.com`); returns `{token, expire, sid}` (M). In the app iframe it may not exist (L).

### Cleaner than fetch interception?
Ranked options for an extension:
1. **Main-world content script in the top frame** calling `window.adobeIMS?.getAccessToken()?.token` → postMessage to extension. Simple, refresh-aware (call each time). (M)
2. In the Assets View iframe (all_frames, `world: "MAIN"`): use `@adobe/exc-app` runtime object if exposed globally (unlikely; it's bundled) (L).
3. `chrome.webRequest.onSendHeaders` with `extraHeaders` observing `Authorization` + `x-api-key` on `*.adobeaemcloud.com/adobe/*` — passive, no page patching, gets the exact x-api-key too (H for mechanism in MV3; read-only allowed). Recommended fallback; robust and also captures the api-key.
4. Monkey-patching `fetch`/XHR — works but brittle.
Never persist the token; keep in memory/session storage and re-read on 401.

## 6. DevTools verification steps
1. Open Assets View, DevTools → Network, filter `adobe/assets`. Open an asset. Check request headers: `authorization`, `x-api-key` (record value), `x-adobe-accept-experimental`, and the host (author vs delivery).
2. Right-click a `/adobe/assets/urn:aaid:aem:...` request → Copy as fetch; replay in Console from `experience.adobe.com` to confirm CORS.
3. Original/Range: in Console run
   `fetch(`${host}/adobe/assets/${id}/original/as/x.bin`,{headers:{Authorization:'Bearer '+tok,'x-api-key':key,Range:'bytes=0-1023'}}).then(r=>console.log(r.status,r.url,r.redirected,[...r.headers]))`
   Expect 206 (Range honored), or 200 (ignored), and check `r.redirected`/`r.url` for blob redirect. Repeat with `redirect:'manual'` to see 302 `Location`.
4. Preflight: look for OPTIONS request; note `access-control-allow-origin/headers/expose-headers` (is `Content-Range`/`Content-Disposition` exposed?).
5. Token: Console (top frame) `adobeIMS.getAccessToken()`; decode `JSON.parse(atob(t.split('.')[1]))` → check `expires_in`, `created_at`, `client_id`. Switch Console context to the Assets View iframe and test whether `adobeIMS` exists there.
6. Leave tab >24h or watch for token change in requests to confirm silent refresh.
