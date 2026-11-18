# 01 — Assets View: iframe origins, routes, DOM anchors

Research date: 2026-11-18. Confidence: **High** = stated in official docs · **Medium** = can be inferred from official docs · **Low/Unknown** = not documented, so check it in DevTools.

## Summary

| Question | Answer | Confidence |
|---|---|---|
| Shell (top-level) origin | `https://experience.adobe.com` | High |
| Assets View hash root | `#/@<org>/assets/...` (for example `#/@org/assets/workspace/`) | High |
| Repository selection | Query string **before** the hash: `?repo=<aem-host>` or `?repoId=<aem-host>`. Author hosts look like `author-pXXXX-eYYYY(-cm).adobeaemcloud.com`. | High (both spellings appear in Adobe docs) |
| Origin of the inner app iframe | **Not publicly documented** | Unknown, check in DevTools |
| Asset details route | **Not publicly documented** | Unknown, check in DevTools |
| Asset ID format | `urn:aaid:aem:<uuid>` | High (API spec). Whether it appears in the UI URL is unknown. |
| Stable DOM anchors for the preview | **None documented.** Adobe's only supported customisation path is UI Extensibility. | Unknown, check in DevTools |

## 1. Shell and iframe origins

- Users open Assets View at `https://experience.adobe.com/#/assets`. Source: https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/assets/assets-view/get-started-assets-view (High)
- Content Hub, a sibling app, uses `https://experience.adobe.com/#/assets/contenthub`. Source: https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/assets/content-hub/product-overview (High)
- Example URLs from the official UIX docs (repo `AdobeDocs/uix`, `src/pages/services/aem-assets-view/debug/index.md` and `extension-development/index.md`):
  - `https://experience.adobe.com/?devMode=true&ext=https://localhost:9080&repoId=author-p12345-e123456-cm.adobeaemcloud.com#/@org/assets/workspace/`
  - `https://experience.adobe.com/?devMode=true&ext=https://localhost:9080&#/assets/workspace/`
  - `https://experience.adobe.com/?repo=<CUSTOMER_AEM_HOST>...` (Content Hub examples use `repo=delivery-p…-e….adobeaemcloud.com#/assets/contenthub/`)
  - Source pages: https://developer.adobe.com/uix/docs/services/aem-assets-view/ (debug and extension-development pages)
- **Takeaways:**
  - The `ext=` and `devMode=true` query parameters load UIX extensions into the shell. Extensions are hosted in iframes on `*.adobeio-static.net` (App Builder) or on `localhost` during development. (High)
  - App Builder SPAs in Unified Shell often run in a nested iframe, for example under `experience.adobe.com/solutions/<app-id>/...`. I could not confirm the exact origin or path for Assets View. **Unknown**, so check it in DevTools before you hard-code anything.

### DevTools steps: find the Assets View iframe origin

1. Open `https://experience.adobe.com/#/@<org>/assets/` and sign in. Then open DevTools (Cmd+Opt+I).
2. Go to the **Elements** tab and press Cmd+F. Search for `<iframe`. For each match, record `src`, `name`, `id`, `title` and any `data-*` attributes.
3. In the **Console** tab, open the context dropdown at the top-left (it shows "top" by default). It lists every frame with its origin. Pick the frame that contains the asset grid.
4. In that frame, run `location.origin`, `location.pathname` and `location.hash`. Record each value.
5. Go to the **Network** tab, filter by **Doc**, and reload. Every iframe document request appears here with its full URL.
6. In the **Application** tab, open **Frames** and expand `top`. It shows the frame tree with the security origin of each frame.
7. Also check whether the app runs inside the top document, with no iframe. If step 3 lists no Assets frame and the grid DOM is visible from `top`, the app is mounted directly.

## 2. Asset details route

- Docs describe the UI flow only: select an asset, then click **Details** in the toolbar. They do not give a URL pattern. Source: https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/assets/assets-view/navigate-assets-view (High for the flow, Unknown for the URL)
- The UIX docs say the host supports "deep linking panel in the URL" for custom Details View side panels. So panel state is encoded in the URL, but the docs do not show the format. Source: https://developer.adobe.com/uix/docs/services/aem-assets-view/api/details-view/ (High that it exists, Unknown format)
- The UIX Details View host API exposes `details.getCurrentResourceInfo()`, which returns `{ path, id }` for the current asset. Inside an extension, this is the supported way to get the asset ID and path without parsing the URL. (High, same source)
- Asset ID format: `urn:aaid:aem:<uuid>`, for example `urn:aaid:aem:1a034bee-ebda-4787-bad3-f924d0772b75`. Source: https://developer.adobe.com/experience-cloud/experience-manager-apis/api/stable/assets/author (High)
- **Unknowns:**
  - Whether the details route contains the URN, the DAM path (`/content/dam/...`), or both.
  - Whether the value is URL-encoded, for example `urn%3Aaaid%3Aaem%3A...`.
  - Whether it is a path segment or a query parameter inside the hash.

### DevTools steps: capture the details route

1. Browse to a folder, select an image, and click **Details**.
2. Copy the top-level URL from the address bar. Then run `location.href` in the Assets frame context (see step 3 in the previous section). Compare the two values.
3. In the Console, run:

   ```js
   decodeURIComponent(location.href).match(/urn:aaid:aem:[0-9a-f-]{36}/i)
   ```

   Also search the decoded URL for `/content/dam`.
4. Open another asset, open a side panel such as Renditions, and close Details. After each step, record how the hash changes. This shows the route segments and the panel deep-link parameter.
5. Paste the copied URL into a new tab and confirm that it reopens the same asset. This shows whether the URL is a stable deep link.
6. To watch route changes as they happen, run this in the Assets frame:

   ```js
   addEventListener('hashchange', () => console.log(location.hash));
   addEventListener('popstate', () => console.log(location.href));
   ```

## 3. Stable DOM anchors for the main preview

- I found no public documentation of `data-testid` attributes or other DOM contracts for Assets View. The UI is built with React Spectrum: the UIX docs refer to React Spectrum workflow icons and a `Provider` with `defaultTheme`.
- Adobe's supported way to customise Assets View is UI Extensibility (`aem/assets/assetsview/1`, with the `actionBar`, `quickActions`, `detailSidePanel` and `headerMenu` namespaces). It is available on Assets Ultimate only and must be enabled through a support case. Source: https://developer.adobe.com/uix/docs/services/aem-assets-view/api/ (High)
- There is no extension point that replaces the main preview area. Custom content can only go in a side panel (`contentUrl`) or be reached from header or action-bar actions. (High, based on the documented namespaces)
- **Risk:** React Spectrum class names are hashed and generated at build time, for example `spectrum-*_xxxx`. Do not rely on them.

### DevTools steps: find preview anchors

1. On the Details page, right-click the preview image and choose **Inspect**. Make sure DevTools has switched to the Assets frame.
2. Walk up from the `<img>`, `<video>` or `<canvas>` element. On each ancestor, record any `data-testid`, `data-test-id`, `data-qa`, `id`, `role` (such as `main`, `region`, `img` or `dialog`) and `aria-label` attributes.
3. In the Console, list the test IDs on the page:

   ```js
   [...new Set([...document.querySelectorAll('[data-testid]')].map(e => e.dataset.testid))]
   ```

   Repeat this with `[role]` and `[aria-label]`.
4. Reload the page and repeat step 3 after a hard refresh, then again on another day or release. Only attributes that stay the same are reasonably stable.
5. Check whether the preview is inside a shadow root (`#shadow-root`) or a further nested iframe, such as a PDF or video viewer.
6. Optionally install the React DevTools extension and select the preview element. Component names (for example `AssetPreview`) can help, but production builds are often minified.

## Sources

- https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/assets/assets-view/get-started-assets-view
- https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/assets/assets-view/navigate-assets-view
- https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/assets/content-hub/product-overview
- https://developer.adobe.com/uix/docs/services/aem-assets-view/
- https://developer.adobe.com/uix/docs/services/aem-assets-view/api/
- https://developer.adobe.com/uix/docs/services/aem-assets-view/api/details-view/
- https://github.com/AdobeDocs/uix (`src/pages/services/aem-assets-view/debug/index.md`, `extension-development/index.md`)
- https://developer.adobe.com/experience-cloud/experience-manager-apis/api/stable/assets/author
