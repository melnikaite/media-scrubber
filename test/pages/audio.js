// Hidden 0x0 <audio preload=none> with custom buttons; a detached new Audio() started by a button.
(() => {
  const t = window.__t;
  const a = document.getElementById('a');
  a.src = t.MEDIA + 'audio-8s.webm';
  t.track(a, 'hidden');
  document.getElementById('aplay').addEventListener('click', () => a.play());
  document.getElementById('apause').addEventListener('click', () => a.pause());
  document.getElementById('detached').addEventListener('click', () => {
    if (!t.media.detached) t.track(new Audio(t.MEDIA + 'audio-8s.webm'), 'detached');
    t.media.detached.play();
  });
})();
