// Same-origin child (127.0.0.1) and a CROSS-ORIGIN child: 127.0.0.1 <-> localhost on the same port.
(() => {
  const port = location.port;
  const other = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  document.getElementById('same').src = '/pages/iframe-child.html?same';
  document.getElementById('cross').src = `http://${other}:${port}/pages/iframe-child.html?cross`;
})();
