// MediaSource: append a whole clip WebM and declare duration = Infinity (live-like).
(() => {
  const t = window.__t;
  t.live = { stage: 'init', error: null };
  const v = t.track(t.makeVideo('', { width: 640, height: 360 }), 'main');
  v.removeAttribute('src');
  document.getElementById('player').appendChild(v);
  const ms = new MediaSource();
  v.src = URL.createObjectURL(ms);
  ms.addEventListener('sourceopen', async () => {
    try {
      const sb = ms.addSourceBuffer('video/webm; codecs="vp9,opus"');
      const buf = await (await fetch(t.MEDIA + (new URLSearchParams(location.search).get('clip') || 'clip-5s.webm'))).arrayBuffer();
      t.live.log = [];
      sb.addEventListener('error', () => t.live.log.push('sourcebuffer error'));
      v.addEventListener('error', () => t.live.log.push('media error: ' + (v.error && v.error.message)));
      ms.addEventListener('sourceended', () => t.live.log.push('sourceended'));
      ms.addEventListener('sourceclose', () => t.live.log.push('sourceclose'));
      sb.addEventListener('updateend', () => {
        t.live.log.push('updateend ' + ms.readyState + ' duration ' + v.duration);
        ms.duration = Infinity;
        t.live.stage = 'ready';
        v.play().catch((e) => (t.live.error = String(e)));
      }, { once: true });
      sb.appendBuffer(buf);
      t.live.stage = 'appending';
    } catch (e) { t.live.error = String(e); }
  }, { once: true });
  t.info = () => ({
    duration: v.duration, currentTime: v.currentTime, readyState: v.readyState,
    seekable: Array.from({ length: v.seekable.length }, (_, i) => [v.seekable.start(i), v.seekable.end(i)]),
    buffered: Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]),
  });
})();
