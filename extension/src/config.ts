// Verified against live Assets View (CQ-assets-app) in Unified Shell (see docs/discovery.md).

/** Match the Assets View inner iframe: https://experience.adobe.com/thunderbird/solutions/CQ-assets-app */
export const ASSETS_VIEW_FRAME = (loc: Location) =>
  loc.origin === 'https://experience.adobe.com' && loc.pathname.includes('CQ-assets-app');

/** Extract the DAM path (/content/dam/...) from the iframe hash or top-level hash. */
export const DAM_PATH_PATTERNS: RegExp[] = [
  /#\/detail(\/content\/dam\/[^?#]+)/i,
  /#\/@[^/]+\/assets\/detail(\/content\/dam\/[^?#]+)/i,
];

/** Requests whose Authorization header page-hook.ts captures as a fallback. */
export const API_ORIGIN_PATTERN = /^https:\/\/(author|delivery)-p\d+-e\d+(-cm)?\.adobeaemcloud\.com\//;

/** Default x-api-key used by Assets View (window.ddamEndpoint.apiKey). */
export const DEFAULT_API_KEY = 'aem-assets-frontend-1';

/** Content Repository API endpoints used by Assets View. */
export const endpoints = {
  repositoryItem: (base: string, damPath: string) =>
    `${base}/adobe/repository?path=${encodeURIComponent(damPath)}`,
  assetMetadata: (base: string, damPath: string) =>
    `${base}/adobe/repository${ encodeURI(damPath) };resource=assetmetadata`,
  originalBinary: (base: string, damPath: string) =>
    `${base}${encodeURI(damPath)}`,
  blockDownload: (base: string, damPath: string) =>
    `${base}/adobe/repository${encodeURI(damPath)};api=block_download`,
};

/**
 * Proprietary formats handled by this extension (lowercase extensions, without leading dot).
 * Includes 'mp3' for immediate live testing on /content/dam/26H2/customviewer/music box.mp3;
 * add your proprietary extensions here.
 */
export const SUPPORTED_EXTENSIONS = new Set<string>(['xyz', 'mp3']);
export const SUPPORTED_MIME = new Set<string>(['application/x-proprietary', 'audio/mpeg']);

export const DEBUG = true;
