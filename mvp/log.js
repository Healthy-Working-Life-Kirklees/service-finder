(() => {
  'use strict';

  const cfg = window.FINDER_CONFIG || {};
  const API = String(cfg.apiBase || '').replace(/\/$/, '');
  const $ = (s) => document.querySelector(s);

  const TYPES = ['Issue', 'Action', 'Idea', 'Question'];
  const AREAS = ['Matching quality', 'Data accuracy', 'Wording and content', 'Safety', 'Technical', 'Process and governance', 'Other'];
  const PRIORITIES = ['High', 'Medium', 'Low'];
  const STATUSES = ['Open', 'In progress', 'Done', "Won't do"];
  const PASS_KEY = 'hwlLogPass';
  const BY_KEY = 'hwlLogBy';

  const store = {
    get: (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
  };

  let pass = store.get(PASS_KEY);
  let items = [];
  const openIds = new Set(); // which entries have their notes expanded

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

  const when = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  function fillSelect(sel, values, { all } = {}) {
    sel.replaceChildren();
    if (all) sel.append(el('option', { value: '', text: 'All' }));
    for (const v of values) sel.append(el('option', { value: v, text: v }));
  }

  function say(text, kind = 'info') {
    const m = $('#status-msg');
    m.className = 'msg ' + kind;
    m.textContent = text;
    m.hidden = !text;
  }

  async function api(method, path, body) {
    if (!API) throw Object.assign(new Error('This page has not been connected to the Worker yet.'), { status: 0 });
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-team-passcode': pass },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw Object.assign(new Error('Could not reach the log. Please check your connection.'), { status: 0 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
    return data;
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
      await api('GET', '/log/check');
    } catch (e) {
      pass = '';
      store.del(PASS_KEY);
      showGate(e.status === 404 ? 'The log has not been switched on yet. Ask Phil.' : e.status === 401 ? 'That passcode is not right.' : e.message);
      return;
    }
    store.set(PASS_KEY, pass);
    $('#gate').hidden = true;
    $('#app').hidden = false;
    $('#pass').value = '';
    await load();
  }

  function lock() {
    pass = '';
    items = [];
    store.del(PASS_KEY);
    $('#list').replaceChildren();
    showGate('');
  }

  // ---------- data ----------
  async function load() {
    try {
      const d = await api('GET', '/log/items');
      items = d.items || [];
      say('');
      render();
    } catch (e) {
      if (e.status === 401) return showGate('Your session has ended. Please enter the passcode again.');
      say(e.message, 'err');
    }
  }

  const by = () => $('#by').value.trim();

  async function patch(id, fields, okText) {
    try {
      const d = await api('PATCH', '/log/items/' + id, { ...fields, by: by() });
      items = items.map((x) => (x.id === id ? d.item : x));
      render();
      if (okText) say(okText, 'ok');
    } catch (e) {
      say(e.message, 'err');
      render();
    }
  }

  // ---------- rendering ----------
  const PRI = { High: 0, Medium: 1, Low: 2 };
  const isClosed = (s) => s === 'Done' || s === "Won't do";

  function filtered() {
    const show = $('#flt-status').value;
    const type = $('#flt-type').value;
    const area = $('#flt-area').value;
    const pri = $('#flt-priority').value;
    const q = $('#flt-q').value.trim().toLowerCase();
    return items
      .filter((x) => (show === 'all' ? true : show === 'closed' ? isClosed(x.status) : !isClosed(x.status)))
      .filter((x) => !type || x.type === type)
      .filter((x) => !area || x.area === area)
      .filter((x) => !pri || x.priority === pri)
      .filter((x) => !q || (x.title + ' ' + x.details + ' ' + x.owner + ' ' + x.updates.map((u) => u.text).join(' ')).toLowerCase().includes(q))
      .sort((a, b) => Number(isClosed(a.status)) - Number(isClosed(b.status)) || PRI[a.priority] - PRI[b.priority] || Date.parse(b.updated) - Date.parse(a.updated));
  }

  function renderSummary() {
    const open = items.filter((x) => !isClosed(x.status));
    const stats = [
      ['Open issues', open.filter((x) => x.type === 'Issue').length],
      ['Open actions', open.filter((x) => x.type === 'Action').length],
      ['Questions and ideas', open.filter((x) => x.type === 'Question' || x.type === 'Idea').length],
      ['High priority open', open.filter((x) => x.priority === 'High').length],
      ['Done or won\u2019t do', items.length - open.length],
    ];
    $('#summary').replaceChildren(...stats.map(([label, n]) => el('div', { class: 'stat' }, el('b', { text: String(n) }), label)));
  }

  function entry(x) {
    const closed = isClosed(x.status);
    const statusSel = el('select', { id: 'st-' + x.id, onchange: (e) => patch(x.id, { status: e.target.value }, 'Status updated.') }, STATUSES.map((s) => el('option', { value: s, text: s })));
    statusSel.value = x.status;
    const priSel = el('select', { id: 'pr-' + x.id, onchange: (e) => patch(x.id, { priority: e.target.value }, 'Priority updated.') }, PRIORITIES.map((s) => el('option', { value: s, text: s })));
    priSel.value = x.priority;
    const ownerIn = el('input', { id: 'ow-' + x.id, type: 'text', maxlength: '40', value: x.owner || '', autocomplete: 'off' });
    const noteIn = el('textarea', { id: 'nt-' + x.id, rows: '2', maxlength: '2000', placeholder: 'Add a note or an update' });

    const notes = el('ul', { class: 'notes' }, x.updates.map((u) => el('li', {}, el('span', { class: 'when', text: when(u.t) + (u.by ? ' \u00b7 ' + u.by : '') }), u.text)));
    const det = el('details', {},
      el('summary', { text: 'Notes and history (' + x.updates.length + ')' }),
      x.updates.length ? notes : el('p', { text: 'No notes yet.' }),
      noteIn,
      el('div', { class: 'toolbar' }, el('button', {
        type: 'button', class: 'btn secondary small', text: 'Add note',
        onclick: () => { const t = noteIn.value.trim(); if (t) { openIds.add(x.id); patch(x.id, { update: t }, 'Note added.'); } },
      }))
    );
    det.open = openIds.has(x.id);
    det.addEventListener('toggle', () => (det.open ? openIds.add(x.id) : openIds.delete(x.id)));

    return el('article', { class: 'entry pri-' + x.priority + (closed ? ' closed' : '') },
      el('h3', {}, el('span', { class: 'num', text: '#' + x.id + ' ' }), x.title),
      el('div', { class: 'badges' },
        el('span', { class: 'pill blue', text: x.type }),
        el('span', { class: 'pill', text: x.area }),
        el('span', { class: 'pill ' + (x.priority === 'High' ? 'bad' : x.priority === 'Low' ? '' : 'warn'), text: x.priority + ' priority' }),
        el('span', { class: 'pill ' + (closed ? 'ok' : ''), text: x.status })
      ),
      x.details ? el('p', { class: 'details', text: x.details }) : null,
      el('p', { class: 'meta', text: 'Added ' + when(x.created) + (x.updated !== x.created ? ' \u00b7 updated ' + when(x.updated) : '') + (x.owner ? ' \u00b7 owner: ' + x.owner : '') }),
      el('div', { class: 'controls' },
        el('div', {}, el('label', { for: 'st-' + x.id, text: 'Status' }), statusSel),
        el('div', {}, el('label', { for: 'pr-' + x.id, text: 'Priority' }), priSel),
        el('div', {}, el('label', { for: 'ow-' + x.id, text: 'Owner' }), ownerIn),
        el('button', { type: 'button', class: 'btn secondary small', text: 'Save owner', onclick: () => patch(x.id, { owner: ownerIn.value.trim() }, 'Owner saved.') })
      ),
      det
    );
  }

  function render() {
    renderSummary();
    $('#starter').hidden = items.length > 0;
    const rows = filtered();
    $('#list').replaceChildren(...rows.map(entry));
    $('#empty-filter').hidden = !(items.length > 0 && rows.length === 0);
  }

  // ---------- CSV ----------
  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheet formulas
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    const head = ['ID', 'Type', 'Title', 'Details', 'Area', 'Priority', 'Status', 'Owner', 'Added', 'Updated', 'Notes'];
    const lines = [head.map(csvCell).join(',')];
    for (const x of items) {
      lines.push([x.id, x.type, x.title, x.details, x.area, x.priority, x.status, x.owner, x.created, x.updated, x.updates.map((u) => when(u.t) + (u.by ? ' (' + u.by + ')' : '') + ': ' + u.text).join(' | ')].map(csvCell).join(','));
    }
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'service-finder-log-' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- wiring ----------
  fillSelect($('#f-type'), TYPES);
  fillSelect($('#f-area'), AREAS);
  fillSelect($('#f-priority'), PRIORITIES);
  $('#f-priority').value = 'Medium';
  $('#f-area').value = 'Other';
  fillSelect($('#flt-type'), TYPES, { all: true });
  fillSelect($('#flt-area'), AREAS, { all: true });
  fillSelect($('#flt-priority'), PRIORITIES, { all: true });
  $('#by').value = store.get(BY_KEY);
  $('#by').addEventListener('change', () => store.set(BY_KEY, by()));

  $('#unlock').addEventListener('click', () => unlock($('#pass').value));
  $('#pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); unlock($('#pass').value); } });
  $('#lock').addEventListener('click', lock);
  $('#refresh').addEventListener('click', load);
  $('#export').addEventListener('click', exportCsv);
  $('#new').addEventListener('click', () => { $('#form').hidden = false; $('#f-title').focus(); });
  $('#cancel').addEventListener('click', () => { $('#form').hidden = true; });
  for (const id of ['#flt-status', '#flt-type', '#flt-area', '#flt-priority']) $(id).addEventListener('change', render);
  $('#flt-q').addEventListener('input', render);

  $('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/log/items', {
        type: $('#f-type').value, area: $('#f-area').value, priority: $('#f-priority').value,
        title: $('#f-title').value, details: $('#f-details').value, owner: $('#f-owner').value,
      });
      $('#form').reset();
      $('#f-priority').value = 'Medium';
      $('#f-area').value = 'Other';
      $('#form').hidden = true;
      await load();
      say('Entry saved.', 'ok');
    } catch (err) {
      say(err.message, 'err');
    }
  });

  $('#load-starter').addEventListener('click', async () => {
    try {
      const seed = await (await fetch('seed-log.json')).json();
      const d = await api('POST', '/log/import', { items: seed.items });
      await load();
      say(d.imported ? 'Loaded ' + d.imported + ' starter entries.' : d.reason || 'Nothing was loaded.', d.imported ? 'ok' : 'info');
    } catch (err) {
      say(err.message, 'err');
    }
  });

  if (pass) unlock(pass);
  else showGate('');
})();
