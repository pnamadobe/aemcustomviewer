/**
 * In-memory 50% importance decimator for an already-loaded 32-byte/splat buffer.
 * Ranks every splat by `alpha * cbrt(sx * sy * sz)` and keeps the top `targetRatio` (default 0.5).
 */
export function decimateSplatBufferInMemory(buffer: ArrayBuffer, targetRatio = 0.5): ArrayBuffer {
  const totalSplats = Math.floor(buffer.byteLength / 32);
  const keepCount = Math.max(1000, Math.floor(totalSplats * targetRatio));
  if (totalSplats <= keepCount) return buffer;

  const srcBytes = new Uint8Array(buffer);
  const srcF32 = new Float32Array(buffer);
  const scores = new Float32Array(totalSplats);

  for (let i = 0; i < totalSplats; i++) {
    const alpha = srcBytes[i * 32 + 27];
    const sx = srcF32[i * 8 + 3];
    const sy = srcF32[i * 8 + 4];
    const sz = srcF32[i * 8 + 5];
    const vol = sx * sy * sz;
    scores[i] = alpha > 8 && Number.isFinite(vol) && vol > 0 ? alpha * Math.cbrt(vol) : -1;
  }

  // Find the cutoff threshold via a sorted sample
  const sampleN = Math.min(100_000, totalSplats);
  const sample = new Float32Array(sampleN);
  const step = Math.max(1, Math.floor(totalSplats / sampleN));
  let k = 0;
  for (let i = 0; i < totalSplats && k < sampleN; i += step) {
    sample[k++] = scores[i];
  }
  const sorted = sample.subarray(0, k).sort();
  const threshold = sorted[Math.max(0, Math.floor((1 - targetRatio) * k))];

  const outBytes = new Uint8Array(keepCount * 32);
  let written = 0;
  for (let i = 0; i < totalSplats && written < keepCount; i++) {
    if (scores[i] >= threshold && scores[i] > 0) {
      outBytes.set(srcBytes.subarray(i * 32, (i + 1) * 32), written * 32);
      written++;
    }
  }
  return outBytes.buffer.slice(0, written * 32);
}
