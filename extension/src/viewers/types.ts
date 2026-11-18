import type { AssetMeta } from '../assets-api';

export interface ViewerToolbarAction {
  id: string;
  label: string;
  title?: string;
  active?: boolean;
  onClick: () => void;
}

export interface ViewerContext {
  meta: AssetMeta;
  container: HTMLElement;
  signal: AbortSignal;
  /** Streams the full asset binary with live byte progress. */
  fetchBuffer: (onProgress?: (loaded: number, total?: number) => void) => Promise<ArrayBuffer>;
  /** Fetches an inclusive byte range [start, end] via HTTP 206 Range request. */
  fetchRange: (start: number, end: number) => Promise<Uint8Array>;
  /** Updates the status text in the overlay header bar (e.g. splat count, FPS). */
  setStatus: (text: string) => void;
  /** Sets format-specific toolbar buttons in the overlay header bar. */
  setActions: (actions: ViewerToolbarAction[]) => void;
  /** Shows/updates (0..100) or hides (null) the loading progress bar. */
  setProgress: (pct: number | null, label?: string) => void;
}

export interface ViewerPlugin {
  id: string;
  label: string;
  badge: string;
  extensions: readonly string[];
  mimeTypes?: readonly string[];
  match?: (meta: AssetMeta) => boolean;
  mount: (ctx: ViewerContext) => Promise<() => void>;
}
