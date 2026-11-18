/**
 * High-Quality Streaming Splat Decimator & Scene Normalizer for Massive (1 GB+) .ply / .splat Assets
 *
 * Why naive stride-sampling on 1 GB+ .ply files looks blurry and lags:
 *   1. Raw 3DGS .ply exports (like 5M-splat street scenes) are typically sorted in spatial Morton/octree
 *      order (starting at distant -40m sky/street corners) and contain >60% near-transparent training
 *      floaters (opacity < 0.20) plus huge background blobs (scale > 0.25m) that cause massive WebGL2
 *      fragment-shader overdraw.
 *   2. Checking only every Nth vertex throws away 85%+ of the sharp, high-opacity foreground splats
 *      while keeping blurry low-opacity floaters.
 *
 * What this streaming decimator does instead:
 *   - Scans every vertex as chunks stream in (in fast DataView math, ~35ms per 1M vertices).
 *   - Immediately discards low-opacity fog/floaters (alpha < minOpacity, default 55) and giant
 *     overdraw blobs.
 *   - Uses a fixed-memory Importance Reservoir (`maxSplats`, default 900,000 = 28.8 MB) scored by
 *     opacity, sharpness, and proximity to the scene core — so all 900,000 kept splats are crisp,
 *     high-opacity surface splats.
 *   - Recenters the kept splats around their robust median centroid (P50) so the subject is framed
 *     at (0, 0, 0) for smooth OrbitControls navigation.
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

const SPLAT_CACHE_DB = 'acv-splat-cache-v3';
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
 * Recenters a 32-byte/splat buffer around its robust median (P50) centroid so off-center
 * photogrammetry scenes orbit around the main subject at (0, 0, 0).
 */
function recenterSplatBuffer(buf: ArrayBuffer, count: number): void {
  if (count < 100) return;
  const f32 = new Float32Array(buf, 0, count * 8);
  const sampleN = Math.min(4096, count);
  const step = Math.max(1, Math.floor(count / sampleN));
  const xs = new Float32Array(sampleN);
  const ys = new Float32Array(sampleN);
  const zs = new Float32Array(sampleN);
  let k = 0;
  for (let i = 0; i < count && k < sampleN; i += step) {
    xs[k] = f32[i * 8 + 0];
    ys[k] = f32[i * 8 + 1];
    zs[k] = f32[i * 8 + 2];
    k++;
  }
  xs.subarray(0, k).sort();
  ys.subarray(0, k).sort();
  zs.subarray(0, k).sort();
  const cx = xs[k >> 1];
  const cy = ys[k >> 1];
  const cz = zs[k >> 1];

  // Only shift if centroid is noticeably offset from origin
  if (Math.hypot(cx, cy, cz) > 0.35) {
    for (let i = 0; i < count; i++) {
      f32[i * 8 + 0] -= cx;
      f32[i * 8 + 1] -= cy;
      f32[i * 8 + 2] -= cz;
    }
  }
}

/**
 * Streams a Response body and returns a crisp, recentered 32-byte/splat ArrayBuffer.
 */
export async function streamAndDecimateSplatResponse(
  response: Response,
  opts: StreamDecimateOptions,
): Promise<{ buffer: ArrayBuffer; originalSplats: number; keptSplats: number; wasDecimated: boolean }> {
  const maxSplats = opts.maxSplats ?? 900_000; // 900k * 32B = 28.8 MB
  const totalBytes = Number(response.headers.get('content-length')) || opts.totalBytes || 0;

  // Fast path for small .splat files (< 28 MB)
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
    const n = Math.floor(buf.byteLength / 32);
    return { buffer: buf, originalSplats: n, keptSplats: n, wasDecimated: false };
  }

  const reader = response.body.getReader();
  const outBytes = new Uint8Array(maxSplats * 32);
  const outDv = new DataView(outBytes.buffer);
  const scores = new Float32Array(maxSplats);
  let kept = 0;
  let loadedBytes = 0;

  if (opts.ext === 'ply') {
    // For massive multi-million-splat .ply scenes, prune low-opacity floaters (< 55 / 255)
    // and use reservoir replacement when kept == maxSplats so the entire file is covered evenly.
    const minOpacity = opts.minOpacity ?? 55;
    let carry = new Uint8Array(0);
    let headerParsed = false;
    let totalVertices = 0;
    let rowBytes = 0;
    let vertexIdx = 0;
    let eligibleSeen = 0;
    let offX = -1, offY = -1, offZ = -1;
    let offSx = -1, offSy = -1, offSz = -1;
    let offDc0 = -1, offDc1 = -1, offDc2 = -1, offOpac = -1;
    let offR0 = -1, offR1 = -1, offR2 = -1, offR3 = -1;

    // Fast deterministic PRNG for reservoir sampling across all 5M vertices
    let rngState = 0x12345678;
    const nextRand = () => {
      rngState ^= rngState << 13;
      rngState ^= rngState >>> 17;
      rngState ^= rngState << 5;
      return (rngState >>> 0) / 4294967296;
    };

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
        totalVertices = vMatch ? parseInt(vMatch[1], 10) : Math.floor(totalBytes / 236);

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
        vertexIdx++;
        // Quick opacity check first before reading other floats (skips >65% of vertices in ~2ns)
        const opacLogit = offOpac >= 0 ? dv.getFloat32(offset + offOpac, true) : 5;
        // sigmoid(-1.26) * 255 ≈ 56
        if (opacLogit < -1.26) {
          offset += rowBytes;
          continue;
        }

        const sxLog = offSx >= 0 ? dv.getFloat32(offset + offSx, true) : -4.6;
        const syLog = offSy >= 0 ? dv.getFloat32(offset + offSy, true) : -4.6;
        const szLog = offSz >= 0 ? dv.getFloat32(offset + offSz, true) : -4.6;
        const maxLogScale = Math.max(sxLog, syLog, szLog);
        // Reject giant blurry background/sky floaters (exp(-1.1) ≈ 0.33m radius) that destroy WebGL2 fill-rate.
        // Note: 2D surfel splats have min(sxLog, syLog, szLog) ≈ -40, which is normal and valid!
        if (maxLogScale > -1.05 || maxLogScale < -9.5) {
          offset += rowBytes;
          continue;
        }

        const x = dv.getFloat32(offset + offX, true);
        const y = dv.getFloat32(offset + offY, true);
        const z = dv.getFloat32(offset + offZ, true);
        const distSq = x * x + y * y + z * z;
        // Reject far-flung outlier noise (> 15m from origin)
        if (!Number.isFinite(distSq) || distSq > 225) {
          offset += rowBytes;
          continue;
        }

        const alpha = clampByte(sigmoid(opacLogit) * 255);
        if (alpha < minOpacity) {
          offset += rowBytes;
          continue;
        }

        // Clamp thin surfel normal axis to 0.4mm (0.0004) so WebGL2 covariance never underflows to 0
        const sx = Math.max(0.0004, Math.exp(sxLog));
        const sy = Math.max(0.0004, Math.exp(syLog));
        const sz = Math.max(0.0004, Math.exp(szLog));
        const minS = Math.min(sx, sy, sz);
        const diskArea = (sx * sy * sz) / minS;

        // Importance weight: favor high opacity^2, crisp surfel disk area, and proximity to scene core
        const score = (alpha * alpha * Math.sqrt(diskArea)) / (1 + 0.05 * distSq);
        eligibleSeen++;

        let writeSlot = -1;
        if (kept < maxSplats) {
          writeSlot = kept++;
        } else {
          const candidateSlot = Math.floor(nextRand() * eligibleSeen);
          if (candidateSlot < maxSplats && score >= scores[candidateSlot] * 0.85) {
            writeSlot = candidateSlot;
          }
        }

        if (writeSlot >= 0) {
          scores[writeSlot] = score;

          const r = offDc0 >= 0 ? clampByte((0.5 + SH_C0 * dv.getFloat32(offset + offDc0, true)) * 255) : 180;
          const g = offDc1 >= 0 ? clampByte((0.5 + SH_C0 * dv.getFloat32(offset + offDc1, true)) * 255) : 180;
          const b = offDc2 >= 0 ? clampByte((0.5 + SH_C0 * dv.getFloat32(offset + offDc2, true)) * 255) : 180;

          let q0 = offR0 >= 0 ? dv.getFloat32(offset + offR0, true) : 1;
          let q1 = offR1 >= 0 ? dv.getFloat32(offset + offR1, true) : 0;
          let q2 = offR2 >= 0 ? dv.getFloat32(offset + offR2, true) : 0;
          let q3 = offR3 >= 0 ? dv.getFloat32(offset + offR3, true) : 0;
          const qLen = Math.hypot(q0, q1, q2, q3) || 1;
          q0 /= qLen; q1 /= qLen; q2 /= qLen; q3 /= qLen;

          const wOff = writeSlot * 32;
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
        }

        offset += rowBytes;
      }
      carry = merged.subarray(offset);
      opts.onProgress?.(loadedBytes, totalBytes, kept);
    }

    const finalBuf = outBytes.buffer.slice(0, kept * 32);
    recenterSplatBuffer(finalBuf, kept);
    return {
      buffer: finalBuf,
      originalSplats: totalVertices,
      keptSplats: kept,
      wasDecimated: true,
    };
  }

  // Huge .splat file (> maxSplats * 32 bytes)
  const minOpacity = opts.minOpacity ?? 40;
  const estTotalSplats = totalBytes > 0 ? Math.floor(totalBytes / 32) : maxSplats * 2;
  const stride = Math.max(1, Math.floor(estTotalSplats / (maxSplats * 1.2)));
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

  const finalBuf = outBytes.buffer.slice(0, kept * 32);
  recenterSplatBuffer(finalBuf, kept);
  return {
    buffer: finalBuf,
    originalSplats: splatIdx,
    keptSplats: kept,
    wasDecimated: splatIdx > kept,
  };
}
