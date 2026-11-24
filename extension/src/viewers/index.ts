import type { AssetMeta } from '../assets-api';
import { getSettings } from '../settings';
import type { ViewerPlugin } from './types';
import { gsplatViewer } from './gsplat';
import { model3dViewer } from './model3d';
import { texture3dViewer } from './texture3d';
import { fontViewer } from './font';
import { rawImageViewer } from './raw';
import { audioSpectrumViewer } from './audio';

export type { ViewerPlugin, ViewerContext, ViewerToolbarAction } from './types';

/**
 * Central Viewer Platform Registry.
 * Each plugin handles both the interactive Details Viewer and headless Card View thumbnails.
 */
export const VIEWER_PLUGINS: readonly ViewerPlugin[] = [
  gsplatViewer,
  model3dViewer,
  texture3dViewer,
  fontViewer,
  rawImageViewer,
  audioSpectrumViewer,
];

const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

function isPluginEnabled(pluginId: string): boolean {
  const s = getSettings();
  if (!s.enabled) return false;
  switch (pluginId) {
    case 'gsplat':
      return s.formats.gsplat;
    case 'model3d':
      return s.formats.model3d;
    case 'texture3d':
      return s.formats.texture3d;
    case 'font':
      return s.formats.font;
    case 'raw-image':
      return s.formats.raw || s.formats.rawAcrFallback;
    case 'audio-spectrum':
      return s.formats.audio;
    default:
      return true;
  }
}

export function pickViewer(meta: AssetMeta): ViewerPlugin | null {
  const ext = extOf(meta.name || meta.damPath);
  for (const plugin of VIEWER_PLUGINS) {
    if (!isPluginEnabled(plugin.id)) continue;
    if (plugin.match) {
      if (plugin.match(meta)) return plugin;
      continue;
    }
    if (ext && plugin.extensions.includes(ext)) return plugin;
    if (meta.mime && plugin.mimeTypes?.includes(meta.mime)) return plugin;
  }
  return null;
}
