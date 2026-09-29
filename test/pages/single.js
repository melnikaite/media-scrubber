(() => {
  const t = window.__t;
  const v = t.track(t.makeVideo(t.MEDIA + (new URLSearchParams(location.search).get('clip') || 'clip-5s.webm'), { width: 860, height: 483 }), 'main');
  v.id = 'v';
  document.getElementById('player').appendChild(v);
  t.pauseRecovery(v, 'main');
  document.getElementById('play').addEventListener('click', () => (v.paused ? v.play() : t.sitePause(v)));
  document.getElementById('pplay').addEventListener('click', () => v.play());
  document.getElementById('ppause').addEventListener('click', () => t.sitePause(v));
  t.inputEvents = 0;
  document.getElementById('txt').addEventListener('input', () => t.inputEvents++);
})();
