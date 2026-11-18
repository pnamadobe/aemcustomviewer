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
};

const buildHeaders = (a: AuthSnapshot, extra: Record<string, string> = {}) => ({
  'x-api-key': DEFAULT_API_KEY,
  ...a.headers,
  authorization: a.authorization,
  ...extra,
});

export async function getMetadata(a: AuthSnapshot, damPath: string, signal?: AbortSignal): Promise<AssetMeta> {
  const r = await fetch(endpoints.repositoryItem(a.apiBase, damPath), {
    headers: buildHeaders(a),
    signal,
  });
  if (!r.ok) throw new Error(`repository metadata ${r.status}`);
  const j = await r.json();
  return {
    id: j['repo:id'] ?? '',
    damPath: j['repo:path'] ?? damPath,
    name: j['repo:name'] ?? damPath.split('/').pop() ?? '',
    mime: j['dc:format'] ?? '',
    size: Number(j['repo:size']) || undefined,
    primaryHref: j._links?.['http://ns.adobe.com/adobecloud/rel/primary']?.href,
    blockDownloadHref: j._links?.['http://ns.adobe.com/adobecloud/rel/download']?.href,
  };
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
