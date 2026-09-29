(() => {
  const t = window.__t;
  t.origin = location.origin;
  const v = t.track(t.makeVideo(t.MEDIA + 'clip-5s.webm', { width: 440, height: 248 }), 'main');
  document.getElementById('player').appendChild(v);
})();
