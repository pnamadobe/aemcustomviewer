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
  /** Returns the raw streaming Response for chunk-by-chunk processing of 1GB+ files. */
  fetchResponse: () => Promise<Response>;
  /** Fetches an inclusive byte range [start, end] via HTTP 206 Range request. */
  fetchRange: (start: number, end: number) => Promise<Uint8Array>;
  /** Updates the status text in the overlay header bar (e.g. splat count, FPS). */
  setStatus: (text: string) => void;
  /** Sets format-specific toolbar buttons in the overlay header bar. */
  setActions: (actions: ViewerToolbarAction[]) => void;
  /** Shows/updates (0..100) or hides (null) the loading progress bar. */
  setProgress: (pct: number | null, label?: string) => void;
  /** Persists a rendered thumbnail data URL for Card View. */
  saveCardThumbnail: (dataUrl: string) => Promise<void>;
}

export interface ViewerPlugin {
  id: string;
  label: string;
  badge: string;
  extensions: readonly string[];
  mimeTypes?: readonly string[];
  match?: (meta: AssetMeta) => boolean;
  mount: (ctx: ViewerContext) => Promise<() => void>;
  /** Optional headless generator that produces a Card View thumbnail data URL from the binary. */
  renderThumbnail?: (meta: AssetMeta, fetchBuffer: () => Promise<ArrayBuffer>) => Promise<string | null>;
}
