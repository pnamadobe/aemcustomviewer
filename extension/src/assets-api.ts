import { endpoints, DEFAULT_API_KEY } from './config';
import type { AuthSnapshot } from './bridge';

export type AssetMeta = {
  id: string;
  damPath: string;
  name: string;
  mime: string;
  size?: number;
  primaryHref?: string;
  blockDownloadHref?: string;
  renditionHref?: string;
  hasNativeRendition?: boolean;
};

const buildHeaders = (a: AuthSnapshot, extra: Record<string, string> = {}) => ({
  'x-api-key': DEFAULT_API_KEY,
  ...a.headers,
  authorization: a.authorization,
  ...extra,
});

function parseRepoJson(j: any, fallbackPath = ''): AssetMeta {
  const damPath = j['repo:path'] ?? fallbackPath;
  const renditions = j._links?.['http://ns.adobe.com/adobecloud/rel/rendition'];
  const rendList: any[] = Array.isArray(renditions) ? renditions : [];
  const hasNativeRendition = rendList.some(
    (r: any) =>
      r?.['aem:renditionUsage'] === 'web' ||
      r?.['aem:renditionUsage'] === 'thumbnail' ||
      r?.['aem:isSystemDefault'] === true,
  );
  const webRend =
    rendList.find((r: any) => r?.['aem:renditionUsage'] === 'web' && typeof r?.href === 'string') ??
    rendList.find((r: any) => r?.['aem:renditionUsage'] === 'thumbnail' && typeof r?.href === 'string') ??
    rendList.find((r: any) => typeof r?.type === 'string' && r.type.startsWith('image/') && typeof r?.href === 'string');
  return {
    id: j['repo:id'] ?? '',
    damPath,
    name: j['repo:name'] ?? damPath.split('/').pop() ?? '',
    mime: j['dc:format'] ?? '',
    size: Number(j['repo:size']) || undefined,
    primaryHref: j._links?.['http://ns.adobe.com/adobecloud/rel/primary']?.href,
    blockDownloadHref: j._links?.['http://ns.adobe.com/adobecloud/rel/download']?.href,
    renditionHref: webRend?.href,
    hasNativeRendition,
  };
}

export async function getMetadata(a: AuthSnapshot, damPath: string, signal?: AbortSignal): Promise<AssetMeta> {
  const r = await fetch(endpoints.repositoryItem(a.apiBase, damPath), {
    headers: buildHeaders(a),
    signal,
  });
  if (!r.ok) throw new Error(`repository metadata ${r.status}`);
  return parseRepoJson(await r.json(), damPath);
}

export async function getMetadataById(a: AuthSnapshot, assetId: string, signal?: AbortSignal): Promise<AssetMeta> {
  const r = await fetch(endpoints.repositoryById(a.apiBase, assetId), {
    headers: buildHeaders(a),
    signal,
  });
  if (!r.ok) throw new Error(`repository id metadata ${r.status}`);
  return parseRepoJson(await r.json());
}

export async function getSignedVideoUrl(a: AuthSnapshot, damPath: string, signal?: AbortSignal): Promise<string> {
  const tryUrl = async (suffix: string): Promise<string | null> => {
    const r = await fetch(`${a.apiBase}/adobe/repository${encodeURI(damPath)}${suffix}`, {
      headers: buildHeaders(a),
      signal,
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return typeof j?.href === 'string' ? j.href : null;
  };
  return (
    (await tryUrl(';api=block_download;renditionName=cq5dam.preview.mp4')) ??
    (await tryUrl(';api=block_download')) ??
    `${a.apiBase}${encodeURI(damPath)}`
  );
}

export async function getRenditionBuffer(
  a: AuthSnapshot,
  meta: AssetMeta,
  signal?: AbortSignal,
): Promise<ArrayBuffer | null> {
  const trySigned = async (suffix: string): Promise<ArrayBuffer | null> => {
    const r = await fetch(`${a.apiBase}/adobe/repository${encodeURI(meta.damPath)}${suffix}`, {
      headers: buildHeaders(a),
      signal,
    });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const j = await r.json().catch(() => null);
      if (typeof j?.href === 'string') {
        const binRes = await fetch(j.href, { signal });
        if (binRes.ok) return binRes.arrayBuffer();
      }
      return null;
    }
    return r.arrayBuffer();
  };

  if (meta.renditionHref) {
    try {
      const r = await fetch(meta.renditionHref, { headers: buildHeaders(a), signal });
      if (r.ok) return await r.arrayBuffer();
    } catch {
      /* fallback below */
    }
  }

  return (
    (await trySigned(';api=block_download;renditionName=cq5dam.web.1280.1280.jpeg')) ??
    (await trySigned(';api=block_download;renditionName=cq5dam.thumbnail.319.319.png'))
  );
}

export async function getOriginal(
  a: AuthSnapshot,
  meta: AssetMeta,
  opts: { range?: [number, number]; signal?: AbortSignal } = {},
): Promise<Response> {
  const extra: Record<string, string> = opts.range ? { Range: `bytes=${opts.range[0]}-${opts.range[1]}` } : {};
  const url = meta.primaryHref ?? endpoints.originalBinary(a.apiBase, meta.damPath);
  const r = await fetch(url, {
    headers: buildHeaders(a, extra),
    signal: opts.signal,
    redirect: 'follow',
  });
  if (!r.ok && r.status !== 206) throw new Error(`original ${r.status}`);
  return r;
}

export async function fetchArrayBufferWithProgress(
  a: AuthSnapshot,
  meta: AssetMeta,
  signal: AbortSignal,
  onProgress?: (loaded: number, total?: number) => void,
): Promise<ArrayBuffer> {
  // For compiled .sbsar (7z) Substance archives, prefer AEM's rendered preview rendition
  // so 30–120 MB 7z graphs load in ~50ms and can be mapped onto the 3D PBR swatch meshes.
  if (meta.name.toLowerCase().endsWith('.sbsar')) {
    const rendBuf = await getRenditionBuffer(a, meta, signal);
    if (rendBuf && rendBuf.byteLength > 0) {
      onProgress?.(rendBuf.byteLength, rendBuf.byteLength);
      return rendBuf;
    }
  }
  const r = await getOriginal(a, meta, { signal });
  const total = Number(r.headers.get('content-length')) || meta.size;
  if (!r.body || !onProgress) {
    const buf = await r.arrayBuffer();
    onProgress?.(buf.byteLength, total);
    return buf;
  }
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}
