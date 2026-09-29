(() => {
  const t = window.__t;
  const box = document.getElementById('box');
  const v = t.track(t.makeVideo(t.MEDIA + 'clip-5s.webm', { width: 640, height: 360 }), 'main');
  box.appendChild(v);
  t.fsChanges = []; t.fsErrors = [];
  const req = (el) => el.requestFullscreen().catch((e) => t.fsErrors.push(String(e)));
  document.getElementById('fs-container').addEventListener('click', () => req(box));
  document.getElementById('fs-video').addEventListener('click', () => req(v));
  document.getElementById('fs-exit').addEventListener('click', () => document.exitFullscreen().catch(() => {}));
  document.addEventListener('fullscreenchange', () => t.fsChanges.push(document.fullscreenElement ? document.fullscreenElement.id || document.fullscreenElement.tagName : null));
  // Buttons must stay clickable in container fullscreen: put a copy of exit inside the box.
  const exit2 = document.createElement('button'); exit2.id = 'fs-exit-inner'; exit2.textContent = 'exit';
  exit2.addEventListener('click', () => document.exitFullscreen().catch(() => {}));
  box.appendChild(exit2);
})();
