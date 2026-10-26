// User feedback review page (MVP team only). Reads what people sent from the finder through the Worker's
// /feedback/items route, which needs the FEEDBACK_PASSCODE secret. The team can see the totals, read the
// comments, set a status, add a note, and download everything as CSV. Nothing here is stored in the browser
// except the passcode, in this tab only (sessionStorage), like the issues log.
(() => {
  'use strict';

  const cfg = window.FINDER_CONFIG || {};
  const API = String(cfg.apiBase || '').replace(/\/$/, '');
  const $ = (s) => document.querySelector(s);
  const PASS_KEY = 'hwlFeedbackPass';
  const STATUSES = ['New', 'Reviewed', 'Actioned', 'Not actioned'];
  const PAGE = 50;

  // Plain-English labels for the stored values. They match the wording people saw on the page (site/i18n.js).
  const REASON_LABELS = {
    // "No" under a reply
    'none-fit': 'None of these fit',
    'info-wrong': 'The information looked wrong',
    'hard-to-understand': 'It was hard to understand',
    'missed-service': 'It missed a service I know about',
    // "Report a problem with this listing"
    closed: "It has closed or isn't running",
    'contact-wrong': 'Phone, email or website is wrong',
    'eligibility-wrong': "Who it's for or eligibility is wrong",
    'no-reply': "Couldn't get through or got no reply",
    'not-in-area': "It isn't available in my area",
    'missing-details': 'Something useful is missing from the listing',
    other: 'Something else',
    // "Tell us what's missing"
    'missing-service': "A service that isn't listed",
    'missing-support': "A kind of support they couldn't find",
    'missing-other': 'Something else missing',
  };
  const KIND_LABELS = { reply: 'Was this helpful?', card: 'Problem with a listing', gap: "What's missing" };
  const LANG_LABELS = { en: 'English', pl: 'Polish', ur: 'Urdu' };
  const MODE_LABELS = { public: 'For themselves', staff: 'Helping someone else' };

  const store = {
    get: (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
  };

  let pass = store.get(PASS_KEY);
  let items = [];
  let names = new Map(); // scheme id -> name
  let shown = PAGE;

  // ---------- helpers ----------
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }

  const fmtDate = (d) => {
    const x = new Date(d + 'T12:00:00Z');
    return isNaN(x) ? d : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const nameOf = (id) => names.get(id) || id;
  const reason = (r) => REASON_LABELS[r] || r;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '–');

  function say(text, kind = 'info') {
    const m = $('#status-msg');
    m.className = 'msg ' + kind;
    m.textContent = text;
    m.hidden = !text;
  }

  async function api(method, path, body, raw) {
    if (!API) throw Object.assign(new Error('This page has not been connected to the Worker yet.'), { status: 0 });
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-feedback-passcode': pass },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw Object.assign(new Error('Could not reach the feedback store. Please check your connection.'), { status: 0 });
    }
    if (raw && res.ok) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
    return data;
  }

  // Scheme names, so entries show names rather than ids. The All services list has every scheme, including
  // ones no longer on the live list; fall back to the live list.
  async function loadNames() {
    for (const url of ['services-all.json', '../services.json']) {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) continue;
        const d = await r.json();
        names = new Map((d.services || []).map((s) => [s.id, s.name]));
        return;
      } catch { /* try the next one */ }
    }
  }

  // ---------- gate ----------
  function showGate(msg) {
    $('#app').hidden = true;
    $('#gate').hidden = false;
    const g = $('#gate-msg');
    g.textContent = msg || '';
    g.hidden = !msg;
  }

  async function unlock(candidate) {
    pass = candidate;
    try {
      const d = await api('GET', '/feedback/items');
      items = d.items || [];
    } catch (e) {
      pass = '';
      store.del(PASS_KEY);
      showGate(e.status === 404 ? "Reading feedback hasn't been switched on yet (the FEEDBACK_PASSCODE secret isn't set). Ask Phil." : e.status === 401 ? 'That passcode is not right.' : e.message);
      return;
    }
    store.set(PASS_KEY, pass);
    $('#gate').hidden = true;
    $('#app').hidden = false;
    $('#pass').value = '';
    await loadNames();
    render();
  }

  function lock() {
    pass = '';
    items = [];
    store.del(PASS_KEY);
    $('#list').replaceChildren();
    showGate('');
  }

  async function load() {
    try {
      const d = await api('GET', '/feedback/items');
      items = d.items || [];
      say('');
      render();
    } catch (e) {
      if (e.status === 401) return showGate('Your session has ended. Please enter the passcode again.');
      say(e.message, 'err');
    }
  }

  async function patch(id, fields, okText) {
    try {
      const d = await api('PATCH', '/feedback/items/' + id, fields);
      items = items.map((x) => (x.id === id ? d.item : x));
      render();
      say(okText, 'ok');
    } catch (e) {
      if (e.status === 401) return showGate('Your session has ended. Please enter the passcode again.');
      say(e.message, 'err');
      render();
    }
  }

  async function exportCsv() {
    try {
      const res = await api('GET', '/feedback/export.csv', null, true);
      const blob = await res.blob();
      const a = el('a', { href: URL.createObjectURL(blob), download: 'service-finder-feedback-' + new Date().toISOString().slice(0, 10) + '.csv' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      say('Downloaded.', 'ok');
    } catch (e) {
      say(e.message, 'err');
    }
  }

  // ---------- working out the numbers ----------
  function inPeriod() {
    const p = $('#period').value;
    if (p === 'all') return items;
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - Number(p));
    const since = d.toISOString().slice(0, 10);
    return items.filter((x) => x.date >= since);
  }

  const count = (arr, keyFn) => {
    const m = new Map();
    for (const x of arr) for (const k of [].concat(keyFn(x))) if (k) m.set(k, (m.get(k) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  };

  function table(caption, headers, rows) {
    if (!rows.length) return el('p', { class: 'hint', text: 'Nothing in this period.' });
    return el('table', { class: 'data' },
      el('caption', { class: 'visually-hidden', text: caption }),
      el('thead', {}, el('tr', {}, headers.map((h) => el('th', { scope: 'col', text: h })))),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => (i === 0 ? el('th', { scope: 'row' }, c) : el('td', { class: 'num-cell', text: String(c) })))))));
  }

  function renderOverview(list) {
    const replies = list.filter((x) => x.kind === 'reply');
    const yes = replies.filter((x) => x.helpful === true);
    const no = replies.filter((x) => x.helpful === false);
    const cards = list.filter((x) => x.kind === 'card');
    const gaps = list.filter((x) => x.kind === 'gap');
    const needsReading = list.filter((x) => x.status === 'New' && !(x.kind === 'reply' && x.helpful === true));

    const stats = [
      [pct(yes.length, replies.length), 'said results were helpful'],
      [String(yes.length), '"Yes" answers'],
      [String(no.length), '"No" answers'],
      [String(cards.length), 'problems with a listing'],
      [String(gaps.length), "what's missing"],
      [String(needsReading.length), 'new, waiting to be read'],
    ];
    $('#summary').replaceChildren(...stats.map(([n, label]) => el('div', { class: 'stat' }, el('b', { text: n }), label)));

    // Was this helpful, split by who it was for and language.
    const split = (keyFn, labels) => count(replies, keyFn).map(([k]) => {
      const group = replies.filter((x) => keyFn(x) === k);
      const y = group.filter((x) => x.helpful === true).length;
      return [labels[k] || k, y, group.length - y, pct(y, group.length)];
    });
    $('#helpful').replaceChildren(
      table('Helpful answers by who it was for', ['Who it was for', 'Yes', 'No', 'Helpful'], split((x) => x.mode, MODE_LABELS)),
      el('div', { class: 'mt-sm' }),
      table('Helpful answers by language', ['Language', 'Yes', 'No', 'Helpful'], split((x) => x.lang, LANG_LABELS))
    );

    // Reasons for No (people can tick more than one; some tick none).
    const noReasons = count(no, (x) => (x.reasons && x.reasons.length ? x.reasons.map(reason) : ['No reason ticked']));
    $('#reasons').replaceChildren(table('Reasons people gave for No', ['Reason', 'Times'], noReasons));

    // Services: problem reports per scheme, plus how often each scheme was shown in a reply marked No.
    const reported = count(cards, (x) => x.schemeIds);
    const inNo = new Map(count(no, (x) => x.schemeIds));
    const svcRows = reported.slice(0, 15).map(([id, n]) => {
      const why = count(cards.filter((x) => x.schemeIds.includes(id)), (x) => x.reasons.map(reason)).map(([r, c]) => (c > 1 ? r + ' (' + c + ')' : r)).join('; ');
      return [el('a', { href: 'services.html#svc-' + id, text: nameOf(id) }), n, inNo.get(id) || 0, why];
    });
    $('#services').replaceChildren(...[
      svcRows.length
        ? el('div', { class: 'scroll' }, el('table', { class: 'data' },
            el('caption', { class: 'visually-hidden', text: 'Services with problem reports' }),
            el('thead', {}, el('tr', {}, ['Service', 'Reports', 'In a "No" reply', 'What was reported'].map((h) => el('th', { scope: 'col', text: h })))),
            el('tbody', {}, svcRows.map(([a, n, m, why]) => el('tr', {}, el('th', { scope: 'row' }, a), el('td', { class: 'num-cell', text: String(n) }), el('td', { class: 'num-cell', text: String(m) }), el('td', { text: why }))))))
        : el('p', { class: 'hint', text: 'No problem reports in this period.' }),
      reported.length > 15 ? el('p', { class: 'hint', text: 'Showing the 15 most reported of ' + reported.length + '.' }) : null,
    ].filter(Boolean));

    // What's missing: suggested services and kinds of support people couldn't find.
    const suggested = gaps.filter((x) => x.missedService && x.missedService.name);
    $('#missing').replaceChildren(
      table('Kinds of support people could not find', ['Kind of support', 'Times'], count(gaps, (x) => x.gapCategories)),
      el('div', { class: 'mt-sm' }),
      table('Areas they were looking in', ['Area', 'Times'], count(gaps, (x) => x.gapArea)),
      el('p', { class: 'hint', text: suggested.length + ' suggested ' + (suggested.length === 1 ? 'service' : 'services') + ' in this period (see the list below).' })
    );
  }

  // ---------- the list ----------
  function filtered(list) {
    const kind = $('#flt-kind').value;
    const status = $('#flt-status').value;
    const q = $('#flt-q').value.trim().toLowerCase();
    return list
      .filter((x) => {
        if (kind === 'read') return !(x.kind === 'reply' && x.helpful === true);
        if (kind === 'yes') return x.kind === 'reply' && x.helpful === true;
        if (kind === 'no') return x.kind === 'reply' && x.helpful === false;
        if (kind === 'card' || kind === 'gap') return x.kind === kind;
        return true;
      })
      .filter((x) => !status || x.status === status)
      .filter((x) => {
        if (!q) return true;
        const ms = x.missedService || {};
        const hay = [x.text, x.note, ms.name, ms.website, ms.area, x.gapArea, ...(x.gapCategories || []), ...(x.schemeIds || []).map(nameOf), ...(x.reasons || []).map(reason)].join(' ').toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => b.id - a.id);
  }

  function entry(x) {
    const kindText = x.kind === 'reply' ? (x.helpful ? 'Helpful: Yes' : 'Helpful: No') : KIND_LABELS[x.kind];
    const done = x.status === 'Actioned' || x.status === 'Not actioned';
    const statusSel = el('select', { id: 'st-' + x.id }, STATUSES.map((s) => el('option', { value: s, text: s })));
    statusSel.value = x.status;
    statusSel.addEventListener('change', () => patch(x.id, { status: statusSel.value }, 'Status updated.'));
    const noteIn = el('textarea', { id: 'nt-' + x.id, rows: '2', maxlength: '500', placeholder: 'For example: checked with the service, listing updated' });
    noteIn.value = x.note || '';

    const facts = el('dl', { class: 'facts' });
    const fact = (label, value) => { if (value && (!Array.isArray(value) || value.length)) facts.append(el('dt', { text: label }), el('dd', {}, value)); };
    if (x.schemeIds && x.schemeIds.length) {
      fact(x.kind === 'card' ? 'Listing' : 'Services shown', el('ul', {}, x.schemeIds.map((id) => el('li', {}, el('a', { href: 'services.html#svc-' + id, text: nameOf(id) })))));
    }
    if (x.kind === 'card' && x.recordLastUpdated) fact('Listing last checked', fmtDate(x.recordLastUpdated));
    if (x.reasons && x.reasons.length) fact(x.kind === 'reply' ? 'Why not' : 'What they said', el('ul', {}, x.reasons.map((r) => el('li', { text: reason(r) }))));
    if (x.missedService) {
      const ms = x.missedService;
      fact('Suggested service', el('span', { class: 'stack' },
        ms.name ? el('span', { text: ms.name }) : null,
        ms.website ? el('span', { text: ms.website }) : null,
        ms.area ? el('span', { text: 'Area: ' + ms.area }) : null));
    }
    if (x.gapCategories && x.gapCategories.length) fact('Support they looked for', x.gapCategories.join(', '));
    if (x.gapArea) fact('Area', x.gapArea);
    if (x.text) fact('Comment', el('span', { class: 'comment', text: x.text }));

    return el('article', { class: 'entry fb-entry' + (x.kind === 'reply' && !x.helpful ? ' fb-no' : '') + (x.kind === 'card' ? ' fb-card' : '') + (done ? ' closed' : '') },
      el('h3', {}, el('span', { class: 'num', text: '#' + x.id + ' ' }), kindText),
      el('div', { class: 'badges' },
        el('span', { class: 'pill ' + (x.status === 'New' ? 'blue' : done ? 'ok' : ''), text: x.status }),
        el('span', { class: 'pill', text: MODE_LABELS[x.mode] || x.mode }),
        el('span', { class: 'pill', text: LANG_LABELS[x.lang] || x.lang }),
        x.redacted ? el('span', { class: 'pill warn', text: 'Contact details removed' }) : null
      ),
      el('p', { class: 'meta', text: 'Sent ' + fmtDate(x.date) }),
      facts.children.length ? facts : null,
      el('div', { class: 'controls' },
        el('div', {}, el('label', { for: 'st-' + x.id, text: 'Status' }), statusSel),
        el('div', { class: 'grow' }, el('label', { for: 'nt-' + x.id, text: 'Reviewer note' }), noteIn),
        el('button', { type: 'button', class: 'btn secondary small', text: 'Save note', onclick: () => patch(x.id, { note: noteIn.value.trim() }, 'Note saved.') })
      )
    );
  }

  function renderList(list) {
    const rows = filtered(list);
    $('#count').textContent = rows.length === 0 ? 'Nothing matches those filters.' : rows.length + (rows.length === 1 ? ' entry' : ' entries') + (rows.length > shown ? ', showing the newest ' + shown : '');
    $('#list').replaceChildren(...rows.slice(0, shown).map(entry));
    $('#more').hidden = rows.length <= shown;
  }

  function render() {
    const list = inPeriod();
    renderOverview(list);
    renderList(list);
  }

  // ---------- wiring ----------
  $('#unlock').addEventListener('click', () => { const v = $('#pass').value.trim(); if (v) unlock(v); });
  $('#pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#unlock').click(); } });
  $('#refresh').addEventListener('click', load);
  $('#export').addEventListener('click', exportCsv);
  $('#lock').addEventListener('click', lock);
  $('#period').addEventListener('change', () => { shown = PAGE; render(); });
  for (const id of ['#flt-kind', '#flt-status']) $(id).addEventListener('change', () => { shown = PAGE; renderList(inPeriod()); });
  $('#flt-q').addEventListener('input', () => { shown = PAGE; renderList(inPeriod()); });
  $('#more').addEventListener('click', () => { shown += PAGE; renderList(inPeriod()); });

  if (pass) unlock(pass);
  else showGate('');
})();
