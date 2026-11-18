import { DEFAULT_API_KEY } from './config';
import type { AuthSnapshot } from './bridge';

function parseShellValue(raw: string | null): unknown {
  if (!raw) return null;
  const clean = raw.replace(/^[A-Z]\|/, '');
  try {
    return JSON.parse(clean);
  } catch {
    return clean;
  }
}

function resolveRepoHost(): string | null {
  const fromSS = parseShellValue(sessionStorage.getItem('repoId'));
  if (typeof fromSS === 'string' && fromSS.includes('.adobeaemcloud.com')) return fromSS;
  try {
    const params = new URLSearchParams(window.top?.location.search ?? location.search);
    return params.get('repoId') || params.get('repo');
  } catch {
    return null;
  }
}

/**
 * Reads the IMS token and repoId directly from Unified Shell's sessionStorage in the
 * CQ-assets-app frame. Returns null if not yet populated (caller falls back to page-hook).
 */
export function readAuthFromSessionStorage(): AuthSnapshot | null {
  const repoHost = resolveRepoHost();
  if (!repoHost) return null;

  let token: string | null = null;
  const cached = parseShellValue(sessionStorage.getItem('shellCachedTokens'));
  if (cached && typeof cached === 'object') {
    for (const entry of Object.values(cached as Record<string, any>)) {
      if (typeof entry?.token === 'string' && entry.token.startsWith('eyJ')) {
        token = entry.token;
        break;
      }
    }
  }

  if (!token) {
    const imsKey = Object.keys(sessionStorage).find((k) => k.startsWith('adobeid_ims_access_token/'));
    const imsObj = parseShellValue(imsKey ? sessionStorage.getItem(imsKey) : null) as any;
    if (typeof imsObj?.tokenValue === 'string') token = imsObj.tokenValue;
  }

  if (!token) return null;

  return {
    authorization: `Bearer ${token}`,
    apiBase: `https://${repoHost.replace(/^https?:\/\//, '')}`,
    headers: { 'x-api-key': DEFAULT_API_KEY },
  };
}
