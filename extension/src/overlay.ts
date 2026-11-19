import { selectors, query } from './selectors';
import type { ViewerToolbarAction } from './viewers/types';
import css from '../ui/overlay.css';

export type Overlay = {
  body: HTMLElement;
  setMeta: (badge: string, title: string) => void;
  setStatus: (text: string) => void;
  setActions: (actions: ViewerToolbarAction[]) => void;
  setProgress: (pct: number | null, label?: string) => void;
  dispose: () => void;
};

export function waitForPreview(signal: AbortSignal, timeoutMs = 15000): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const found = query(selectors.previewContainer);
    if (found) return resolve(found);
    const mo = new MutationObserver(() => {
      const el = query(selectors.previewContainer);
      if (el) {
        done();
        resolve(el);
      }
    });
    const t = setTimeout(() => {
      done();
      reject(new Error('preview container not found'));
    }, timeoutMs);
    const done = () => {
      mo.disconnect();
      clearTimeout(t);
    };
    signal.addEventListener('abort', () => {
      done();
      reject(signal.reason);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  });
}

export function mountOverlay(target: HTMLElement): Overlay {
  document.querySelectorAll('[data-acv-overlay]').forEach((el) => el.remove());

  const computedPos = getComputedStyle(target).position;
  if (computedPos === 'static') {
    target.style.position = 'relative';
  }

  const host = document.createElement('div');
  host.setAttribute('data-acv-overlay', '');
  host.style.cssText = 'position:absolute;inset:0;z-index:2;display:block;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${css}</style>
    <div class="frame">
      <div class="bar">
        <div class="bar-left">
          <span class="badge">VIEWER</span>
          <span class="title"></span>
          <span class="status"></span>
        </div>
        <div class="bar-right">
          <div class="bar-actions"></div>
          <button class="toggle" title="Toggle between custom viewer and Adobe default preview">Show Adobe preview</button>
        </div>
      </div>
      <div class="body">
        <div class="progress-wrap hidden">
          <div class="progress-track"><div class="progress-fill"></div></div>
          <div class="progress-label">Loading…</div>
        </div>
      </div>
    </div>`;
  target.appendChild(host);

  let hidden = false;
  const frame = root.querySelector<HTMLElement>('.frame')!;
  const badgeEl = root.querySelector<HTMLElement>('.badge')!;
  const titleEl = root.querySelector<HTMLElement>('.title')!;
  const statusEl = root.querySelector<HTMLElement>('.status')!;
  const actionsEl = root.querySelector<HTMLElement>('.bar-actions')!;
  const toggleBtn = root.querySelector<HTMLButtonElement>('.toggle')!;
  const progressWrap = root.querySelector<HTMLElement>('.progress-wrap')!;
  const progressFill = root.querySelector<HTMLElement>('.progress-fill')!;
  const progressLabel = root.querySelector<HTMLElement>('.progress-label')!;

  toggleBtn.onclick = () => {
    hidden = !hidden;
    frame.classList.toggle('passthrough', hidden);
    toggleBtn.textContent = hidden ? 'Show custom viewer' : 'Show Adobe preview';
  };

  return {
    body: root.querySelector<HTMLElement>('.body')!,
    setMeta: (badge, title) => {
      badgeEl.textContent = badge;
      titleEl.textContent = title;
      titleEl.title = title;
    },
    setStatus: (text) => {
      statusEl.textContent = text;
    },
    setActions: (actions) => {
      actionsEl.replaceChildren();
      for (const a of actions) {
        const b = document.createElement('button');
        b.textContent = a.label;
        if (a.title) b.title = a.title;
        if (a.active) b.classList.add('active');
        b.onclick = a.onClick;
        actionsEl.appendChild(b);
      }
    },
    setProgress: (pct, label) => {
      if (pct === null) {
        progressWrap.classList.add('hidden');
        return;
      }
      progressWrap.classList.remove('hidden');
      progressFill.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
      if (label) progressLabel.textContent = label;
    },
    dispose: () => {
      host.remove();
    },
  };
}
