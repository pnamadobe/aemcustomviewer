import type { ViewerPlugin } from '../types';

export const audioSpectrumViewer: ViewerPlugin = {
  id: 'audio-spectrum',
  label: 'Interactive Audio Spectrum & Waveform Viewer',
  badge: 'AUDIO',
  extensions: ['mp3', 'wav', 'flac', 'ogg'],
  mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/flac', 'audio/ogg'],
  async mount(ctx) {
    ctx.setProgress(5, `Downloading ${ctx.meta.name}…`);
    const buffer = await ctx.fetchBuffer((loaded, total) => {
      if (total) {
        ctx.setProgress((loaded / total) * 95, `Downloading ${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
      }
    });
    if (ctx.signal.aborted) return () => {};
    ctx.setProgress(null);

    const blob = new Blob([buffer], { type: ctx.meta.mime || 'audio/mpeg' });
    const url = URL.createObjectURL(blob);

    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      padding: '16px',
      boxSizing: 'border-box',
      gap: '12px',
    });

    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      flex: '1',
      width: '100%',
      background: '#0d0d10',
      borderRadius: '8px',
      border: '1px solid rgba(255,255,255,0.08)',
    });

    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = url;
    audio.style.width = '100%';

    wrap.append(canvas, audio);
    ctx.container.appendChild(wrap);
    ctx.setStatus(`${(buffer.byteLength / 1048576).toFixed(2)} MB · WebAudio FFT`);

    const ac = new AudioContext();
    const srcNode = ac.createMediaElementSource(audio);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 256;
    srcNode.connect(analyser);
    analyser.connect(ac.destination);

    const freq = new Uint8Array(analyser.frequencyBinCount);
    const c2d = canvas.getContext('2d')!;
    let raf = 0;

    const draw = () => {
      if (ctx.signal.aborted) return;
      const r = canvas.getBoundingClientRect();
      if (canvas.width !== Math.floor(r.width) || canvas.height !== Math.floor(r.height)) {
        canvas.width = Math.floor(r.width);
        canvas.height = Math.floor(r.height);
      }
      analyser.getByteFrequencyData(freq);
      c2d.fillStyle = '#0d0d10';
      c2d.fillRect(0, 0, canvas.width, canvas.height);

      const barW = canvas.width / freq.length;
      for (let i = 0; i < freq.length; i++) {
        const v = freq[i] / 255;
        const h = v * (canvas.height - 24);
        c2d.fillStyle = `hsl(${210 + i * 0.7}, 85%, ${45 + v * 25}%)`;
        c2d.fillRect(i * barW + 1, canvas.height - h - 8, Math.max(1, barW - 2), h);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    ctx.setActions([
      {
        id: 'play-pause',
        label: 'Play / Pause',
        onClick: () => {
          if (ac.state === 'suspended') ac.resume();
          audio.paused ? audio.play() : audio.pause();
        },
      },
    ]);

    return () => {
      cancelAnimationFrame(raf);
      audio.pause();
      ac.close().catch(() => {});
      URL.revokeObjectURL(url);
      wrap.remove();
    };
  },
};
