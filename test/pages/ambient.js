// Muted looping autoplay background video (no controls) + a normal player.
(() => {
  const t = window.__t;
  const bg = t.track(t.makeVideo(t.MEDIA + 'clip-2s.webm', { muted: true, loop: true, autoplay: true, width: 1200, height: 420 }), 'ambient');
  bg.style.cssText = 'position:absolute;inset:0;width:100%;height:420px;object-fit:cover;opacity:.6';
  document.getElementById('hero').appendChild(bg);
  const main = t.track(t.makeVideo(t.MEDIA + 'clip-5s.webm', { controls: true, width: 480, height: 270 }), 'main');
  document.getElementById('player').appendChild(main);
})();
