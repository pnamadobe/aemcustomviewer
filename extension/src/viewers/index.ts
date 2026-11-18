import type { AssetMeta } from '../assets-api';
import type { ViewerPlugin } from './types';
import { gsplatViewer } from './gsplat';
import { model3dViewer } from './model3d';
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
  fontViewer,
  rawImageViewer,
  audioSpectrumViewer,
];

const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

export function pickViewer(meta: AssetMeta): ViewerPlugin | null {
  const ext = extOf(meta.name || meta.damPath);
  for (const plugin of VIEWER_PLUGINS) {
    if (plugin.match?.(meta)) return plugin;
    if (ext && plugin.extensions.includes(ext)) return plugin;
    if (meta.mime && plugin.mimeTypes?.includes(meta.mime)) return plugin;
  }
  return null;
}
