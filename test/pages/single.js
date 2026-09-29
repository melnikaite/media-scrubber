(() => {
  const t = window.__t;
  const v = t.track(t.makeVideo(t.MEDIA + (new URLSearchParams(location.search).get('clip') || 'clip-5s.webm'), { width: 860, height: 483 }), 'main');
  v.id = 'v';
  document.getElementById('player').appendChild(v);
  document.getElementById('play').addEventListener('click', () => (v.paused ? v.play() : v.pause()));
  t.inputEvents = 0;
  document.getElementById('txt').addEventListener('input', () => t.inputEvents++);
})();
