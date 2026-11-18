/**
 * In-Browser Streaming Decimator for Massive (1 GB+) .ply and .splat Assets
 *
 * Reads a fetch() ReadableStream chunk-by-chunk with O(maxSplats) memory (~19 MB for 600k splats),
 * stripping 248-byte/vertex 3DGS .ply Spherical Harmonics into 32-byte .splat records and
 * reservoir/stride-sampling + importance-filtering on the fly so a 1 GB asset never OOMs Chrome.
 */

const SH_C0 = 0.28209479177387814;
const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));

export interface StreamDecimateOptions {
  ext: string;
  totalBytes?: number;
  maxSplats?: number;
  minOpacity?: number;
  signal: AbortSignal;
  onProgress?: (loadedBytes: number, totalBytes?: number, keptSplats?: number) => void;
}

const SPLAT_CACHE_DB = 'acv-splat-cache-v1';
const SPLAT_CACHE_STORE = 'decimated';

function openSplatCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SPLAT_CACHE_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SPLAT_CACHE_STORE)) {
        req.result.createObjectStore(SPLAT_CACHE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedDecimatedSplat(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openSplatCacheDb();
    return await new Promise<ArrayBuffer | null>((res) => {
      const tx = db.transaction(SPLAT_CACHE_STORE, 'readonly');
      const r = tx.objectStore(SPLAT_CACHE_STORE).get(key);
      r.onsuccess = () => res(r.result instanceof ArrayBuffer ? r.result : null);
      r.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}

export async function saveCachedDecimatedSplat(key: string, buf: ArrayBuffer): Promise<void> {
  try {
    const db = await openSplatCacheDb();
    await new Promise<void>((res) => {
      const tx = db.transaction(SPLAT_CACHE_STORE, 'readwrite');
      tx.objectStore(SPLAT_CACHE_STORE).put(buf, key);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch {
    /* ignore quota errors */
  }
}

/**
 * Streams a Response body and returns a compact 32-byte/splat ArrayBuffer capped at `maxSplats`.
 */
export async function streamAndDecimateSplatResponse(
  response: Response,
  opts: StreamDecimateOptions,
): Promise<{ buffer: ArrayBuffer; originalSplats: number; keptSplats: number; wasDecimated: boolean }> {
  const maxSplats = opts.maxSplats ?? 600_000; // 600k * 32B = 19.2 MB max RAM/VRAM
  const minOpacity = opts.minOpacity ?? 12;
  const totalBytes = Number(response.headers.get('content-length')) || opts.totalBytes || 0;

  // Fast path for small .splat files that already fit comfortably under maxSplats
  if (opts.ext === 'splat' && totalBytes > 0 && totalBytes <= maxSplats * 32 && response.body) {
    const reader = response.body.getReader();
    const out = new Uint8Array(totalBytes);
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        out.set(value, loaded);
        loaded += value.byteLength;
        opts.onProgress?.(loaded, totalBytes, Math.floor(loaded / 32));
      }
    }
    const splats = Math.floor(loaded / 32);
    return { buffer: out.buffer, originalSplats: splats, keptSplats: splats, wasDecimated: false };
  }

  if (!response.body) {
    const buf = await response.arrayBuffer();
    return { buffer: buf, originalSplats: Math.floor(buf.byteLength / 32), keptSplats: Math.floor(buf.byteLength / 32), wasDecimated: false };
  }

  const reader = response.body.getReader();
  const outBytes = new Uint8Array(maxSplats * 32);
  const outDv = new DataView(outBytes.buffer);
  let kept = 0;
  let loadedBytes = 0;

  if (opts.ext === 'ply') {
    // Stream PLY header first, then parse vertices row-by-row in fixed memory
    let carry = new Uint8Array(0);
    let headerParsed = false;
    let totalVertices = 0;
    let rowBytes = 0;
    let stride = 1;
    let vertexIdx = 0;
    let offX = -1, offY = -1, offZ = -1;
    let offSx = -1, offSy = -1, offSz = -1;
    let offDc0 = -1, offDc1 = -1, offDc2 = -1, offOpac = -1;
    let offR0 = -1, offR1 = -1, offR2 = -1, offR3 = -1;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      loadedBytes += value.byteLength;

      const merged = new Uint8Array(carry.length + value.length);
      merged.set(carry, 0);
      merged.set(value, carry.length);
      let offset = 0;

      if (!headerParsed) {
        const probeLen = Math.min(merged.length, 32768);
        const text = new TextDecoder().decode(merged.subarray(0, probeLen));
        const endLf = text.indexOf('end_header\n');
        const endCrLf = text.indexOf('end_header\r\n');
        const headerEnd = endLf !== -1 ? endLf + 11 : endCrLf !== -1 ? endCrLf + 12 : -1;
        if (headerEnd === -1) {
          carry = merged;
          continue;
        }
        headerParsed = true;
        offset = headerEnd;

        const headerText = text.slice(0, headerEnd);
        const vMatch = headerText.match(/element vertex (\d+)/);
        totalVertices = vMatch ? parseInt(vMatch[1], 10) : Math.floor(totalBytes / 248);
        stride = Math.max(1, Math.floor(totalVertices / (maxSplats * 1.15)));

        const TYPE_SIZES: Record<string, number> = {
          float: 4, float32: 4, uchar: 1, uint8: 1, int: 4, short: 2, ushort: 2, double: 8,
        };
        const props: { name: string; offset: number }[] = [];
        rowBytes = 0;
        for (const line of headerText.split(/\r?\n/)) {
          const m = line.match(/^property\s+(\S+)\s+(\S+)/);
          if (m) {
            props.push({ name: m[2], offset: rowBytes });
            rowBytes += TYPE_SIZES[m[1]] || 4;
          }
        }
        const findOff = (n: string) => props.find((p) => p.name === n)?.offset ?? -1;
        offX = findOff('x'); offY = findOff('y'); offZ = findOff('z');
        offSx = findOff('scale_0'); offSy = findOff('scale_1'); offSz = findOff('scale_2');
        offDc0 = findOff('f_dc_0'); offDc1 = findOff('f_dc_1'); offDc2 = findOff('f_dc_2');
        offOpac = findOff('opacity');
        offR0 = findOff('rot_0'); offR1 = findOff('rot_1'); offR2 = findOff('rot_2'); offR3 = findOff('rot_3');
      }

      const dv = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
      while (offset + rowBytes <= merged.length) {
        if (vertexIdx % stride === 0 && kept < maxSplats) {
          const opacRaw = offOpac >= 0 ? dv.getFloat32(offset + offOpac, true) : 5;
          const alpha = clampByte(sigmoid(opacRaw) * 255);
          if (alpha >= minOpacity) {
            const x = dv.getFloat32(offset + offX, true);
            const y = dv.getFloat32(offset + offY, true);
            const z = dv.getFloat32(offset + offZ, true);
            const sx = offSx >= 0 ? Math.exp(dv.getFloat32(offset + offSx, true)) : 0.01;
            const sy = offSy >= 0 ? Math.exp(dv.getFloat32(offset + offSy, true)) : 0.01;
            const sz = offSz >= 0 ? Math.exp(dv.getFloat32(offset + offSz, true)) : 0.01;

            if (Number.isFinite(x + y + z + sx + sy + sz)) {
              const r = offDc0 >= 0 ? clampByte((0.5 + SH_C0 * dv.getFloat32(offset + offDc0, true)) * 255) : 180;
              const g = offDc1 >= 0 ? clampByte((0.5 + SH_C0 * dv.getFloat32(offset + offDc1, true)) * 255) : 180;
              const b = offDc2 >= 0 ? clampByte((0.5 + SH_C0 * dv.getFloat32(offset + offDc2, true)) * 255) : 180;

              let q0 = offR0 >= 0 ? dv.getFloat32(offset + offR0, true) : 1;
              let q1 = offR1 >= 0 ? dv.getFloat32(offset + offR1, true) : 0;
              let q2 = offR2 >= 0 ? dv.getFloat32(offset + offR2, true) : 0;
              let q3 = offR3 >= 0 ? dv.getFloat32(offset + offR3, true) : 0;
              const qLen = Math.hypot(q0, q1, q2, q3) || 1;
              q0 /= qLen; q1 /= qLen; q2 /= qLen; q3 /= qLen;

              const wOff = kept * 32;
              outDv.setFloat32(wOff + 0, x, true);
              outDv.setFloat32(wOff + 4, y, true);
              outDv.setFloat32(wOff + 8, z, true);
              outDv.setFloat32(wOff + 12, sx, true);
              outDv.setFloat32(wOff + 16, sy, true);
              outDv.setFloat32(wOff + 20, sz, true);
              outBytes[wOff + 24] = r;
              outBytes[wOff + 25] = g;
              outBytes[wOff + 26] = b;
              outBytes[wOff + 27] = alpha;
              outBytes[wOff + 28] = clampByte(q0 * 128 + 128);
              outBytes[wOff + 29] = clampByte(q1 * 128 + 128);
              outBytes[wOff + 30] = clampByte(q2 * 128 + 128);
              outBytes[wOff + 31] = clampByte(q3 * 128 + 128);
              kept++;
            }
          }
        }
        offset += rowBytes;
        vertexIdx++;
      }
      carry = merged.subarray(offset);
      opts.onProgress?.(loadedBytes, totalBytes, kept);
    }

    return {
      buffer: outBytes.buffer.slice(0, kept * 32),
      originalSplats: totalVertices,
      keptSplats: kept,
      wasDecimated: true,
    };
  }

  // Huge .splat file (> maxSplats * 32 bytes): stream 32-byte records with stride + opacity filter
  const estTotalSplats = totalBytes > 0 ? Math.floor(totalBytes / 32) : maxSplats * 2;
  const stride = Math.max(1, Math.floor(estTotalSplats / (maxSplats * 1.1)));
  let carry = new Uint8Array(0);
  let splatIdx = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    loadedBytes += value.byteLength;

    const merged = new Uint8Array(carry.length + value.length);
    merged.set(carry, 0);
    merged.set(value, carry.length);
    let offset = 0;

    while (offset + 32 <= merged.length) {
      if (splatIdx % stride === 0 && kept < maxSplats) {
        const alpha = merged[offset + 27];
        if (alpha >= minOpacity) {
          outBytes.set(merged.subarray(offset, offset + 32), kept * 32);
          kept++;
        }
      }
      offset += 32;
      splatIdx++;
    }
    carry = merged.subarray(offset);
    opts.onProgress?.(loadedBytes, totalBytes, kept);
  }

  return {
    buffer: outBytes.buffer.slice(0, kept * 32),
    originalSplats: splatIdx,
    keptSplats: kept,
    wasDecimated: splatIdx > kept,
  };
}
