import type { AssetMeta } from '../assets-api';
import type { ViewerPlugin } from './types';
import { gsplatViewer } from './gsplat';
import { audioSpectrumViewer } from './audio';

export type { ViewerPlugin, ViewerContext, ViewerToolbarAction } from './types';

/**
 * Central Viewer Platform Registry.
 * Add new proprietary format plugins here (e.g. CAD/STEP, USDZ, VDB, Parquet, DICOM).
 */
export const VIEWER_PLUGINS: readonly ViewerPlugin[] = [
  gsplatViewer,
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
