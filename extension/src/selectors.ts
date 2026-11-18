// Verified DOM anchors inside the CQ-assets-app iframe (see docs/discovery.md).
// Ordered fallbacks; first match wins.
export const selectors = {
  previewContainer: [
    '[class*="Detail__previewContainer__"]',
    'div.previewContainer',
    '[class*="Preview__imageContainer__"]',
  ],
  detailsRoot: [
    '[class*="Detail__AssetDetails__"]',
    '[class*="App__MainViewContent__"]',
  ],
} as const;

export function query(list: readonly string[], root: ParentNode = document): HTMLElement | null {
  for (const s of list) {
    const el = root.querySelector<HTMLElement>(s);
    if (el) return el;
  }
  return null;
}
