import { loadSettings, saveSettings, type ExtensionSettings } from './settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function init() {
  let s = await loadSettings();

  const master = $<HTMLInputElement>('enabled');
  const sub = $<HTMLElement>('sub-controls');
  const details = $<HTMLInputElement>('detailsViewer');
  const cards = $<HTMLInputElement>('cardThumbnails');
  const scrub = $<HTMLInputElement>('videoHoverScrub');

  const fmtKeys: (keyof ExtensionSettings['formats'])[] = [
    'gsplat',
    'model3d',
    'texture3d',
    'font',
    'raw',
    'rawAcrFallback',
    'audio',
  ];

  const syncUi = () => {
    master.checked = s.enabled;
    sub.classList.toggle('disabled-group', !s.enabled);
    details.checked = s.detailsViewer;
    cards.checked = s.cardThumbnails;
    scrub.checked = s.videoHoverScrub;
    for (const k of fmtKeys) {
      $<HTMLInputElement>(`fmt-${k}`).checked = s.formats[k];
    }
  };

  const commit = async () => {
    s = {
      ...s,
      enabled: master.checked,
      detailsViewer: details.checked,
      cardThumbnails: cards.checked,
      videoHoverScrub: scrub.checked,
      formats: {
        gsplat: $<HTMLInputElement>('fmt-gsplat').checked,
        model3d: $<HTMLInputElement>('fmt-model3d').checked,
        texture3d: $<HTMLInputElement>('fmt-texture3d').checked,
        font: $<HTMLInputElement>('fmt-font').checked,
        raw: $<HTMLInputElement>('fmt-raw').checked,
        rawAcrFallback: $<HTMLInputElement>('fmt-rawAcrFallback').checked,
        audio: $<HTMLInputElement>('fmt-audio').checked,
      },
    };
    syncUi();
    await saveSettings(s);
  };

  for (const el of [master, details, cards, scrub, ...fmtKeys.map((k) => $(`fmt-${k}`))]) {
    el.addEventListener('change', commit);
  }

  const clearBtn = $<HTMLButtonElement>('clear-cache');
  clearBtn.addEventListener('click', async () => {
    s = { ...s, cacheClearedAt: Date.now() };
    await saveSettings(s);
    clearBtn.textContent = '✓ Cache Cleared';
    setTimeout(() => {
      clearBtn.textContent = '🗑 Clear Cached Thumbnails';
    }, 1500);
  });

  syncUi();
}

init();
