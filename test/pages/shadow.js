// Open shadow root; CLOSED root created in a custom element constructor; closed inside open.
(() => {
  const t = window.__t;
  const mk = (name, clip) => t.track(t.makeVideo(t.MEDIA + clip, { width: 400, height: 225 }), name);
  class ClosedPlayer extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'closed' });
      const v = mk(this.id === 'closed-host' ? 'closed' : 'nested', this.id === 'closed-host' ? 'clip-3s.webm' : 'clip-2s.webm');
      root.appendChild(v);
    }
  }
  customElements.define('closed-player', ClosedPlayer);
  class NestedPlayer extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      const inner = document.createElement('closed-player');
      inner.id = 'nested-inner';
      root.appendChild(inner);
    }
  }
  const openRoot = document.getElementById('open-host').attachShadow({ mode: 'open' });
  openRoot.appendChild(mk('open', 'clip-5s.webm'));
  // define nested after closed so the inner element upgrades with id already set
  customElements.define('nested-player', NestedPlayer);
})();
