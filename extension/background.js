// Service worker: toolbar click + command → toggle the bar in the tab's top frame; ON badge;
// per-tab frame router (DESIGN §6.12). The router is pure: tabId → frameId → Port, no other
// state. When the worker is suspended the ports drop and every frame reconnects by itself.
'use strict';

let warnedNoReceiver = false;

function setBadge(tabId, open) {
  try {
    chrome.action.setBadgeText({ tabId, text: open ? 'ON' : '' }).catch(() => {});
    if (open) chrome.action.setBadgeBackgroundColor({ tabId, color: '#5AA8FF' }).catch(() => {});
  } catch (_) { /* tab gone */ }
}

async function msToggle(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'ms:toggle' }, { frameId: 0 });
    const open = !!(reply && reply.open);
    setBadge(tabId, open);
    wakeFrames(tabId, open);
    return { open };
  } catch (err) {
    // chrome:// pages, the Web Store, or tabs loaded before the extension was installed.
    if (!warnedNoReceiver) {
      warnedNoReceiver = true;
      console.info('Media Scrubber: no content script in this tab (reload the page?)', String(err && err.message || err));
    }
    setBadge(tabId, false);
    return { open: false };
  }
}
self.msToggle = msToggle;

chrome.action.onClicked.addListener((tab) => { if (tab && tab.id != null) msToggle(tab.id); });

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-bar') return;
  if (tab && tab.id != null) { msToggle(tab.id); return; }
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
    if (tabs[0] && tabs[0].id != null) msToggle(tabs[0].id);
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'ms:state' && sender.tab && sender.frameId === 0) {
    setBadge(sender.tab.id, !!msg.open);
    wakeFrames(sender.tab.id, !!msg.open);
  } else if (msg && msg.type === 'ms:wake' && sender.tab) {
    wakeFrames(sender.tab.id, true);    // an <iframe> (re)loaded while the bar is open
  }
});

// ---- frame router ----
// No frameId → reaches every frame of the tab; child frames connect (open) or disconnect (closed).
function wakeFrames(tabId, open) {
  try { chrome.tabs.sendMessage(tabId, { type: 'ms:frames-open', open }).catch(() => {}); } catch (_) {}
}

const routes = new Map();   // tabId → Map<frameId, Port>

function post(port, msg) { try { port.postMessage(msg); } catch (_) {} }

chrome.runtime.onConnect.addListener((port) => {
  const snd = port.sender;
  if (port.name !== 'ms-frame' || !snd || !snd.tab || typeof snd.frameId !== 'number') return;
  const tabId = snd.tab.id, fid = snd.frameId;
  let table = routes.get(tabId);
  if (!table) routes.set(tabId, (table = new Map()));
  const old = table.get(fid);
  table.set(fid, port);
  if (old && old !== port) { try { old.disconnect(); } catch (_) {} }
  port.onMessage.addListener((msg) => {
    const t = routes.get(tabId);
    if (!t || !msg || typeof msg !== 'object') return;
    if (fid === 0) {
      if (msg.to === 'all') { for (const [f, p] of t) if (f !== 0) post(p, msg); }
      else if (typeof msg.to === 'number' && msg.to !== 0) { const p = t.get(msg.to); if (p) post(p, msg); }
    } else {
      const top = t.get(0);
      if (top) post(top, Object.assign({}, msg, { from: fid }));
    }
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    const t = routes.get(tabId);
    if (!t || t.get(fid) !== port) return;
    t.delete(fid);
    if (fid === 0) { for (const p of t.values()) post(p, { t: 'top-gone' }); }
    else { const top = t.get(0); if (top) post(top, { t: 'frame-gone', from: fid }); }
    if (!t.size) routes.delete(tabId);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') setBadge(tabId, false);
});
