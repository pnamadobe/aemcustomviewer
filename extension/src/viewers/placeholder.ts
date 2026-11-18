import type { ViewerPlugin } from './types';

/** Minimal reference template for authoring a new viewer plugin. */
export const placeholderViewer: ViewerPlugin = {
  id: 'placeholder',
  label: 'Reference Placeholder Viewer',
  badge: 'CUSTOM',
  extensions: ['xyz'],
  mimeTypes: ['application/x-proprietary'],
  async mount(ctx) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:grid;place-items:center;height:100%;text-align:center;padding:24px';
    wrap.textContent = `Custom Viewer — ${ctx.meta.name} (${ctx.meta.mime || 'unknown'})`;
    ctx.container.appendChild(wrap);
    return () => wrap.remove();
  },
};
