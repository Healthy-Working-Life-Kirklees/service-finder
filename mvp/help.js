(() => {
  'use strict';

  const STALE_DAYS = 135; // same threshold the Service Finder uses
  const $ = (s) => document.querySelector(s);

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }

  const fmt = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const age = (iso) => (Date.now() - Date.parse(iso)) / 86400000;

  fetch('../services.json')
    .then((r) => r.json())
    .then((d) => {
      const list = d.services || [];
      const overdue = list.filter((s) => s.open && age(s.lastUpdated) > STALE_DAYS);
      const notOpen = list.filter((s) => !s.open);
      $('#data-summary').textContent =
        list.length + ' schemes from "' + d.source + '". ' +
        (overdue.length ? overdue.length + ' are overdue for a check (older than about four and a half months). ' : 'None are overdue for a check. ') +
        (notOpen.length ? notOpen.length + (notOpen.length === 1 ? ' is' : ' are') + ' not open yet and never recommended.' : '');

      const body = $('#data-table tbody');
      const sorted = [...list].sort((a, b) => Date.parse(a.lastUpdated) - Date.parse(b.lastUpdated));
      for (const s of sorted) {
        const notes = [];
        if (Array.isArray(s.requiresMention) && s.requiresMention.length) notes.push('Only shown if the person mentions the relevant circumstance.');
        if (s.audience && !s.audience.includes('individual')) notes.push('For ' + s.audience.join(' / ') + ', not individuals.');
        if (s.selfReferral && s.selfReferral.allowed === 'tbc') notes.push('Self-referral route to be confirmed.');
        if (!s.webpage) notes.push('No web page listed.');
        const status = !s.open ? el('span', { class: 'pill bad', text: 'Not open yet' }) : age(s.lastUpdated) > STALE_DAYS ? el('span', { class: 'pill warn', text: 'Overdue a check' }) : el('span', { class: 'pill ok', text: 'Open' });
        body.append(el('tr', {}, el('td', { text: s.name }), el('td', { text: s.organisation }), el('td', {}, status), el('td', { class: 'nowrap', text: fmt(s.lastUpdated) }), el('td', { text: notes.join(' ') })));
      }
      $('#data-table').hidden = false;
    })
    .catch(() => {
      $('#data-summary').textContent = 'Could not load the scheme list.';
    });
})();
