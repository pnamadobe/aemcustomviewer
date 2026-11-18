#!/usr/bin/env node
/**
 * Fast 3D Gaussian Splat (.ply / .splat) Decimator & Converter
 *
 * Shrinks huge (1 GB+) .ply or .splat files down to compact, web-ready .splat files by:
 *   1. Converting 248-byte/splat 3DGS .ply (with 45 spherical harmonics floats) -> 32-byte/splat .splat (7.75x smaller immediately)
 *   2. Pruning near-transparent splats (opacity < minOpacity)
 *   3. Importance-sampling / ranking splats by visual contribution (opacity * scale) to hit a target splat count or MB budget
 *
 * Usage:
 *   node scripts/decimate-splat.mjs <input.ply|input.splat> [output.splat] [--max-splats 500000] [--max-mb 20] [--min-opacity 10]
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage:
  node scripts/decimate-splat.mjs <input.ply|input.splat> [output.splat] [options]

Options:
  --max-splats <N>     Maximum splats to keep (default: 750000 -> ~22.9 MB)
  --max-mb <MB>        Target output file size in MB (overrides --max-splats)
  --min-opacity <0-255> Prune splats with alpha below this value (default: 12)
`);
  process.exit(0);
}

const inputPath = path.resolve(args[0]);
let outputPath = '';
let maxSplats = 750_000;
let minOpacity = 12;

for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--max-splats' && args[i + 1]) {
    maxSplats = parseInt(args[++i], 10);
  } else if (a === '--max-mb' && args[i + 1]) {
    maxSplats = Math.floor((parseFloat(args[++i]) * 1024 * 1024) / 32);
  } else if (a === '--min-opacity' && args[i + 1]) {
    minOpacity = parseInt(args[++i], 10);
  } else if (!a.startsWith('--') && !outputPath) {
    outputPath = path.resolve(a);
  }
}

if (!outputPath) {
  const parsed = path.parse(inputPath);
  outputPath = path.join(parsed.dir, `${parsed.name}.decimated.splat`);
}

const stat = fs.statSync(inputPath);
const ext = path.extname(inputPath).toLowerCase();
console.log(`Input:  ${inputPath} (${(stat.size / 1048576).toFixed(1)} MB)`);
console.log(`Target: max ${maxSplats.toLocaleString()} splats (~${((maxSplats * 32) / 1048576).toFixed(1)} MB), minOpacity=${minOpacity}`);

const SH_C0 = 0.28209479177387814;
const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
const sigmoid = (v) => 1 / (1 + Math.exp(-v));

function decimateSplatFile() {
  const fd = fs.openSync(inputPath, 'r');
  const totalSplats = Math.floor(stat.size / 32);
  console.log(`Detected .splat format with ${totalSplats.toLocaleString()} splats.`);

  // Pass 1: score each splat by importance = alpha * maxScale
  const scores = new Float32Array(totalSplats);
  const chunkSplats = 65536;
  const buf = Buffer.allocUnsafe(chunkSplats * 32);
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, chunkSplats * 8);
  let surviving = 0;

  for (let base = 0; base < totalSplats; base += chunkSplats) {
    const count = Math.min(chunkSplats, totalSplats - base);
    fs.readSync(fd, buf, 0, count * 32, base * 32);
    for (let i = 0; i < count; i++) {
      const alpha = buf[i * 32 + 27];
      if (alpha < minOpacity) {
        scores[base + i] = -1;
        continue;
      }
      const sx = f32[i * 8 + 3];
      const sy = f32[i * 8 + 4];
      const sz = f32[i * 8 + 5];
      const maxS = Math.max(sx, sy, sz);
      if (!Number.isFinite(maxS) || maxS <= 0) {
        scores[base + i] = -1;
        continue;
      }
      scores[base + i] = alpha * Math.cbrt(sx * sy * sz);
      surviving++;
    }
  }

  let threshold = 0;
  if (surviving > maxSplats) {
    // Sample 200k scores to find the exact cutoff quantile in O(1) memory
    const sampleN = Math.min(200_000, surviving);
    const sample = new Float32Array(sampleN);
    const step = Math.max(1, Math.floor(totalSplats / sampleN));
    let k = 0;
    for (let i = 0; i < totalSplats && k < sampleN; i += step) {
      if (scores[i] > 0) sample[k++] = scores[i];
    }
    const sub = sample.subarray(0, k).sort();
    const keepRatio = maxSplats / surviving;
    threshold = sub[Math.max(0, Math.floor((1 - keepRatio) * k))];
  }

  // Pass 2: write surviving top splats
  const outFd = fs.openSync(outputPath, 'w');
  const outBuf = Buffer.allocUnsafe(chunkSplats * 32);
  let outInChunk = 0;
  let written = 0;

  for (let base = 0; base < totalSplats && written < maxSplats; base += chunkSplats) {
    const count = Math.min(chunkSplats, totalSplats - base);
    fs.readSync(fd, buf, 0, count * 32, base * 32);
    for (let i = 0; i < count && written < maxSplats; i++) {
      if (scores[base + i] >= threshold && scores[base + i] > 0) {
        buf.copy(outBuf, outInChunk * 32, i * 32, (i + 1) * 32);
        outInChunk++;
        written++;
        if (outInChunk === chunkSplats) {
          fs.writeSync(outFd, outBuf, 0, outInChunk * 32);
          outInChunk = 0;
        }
      }
    }
  }
  if (outInChunk > 0) fs.writeSync(outFd, outBuf, 0, outInChunk * 32);
  fs.closeSync(outFd);
  fs.closeSync(fd);
  console.log(`✅ Wrote ${written.toLocaleString()} splats to ${outputPath} (${((written * 32) / 1048576).toFixed(1)} MB)`);
}

function decimatePlyFile() {
  const fd = fs.openSync(inputPath, 'r');
  const headBuf = Buffer.allocUnsafe(65536);
  const headBytes = fs.readSync(fd, headBuf, 0, 65536, 0);
  const headStr = headBuf.subarray(0, headBytes).toString('utf8');
  const endIdx = headStr.indexOf('end_header\n');
  const endIdxCrLf = headStr.indexOf('end_header\r\n');
  const headerEndOffset = endIdx !== -1 ? endIdx + 11 : endIdxCrLf !== -1 ? endIdxCrLf + 12 : -1;
  if (headerEndOffset === -1) throw new Error('Could not find PLY end_header');

  const headerText = headStr.slice(0, headerEndOffset);
  const vMatch = headerText.match(/element vertex (\d+)/);
  if (!vMatch) throw new Error('Could not find element vertex count in PLY header');
  const totalSplats = parseInt(vMatch[1], 10);

  const props = [];
  const TYPE_SIZES = { float: 4, float32: 4, uchar: 1, uint8: 1, int: 4, short: 2, ushort: 2, double: 8 };
  let rowBytes = 0;
  for (const line of headerText.split(/\r?\n/)) {
    const m = line.match(/^property\s+(\S+)\s+(\S+)/);
    if (m) {
      const sz = TYPE_SIZES[m[1]] || 4;
      props.push({ type: m[1], name: m[2], offset: rowBytes, size: sz });
      rowBytes += sz;
    }
  }
  const propOffset = (name) => props.find((p) => p.name === name)?.offset ?? -1;
  const offX = propOffset('x'), offY = propOffset('y'), offZ = propOffset('z');
  const offSx = propOffset('scale_0'), offSy = propOffset('scale_1'), offSz = propOffset('scale_2');
  const offDc0 = propOffset('f_dc_0'), offDc1 = propOffset('f_dc_1'), offDc2 = propOffset('f_dc_2');
  const offOpac = propOffset('opacity');
  const offR0 = propOffset('rot_0'), offR1 = propOffset('rot_1'), offR2 = propOffset('rot_2'), offR3 = propOffset('rot_3');

  console.log(`Detected 3DGS .ply: ${totalSplats.toLocaleString()} vertices, ${rowBytes} bytes/vertex.`);

  const stride = Math.max(1, Math.ceil(totalSplats / (maxSplats * 2.2)));
  const chunkRows = 16384;
  const inBuf = Buffer.allocUnsafe(chunkRows * rowBytes);
  const candidates = [];

  for (let base = 0; base < totalSplats; base += chunkRows) {
    const count = Math.min(chunkRows, totalSplats - base);
    fs.readSync(fd, inBuf, 0, count * rowBytes, headerEndOffset + base * rowBytes);
    for (let i = 0; i < count; i += stride) {
      const rOff = i * rowBytes;
      const opacRaw = offOpac >= 0 ? inBuf.readFloatLE(rOff + offOpac) : 5;
      const alpha = clampByte(sigmoid(opacRaw) * 255);
      if (alpha < minOpacity) continue;

      const x = inBuf.readFloatLE(rOff + offX);
      const y = inBuf.readFloatLE(rOff + offY);
      const z = inBuf.readFloatLE(rOff + offZ);
      const sx = offSx >= 0 ? Math.exp(inBuf.readFloatLE(rOff + offSx)) : 0.01;
      const sy = offSy >= 0 ? Math.exp(inBuf.readFloatLE(rOff + offSy)) : 0.01;
      const sz = offSz >= 0 ? Math.exp(inBuf.readFloatLE(rOff + offSz)) : 0.01;
      if (!Number.isFinite(x + y + z + sx + sy + sz)) continue;

      const r = offDc0 >= 0 ? clampByte((0.5 + SH_C0 * inBuf.readFloatLE(rOff + offDc0)) * 255) : 180;
      const g = offDc1 >= 0 ? clampByte((0.5 + SH_C0 * inBuf.readFloatLE(rOff + offDc1)) * 255) : 180;
      const b = offDc2 >= 0 ? clampByte((0.5 + SH_C0 * inBuf.readFloatLE(rOff + offDc2)) * 255) : 180;

      let q0 = offR0 >= 0 ? inBuf.readFloatLE(rOff + offR0) : 1;
      let q1 = offR1 >= 0 ? inBuf.readFloatLE(rOff + offR1) : 0;
      let q2 = offR2 >= 0 ? inBuf.readFloatLE(rOff + offR2) : 0;
      let q3 = offR3 >= 0 ? inBuf.readFloatLE(rOff + offR3) : 0;
      const qLen = Math.hypot(q0, q1, q2, q3) || 1;
      q0 /= qLen; q1 /= qLen; q2 /= qLen; q3 /= qLen;

      const splatRec = Buffer.allocUnsafe(32);
      splatRec.writeFloatLE(x, 0);
      splatRec.writeFloatLE(y, 4);
      splatRec.writeFloatLE(z, 8);
      splatRec.writeFloatLE(sx, 12);
      splatRec.writeFloatLE(sy, 16);
      splatRec.writeFloatLE(sz, 20);
      splatRec[24] = r;
      splatRec[25] = g;
      splatRec[26] = b;
      splatRec[27] = alpha;
      splatRec[28] = clampByte(q0 * 128 + 128);
      splatRec[29] = clampByte(q1 * 128 + 128);
      splatRec[30] = clampByte(q2 * 128 + 128);
      splatRec[31] = clampByte(q3 * 128 + 128);

      const score = alpha * Math.cbrt(sx * sy * sz);
      candidates.push({ score, splatRec });
    }
  }
  fs.closeSync(fd);

  candidates.sort((a, b) => b.score - a.score);
  const kept = candidates.slice(0, maxSplats);
  const outFd = fs.openSync(outputPath, 'w');
  for (const item of kept) fs.writeSync(outFd, item.splatRec);
  fs.closeSync(outFd);
  console.log(`✅ Converted & decimated to ${kept.length.toLocaleString()} splats: ${outputPath} (${((kept.length * 32) / 1048576).toFixed(1)} MB)`);
}

if (ext === '.ply') {
  decimatePlyFile();
} else {
  decimateSplatFile();
}
