(() => {
  const t = window.__t;
  const v = t.track(t.makeVideo(t.MEDIA + 'clip-5s.webm', { width: 640, height: 360 }), 'main');
  document.getElementById('player').appendChild(v);
  t.inlineRan = !!window.__inlineRan;
  try { document.createElement('div').innerHTML = '<b>x</b>'; t.ttEnforced = false; } catch (e) { t.ttEnforced = true; }
  t.cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => t.cspViolations.push(e.violatedDirective));
})();
