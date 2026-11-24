export interface ExtensionSettings {
  enabled: boolean;
  detailsViewer: boolean;
  cardThumbnails: boolean;
  videoHoverScrub: boolean;
  formats: {
    gsplat: boolean;
    model3d: boolean;
    texture3d: boolean;
    font: boolean;
    raw: boolean;
    rawAcrFallback: boolean;
    audio: boolean;
  };
  cacheClearedAt?: number;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  detailsViewer: true,
  cardThumbnails: true,
  videoHoverScrub: true,
  formats: {
    gsplat: true,
    model3d: true,
    texture3d: true,
    font: true,
    raw: true,
    rawAcrFallback: false, // Default OFF so AEM's native ACR (.cr2/.cr3/.nef/.arw/.dng) stays untouched
    audio: true,
  },
};

const STORAGE_KEY = 'acv_settings_v1';

let currentSettings: ExtensionSettings = {
  ...DEFAULT_SETTINGS,
  formats: { ...DEFAULT_SETTINGS.formats },
};

const listeners = new Set<(s: ExtensionSettings) => void>();

function mergeSettings(raw: Partial<ExtensionSettings> | undefined): ExtensionSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    formats: {
      ...DEFAULT_SETTINGS.formats,
      ...(raw?.formats ?? {}),
    },
  };
}

export function getSettings(): ExtensionSettings {
  return currentSettings;
}

export async function loadSettings(): Promise<ExtensionSettings> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get(STORAGE_KEY);
      currentSettings = mergeSettings(res[STORAGE_KEY]);
    }
  } catch {
    /* fallback to defaults */
  }
  return currentSettings;
}

export async function saveSettings(next: ExtensionSettings): Promise<void> {
  currentSettings = mergeSettings(next);
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEY]: currentSettings });
    }
  } catch {
    /* ignore */
  }
  listeners.forEach((cb) => cb(currentSettings));
}

export function subscribeSettings(cb: (s: ExtensionSettings, prev: ExtensionSettings) => void): () => void {
  const handler = (s: ExtensionSettings) => cb(s, currentSettings);
  listeners.add(handler);
  return () => listeners.delete(handler);
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      const prev = currentSettings;
      currentSettings = mergeSettings(changes[STORAGE_KEY].newValue);
      listeners.forEach((cb) => (cb as any)(currentSettings, prev));
    }
  });
}
