import type { ViewerPlugin } from '../types';

interface FontAxis {
  tag: string;
  min: number;
  def: number;
  max: number;
}

interface ParsedFontInfo {
  familyName: string;
  subfamilyName: string;
  numGlyphs: number;
  axes: FontAxis[];
}

const AXIS_LABELS: Record<string, string> = {
  wght: 'Weight',
  wdth: 'Width',
  slnt: 'Slant',
  ital: 'Italic',
  opsz: 'Optical Size',
  GRAD: 'Grade',
  CASL: 'Casual',
  CRSV: 'Cursive',
  MONO: 'Monospace',
};

/**
 * Lightweight zero-dependency OpenType / TrueType binary table inspector.
 * Extracts `maxp` glyph count and `fvar` Variable Font axes from .ttf / .otf buffers.
 */
function parseOpenTypeTables(buf: ArrayBuffer, fallbackName: string): ParsedFontInfo {
  const info: ParsedFontInfo = {
    familyName: fallbackName.replace(/\.[^.]+$/, ''),
    subfamilyName: 'Regular',
    numGlyphs: 0,
    axes: [],
  };
  try {
    const dv = new DataView(buf);
    if (dv.byteLength < 12) return info;
    const sfnt = dv.getUint32(0);
    // Only parse uncompressed TrueType (0x00010000 / 'true') or OpenType ('OTTO')
    if (sfnt !== 0x00010000 && sfnt !== 0x74727565 && sfnt !== 0x4f54544f) return info;

    const numTables = dv.getUint16(4);
    const tables: Record<string, { offset: number; length: number }> = {};
    for (let i = 0; i < numTables; i++) {
      const base = 12 + i * 16;
      if (base + 16 > dv.byteLength) break;
      const tag = String.fromCharCode(
        dv.getUint8(base),
        dv.getUint8(base + 1),
        dv.getUint8(base + 2),
        dv.getUint8(base + 3),
      );
      tables[tag] = {
        offset: dv.getUint32(base + 8),
        length: dv.getUint32(base + 12),
      };
    }

    if (tables.maxp && tables.maxp.offset + 6 <= dv.byteLength) {
      info.numGlyphs = dv.getUint16(tables.maxp.offset + 4);
    }

    if (tables.fvar && tables.fvar.offset + 16 <= dv.byteLength) {
      const fvarOff = tables.fvar.offset;
      const axesArrayOffset = dv.getUint16(fvarOff + 4);
      const axisCount = dv.getUint16(fvarOff + 8);
      const axisSize = dv.getUint16(fvarOff + 10);
      for (let i = 0; i < axisCount; i++) {
        const aOff = fvarOff + axesArrayOffset + i * axisSize;
        if (aOff + 20 > dv.byteLength) break;
        const tag = String.fromCharCode(
          dv.getUint8(aOff),
          dv.getUint8(aOff + 1),
          dv.getUint8(aOff + 2),
          dv.getUint8(aOff + 3),
        );
        const min = dv.getInt32(aOff + 4) / 65536;
        const def = dv.getInt32(aOff + 8) / 65536;
        const max = dv.getInt32(aOff + 12) / 65536;
        info.axes.push({ tag, min, def, max });
      }
    }
  } catch {
    /* ignore malformed table offsets */
  }
  return info;
}

async function registerFontFace(familyId: string, buf: ArrayBuffer): Promise<FontFace> {
  const face = new FontFace(familyId, buf.slice(0));
  await face.load();
  document.fonts.add(face);
  return face;
}

function drawSpecimenCard(familyId: string, info: ParsedFontInfo, lightTheme = false): string {
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 360;
  const c = canvas.getContext('2d')!;

  c.fillStyle = lightTheme ? '#f8fafc' : '#11131a';
  c.fillRect(0, 0, 360, 360);

  // Subtle typographic baseline grid lines
  c.strokeStyle = lightTheme ? 'rgba(15,23,42,0.06)' : 'rgba(255,255,255,0.05)';
  c.lineWidth = 1;
  for (const y of [76, 198, 250, 298]) {
    c.beginPath();
    c.moveTo(24, y);
    c.lineTo(336, y);
    c.stroke();
  }

  // Big hero "Aa"
  c.fillStyle = lightTheme ? '#0f172a' : '#f8fafc';
  c.font = `112px "${familyId}", sans-serif`;
  c.fillText('Aa', 26, 188);

  // Alphabet & numerals preview
  c.fillStyle = lightTheme ? '#334155' : '#cbd5e1';
  c.font = `20px "${familyId}", sans-serif`;
  c.fillText('ABCDEFGHIJKLM', 26, 238);
  c.fillText('abcdefghijklm · 0123456789', 26, 276);

  // Footer metadata line
  c.fillStyle = lightTheme ? '#64748b' : '#94a3b8';
  c.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
  const metaParts = [info.familyName];
  if (info.numGlyphs > 0) metaParts.push(`${info.numGlyphs} glyphs`);
  if (info.axes.length > 0) metaParts.push(`Variable (${info.axes.map((a) => a.tag).join(', ')})`);
  c.fillText(metaParts.join(' · ').slice(0, 44), 26, 330);

  return canvas.toDataURL('image/webp', 0.9);
}

export const fontViewer: ViewerPlugin = {
  id: 'font',
  label: 'Typeface & Variable Font',
  badge: 'FONT',
  extensions: ['ttf', 'otf', 'woff', 'woff2'],
  mimeTypes: ['font/ttf', 'font/otf', 'font/woff', 'font/woff2', 'application/x-font-ttf', 'application/x-font-otf'],

  async renderThumbnail(meta, fetchBuffer) {
    const buffer = await fetchBuffer();
    const familyId = `acv-font-thumb-${Math.random().toString(36).slice(2, 9)}`;
    const face = await registerFontFace(familyId, buffer);
    try {
      const info = parseOpenTypeTables(buffer, meta.name);
      return drawSpecimenCard(familyId, info, false);
    } finally {
      document.fonts.delete(face);
    }
  },

  async mount(ctx) {
    ctx.setProgress(10, `Loading ${ctx.meta.name}…`);
    const buffer = await ctx.fetchBuffer((loaded, total) => {
      if (total) ctx.setProgress((loaded / total) * 90);
    });
    if (ctx.signal.aborted) return () => {};

    const familyId = `acv-font-${Math.random().toString(36).slice(2, 9)}`;
    const face = await registerFontFace(familyId, buffer);
    const info = parseOpenTypeTables(buffer, ctx.meta.name);
    ctx.setProgress(null);

    const statusParts = [`${(buffer.byteLength / 1024).toFixed(1)} KB`];
    if (info.numGlyphs) statusParts.push(`${info.numGlyphs.toLocaleString()} glyphs`);
    if (info.axes.length) statusParts.push(`Variable (${info.axes.length} axes)`);
    ctx.setStatus(statusParts.join(' · '));

    // Also inject @font-face into the Shadow DOM container so Shadow DOM elements can render it
    const blobUrl = URL.createObjectURL(new Blob([buffer]));
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      @font-face { font-family: "${familyId}"; src: url("${blobUrl}"); }
      .font-root { height: 100%; overflow-y: auto; padding: 24px 28px; box-sizing: border-box; background: #121318; color: #f1f5f9; transition: background .15s, color .15s; }
      .font-root.paper { background: #f8fafc; color: #0f172a; }
      .axes-bar { display: flex; flex-wrap: wrap; gap: 16px; padding: 14px 16px; margin-bottom: 20px; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); }
      .font-root.paper .axes-bar { background: #fff; border-color: #e2e8f0; }
      .axis-item { display: flex; flex-direction: column; gap: 4px; min-width: 160px; flex: 1; }
      .axis-head { display: flex; justify-content: space-between; font-size: 11px; opacity: .8; font-weight: 600; }
      .hero-edit { font-family: "${familyId}", sans-serif; font-size: 56px; line-height: 1.15; outline: none; border-bottom: 1px solid rgba(148,163,184,0.2); padding-bottom: 16px; margin-bottom: 20px; word-break: break-word; }
      .waterfall-row { display: flex; align-items: baseline; gap: 16px; padding: 8px 0; border-bottom: 1px solid rgba(148,163,184,0.12); }
      .wf-size { width: 42px; flex-shrink: 0; font-size: 11px; opacity: .55; font-variant-numeric: tabular-nums; }
      .wf-text { font-family: "${familyId}", sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .glyph-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(54px, 1fr)); gap: 8px; }
      .glyph-cell { aspect-ratio: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; border-radius: 8px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); font-family: "${familyId}", sans-serif; font-size: 26px; }
      .font-root.paper .glyph-cell { background: #fff; border-color: #e2e8f0; }
      .glyph-code { font: 10px ui-monospace, monospace; opacity: .45; margin-top: 2px; }
    `;

    const root = document.createElement('div');
    root.className = 'font-root';

    let viewMode: 'waterfall' | 'glyphs' = 'waterfall';
    let paperTheme = false;
    const axisValues: Record<string, number> = {};
    for (const a of info.axes) axisValues[a.tag] = a.def;

    const variationCss = () =>
      info.axes.map((a) => `"${a.tag}" ${axisValues[a.tag] ?? a.def}`).join(', ');

    const applyVariations = () => {
      const settings = variationCss();
      root.querySelectorAll<HTMLElement>('.var-target').forEach((el) => {
        el.style.fontVariationSettings = settings;
      });
    };

    const renderBody = () => {
      root.classList.toggle('paper', paperTheme);
      root.replaceChildren();

      if (info.axes.length > 0) {
        const axesBar = document.createElement('div');
        axesBar.className = 'axes-bar';
        for (const a of info.axes) {
          const item = document.createElement('div');
          item.className = 'axis-item';
          const valSpan = document.createElement('span');
          valSpan.textContent = String(axisValues[a.tag]);
          const head = document.createElement('div');
          head.className = 'axis-head';
          head.innerHTML = `<span>${AXIS_LABELS[a.tag] || a.tag} (<code>${a.tag}</code>)</span>`;
          head.appendChild(valSpan);

          const input = document.createElement('input');
          input.type = 'range';
          input.min = String(a.min);
          input.max = String(a.max);
          input.step = String((a.max - a.min) / 200);
          input.value = String(axisValues[a.tag]);
          input.oninput = () => {
            axisValues[a.tag] = Number(input.value);
            valSpan.textContent = Number(input.value).toFixed(0);
            applyVariations();
          };
          item.append(head, input);
          axesBar.appendChild(item);
        }
        root.appendChild(axesBar);
      }

      const hero = document.createElement('div');
      hero.className = 'hero-edit var-target';
      hero.contentEditable = 'true';
      hero.spellcheck = false;
      hero.textContent = `${info.familyName} — Pack my box with five dozen liquor jugs 0123456789`;
      root.appendChild(hero);

      if (viewMode === 'waterfall') {
        const sizes = [14, 18, 24, 32, 42, 56];
        for (const sz of sizes) {
          const row = document.createElement('div');
          row.className = 'waterfall-row';
          row.innerHTML = `<span class="wf-size">${sz}px</span><span class="wf-text var-target" style="font-size:${sz}px">The quick brown fox jumps over the lazy dog · 0123456789 !@#$%&*</span>`;
          root.appendChild(row);
        }
      } else {
        const chars =
          'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{};:\'",.<>/?\\|~`©®™€£¥§¶†‡•…‰‹›«»–—';
        const grid = document.createElement('div');
        grid.className = 'glyph-grid';
        for (const ch of chars) {
          const cell = document.createElement('div');
          cell.className = 'glyph-cell var-target';
          cell.innerHTML = `<span>${ch}</span><span class="glyph-code">U+${ch
            .codePointAt(0)!
            .toString(16)
            .toUpperCase()
            .padStart(4, '0')}</span>`;
          grid.appendChild(cell);
        }
        root.appendChild(grid);
      }
      applyVariations();
    };

    const renderToolbar = () => {
      ctx.setActions([
        {
          id: 'mode',
          label: viewMode === 'waterfall' ? 'View: Waterfall' : 'View: Glyph Map',
          onClick: () => {
            viewMode = viewMode === 'waterfall' ? 'glyphs' : 'waterfall';
            renderBody();
            renderToolbar();
          },
        },
        {
          id: 'theme',
          label: paperTheme ? 'Theme: Paper' : 'Theme: Dark',
          onClick: () => {
            paperTheme = !paperTheme;
            renderBody();
            renderToolbar();
          },
        },
        {
          id: 'thumb',
          label: '📷 Set Thumbnail',
          onClick: async () => {
            const url = drawSpecimenCard(familyId, info, paperTheme);
            await ctx.saveCardThumbnail(url);
          },
        },
      ]);
    };

    ctx.container.append(styleEl, root);
    renderBody();
    renderToolbar();

    // Auto-save card thumbnail on first view
    ctx.saveCardThumbnail(drawSpecimenCard(familyId, info, false)).catch(() => {});

    return () => {
      document.fonts.delete(face);
      URL.revokeObjectURL(blobUrl);
      styleEl.remove();
      root.remove();
    };
  },
};
