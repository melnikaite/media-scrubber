(() => {
  const t = window.__t;
  document.getElementById('add').addEventListener('click', () => {
    const v = t.track(t.makeVideo(t.MEDIA + 'clip-5s.webm', { width: 640, height: 360 }), 'main');
    document.getElementById('later').appendChild(v);
    v.play().catch(() => {});
  });
})();
