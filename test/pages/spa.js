// history.pushState navigation replaces the whole player subtree with a new <video>.
(() => {
  const t = window.__t;
  t.navigations = 0; t.generation = 0;
  const app = document.getElementById('app');
  function render(p) {
    t.generation++;
    const sub = document.createElement('section');
    sub.className = 'player-page';
    const h = document.createElement('h2'); h.textContent = 'page ' + p; sub.appendChild(h);
    const v = t.track(t.makeVideo(t.MEDIA + (p % 2 ? 'clip-5s.webm' : 'clip-3s.webm'), { width: 640, height: 360 }), 'main');
    v.dataset.gen = String(t.generation);
    sub.appendChild(v);
    app.replaceChildren(sub);
    return v;
  }
  const pageNo = () => Number(new URLSearchParams(location.search).get('p') || 1);
  t.navigate = () => {
    history.pushState({}, '', location.pathname + '?p=' + (pageNo() + 1));
    t.navigations++;
    render(pageNo()).play().catch(() => {});
  };
  document.getElementById('nav').addEventListener('click', t.navigate);
  document.getElementById('back').addEventListener('click', () => history.back());
  window.addEventListener('popstate', () => { t.navigations++; render(pageNo()).play().catch(() => {}); });
  render(pageNo());
})();
