// One element, src swapped per clip; the page writes playbackRate = 1 on `emptied` (YouTube-like).
(() => {
  const t = window.__t;
  const CLIPS = ['clip-5s.webm', 'clip-3s.webm', 'clip-2s.webm'];
  let i = 0;
  t.srcSwaps = 0; t.emptiedWrites = 0; t.clipsStarted = [];
  const v = t.track(t.makeVideo(t.MEDIA + CLIPS[0], { width: 640, height: 360 }), 'main');
  document.getElementById('player').appendChild(v);
  v.addEventListener('emptied', () => { v.playbackRate = 1; t.emptiedWrites++; });
  v.addEventListener('play', () => t.clipsStarted.push({ src: v.currentSrc.split('/').pop(), at: performance.now() }));
  t.next = () => { i++; t.srcSwaps++; v.src = t.MEDIA + CLIPS[i % CLIPS.length]; return v.play().catch(() => {}); };
  v.addEventListener('ended', t.next);
  if (!new URLSearchParams(location.search).has('noautoplay')) v.play().catch(() => {});
})();
