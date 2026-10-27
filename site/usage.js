// Anonymous usage counts (the Worker keeps daily tallies only: see worker/src/usage.js).
//
// What is sent: the kind of event (page opened, link opened, copy, listen, text size or contrast switched on,
// "other options", "did you get in touch"), and where relevant the scheme id, the kind of link or answer, the
// page's language and "who is this for". Never anything typed, no identifiers, no cookies or local storage.
// Nothing is sent unless the Worker's /health says counting is on.
(() => {
  'use strict';

  const cfg = window.FINDER_CONFIG || {};
  const API = String(cfg.apiBase || '').replace(/\/$/, '');
  let on = false;
  const queue = [];

  function post(body) {
    const text = JSON.stringify(body);
    // text/plain keeps this a simple request (no preflight). sendBeacon still sends if the page is closing.
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(API + '/usage', new Blob([text], { type: 'text/plain' }))) return;
    } catch { /* fall through */ }
    fetch(API + '/usage', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: text, keepalive: true }).catch(() => {});
  }

  // track('link', { s: 'scheme-id', k: 'referral' }). Language and mode are added here.
  function track(e, extra = {}) {
    if (!API) return;
    const radio = document.querySelector('input[name=mode]:checked');
    const body = { e, lang: (window.I18N && window.I18N.lang) || 'en', ...extra };
    if (radio && e !== 'visit' && e !== 'a11y') body.mode = radio.value;
    if (on) post(body);
    else if (queue.length < 20) queue.push(body);
  }

  if (API) {
    fetch(API + '/health')
      .then((r) => r.json())
      .then((h) => {
        on = Boolean(h && h.usage === true);
        if (on) for (const b of queue.splice(0)) post(b);
        else queue.length = 0;
      })
      .catch(() => { queue.length = 0; });
    track('visit');
  }

  window.USAGE = { track };
})();
