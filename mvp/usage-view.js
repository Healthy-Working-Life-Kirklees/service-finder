// Usage section of the Feedback and usage page: anonymous daily counts from the Worker (/usage/days), drawn as
// simple built-in SVG charts. Each chart also has a table, so the numbers can be read without the chart.
// feedback.js calls window.USAGE_VIEW.load(passcode) after signing in, and render() when the period changes.
(() => {
  'use strict';

  const cfg = window.FINDER_CONFIG || {};
  const API = String(cfg.apiBase || '').replace(/\/$/, '');
  const $ = (s) => document.querySelector(s);
  const SVGNS = 'http://www.w3.org/2000/svg';
  let days = [];
  let pass = '';
  let names = new Map();

  const LINK_LABELS = { referral: 'Referral form or link', website: 'Website', phone: 'Phone number', email: 'Email address', directions: 'Get directions', map: 'Show on map' };
  const LANG_LABELS = { en: 'English', pl: 'Polish', ur: 'Urdu' };
  const MODE_LABELS = { public: 'For themselves', staff: 'Helping someone else', none: 'Not chosen yet' };
  const A11Y_LABELS = { 'size-large': 'Larger text (A+)', 'size-larger': 'Largest text (A++)', contrast: 'High contrast' };
  const ANSWER_LABELS = { yes: 'Yes', notyet: 'Not yet', no: 'No' };

  // ---------- small helpers ----------
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'style') n.style.cssText = v; // via the style object: the page's security policy blocks style attributes
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }
  function svg(tag, attrs = {}, ...kids) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) { if (k === 'style') n.style.cssText = v; else n.setAttribute(k, v); }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  }
  const fmt = (n) => (n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'K' : n.toLocaleString('en-GB'));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '–');
  const nameOf = (id) => names.get(id) || id;
  const shortDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  // ---------- data ----------
  async function load(passcode, serviceNames) {
    pass = passcode;
    if (serviceNames) names = serviceNames;
    const box = $('#usage');
    if (!API || !box) return;
    try {
      const res = await fetch(API + '/usage/days', { headers: { 'x-feedback-passcode': pass } });
      if (res.status === 404) { days = []; box.replaceChildren(el('p', { class: 'msg info', text: "Usage counting isn't switched on yet. Once the Worker update is live, counts start from that day." })); return; }
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not load the usage counts.');
      days = d.days || [];
      render();
    } catch (e) {
      box.replaceChildren(el('p', { class: 'msg err', text: e.message || 'Could not load the usage counts.' }));
    }
  }

  async function exportCsv() {
    const res = await fetch(API + '/usage/export.csv', { headers: { 'x-feedback-passcode': pass } });
    if (!res.ok) return;
    const a = el('a', { href: URL.createObjectURL(await res.blob()), download: 'service-finder-usage-' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // The dates in the chosen period, oldest first, including days with nothing counted.
  function periodDates() {
    const p = $('#period').value;
    const end = new Date();
    let n;
    if (p === 'all') {
      const first = days.map((d) => d.date).sort()[0];
      n = first ? Math.round((Date.parse(end.toISOString().slice(0, 10)) - Date.parse(first)) / 86400000) + 1 : 1;
    } else n = Number(p);
    const out = [];
    for (let i = n - 1; i >= 0; i--) { const d = new Date(end); d.setUTCDate(d.getUTCDate() - i); out.push(d.toISOString().slice(0, 10)); }
    return out;
  }

  // Sums the counts in the period. Keys are "event|...|lang|mode".
  function summarise() {
    const dates = periodDates();
    const inPeriod = new Set(dates);
    const byDay = new Map(dates.map((d) => [d, {}]));
    const t = { ev: {}, links: {}, linkByScheme: {}, shown: {}, contacted: {}, contactedByScheme: {}, summary: {}, answers: {}, a11y: {}, listen: {}, lang: {}, mode: {}, copy: 0 };
    const add = (o, k, n) => { o[k] = (o[k] || 0) + n; };
    for (const day of days) {
      if (!inPeriod.has(day.date)) continue;
      for (const [key, n] of Object.entries(day.counts)) {
        const p = key.split('|');
        const ev = p[0];
        const lang = p[p.length - 2];
        const mode = p[p.length - 1];
        add(t.ev, ev, n);
        add(byDay.get(day.date), ev, n);
        if (ev === 'search') { add(t.lang, lang, n); add(t.mode, mode, n); }
        if (ev === 'link') { add(t.links, p[2], n); add(t.linkByScheme, p[1], n); }
        if (ev === 'shown') add(t.shown, p[1], n);
        if (ev === 'contacted') { add(t.contacted, p[2], n); t.contactedByScheme[p[1]] = t.contactedByScheme[p[1]] || {}; add(t.contactedByScheme[p[1]], p[2], n); }
        if (ev === 'summary') add(t.summary, p[1], n);
        if (ev === 'answers') add(t.answers, p[1], n);
        if (ev === 'a11y') add(t.a11y, p[1], n);
        if (ev === 'listen') add(t.listen, p[1], n);
        if (ev === 'copy') t.copy += n;
      }
    }
    return { dates, byDay, t };
  }

  // ---------- charts ----------
  // Horizontal bars, one series (one colour). Value at the tip of each bar.
  function hbars(title, rows, { caption, note, wide } = {}) {
    const fig = el('figure', { class: 'chart' + (wide ? ' chart-wide' : '') });
    fig.append(el('figcaption', {}, el('strong', { text: title }), note ? el('span', { class: 'chart-note', text: note }) : null));
    if (!rows.length || rows.every((r) => !r.value)) { fig.append(el('p', { class: 'hint', text: 'Nothing counted in this period.' })); return fig; }
    const max = Math.max(...rows.map((r) => r.value), 1);
    // Plain rows (label, bar, value), so screen readers read the label and number, and links stay usable.
    const list = el('div', { class: 'hbars' });
    for (const r of rows) {
      const w = Math.max((r.value / max) * 100, r.value ? 0.8 : 0);
      list.append(el('div', { class: 'hbar-row', title: r.label + ': ' + r.value.toLocaleString('en-GB') + (r.extra ? ' (' + r.extra + ')' : '') },
        el('span', { class: 'hbar-label' }, r.labelNode || r.label),
        el('span', { class: 'hbar-track', 'aria-hidden': 'true' }, el('span', { class: 'hbar-fill', style: 'width:' + w.toFixed(1) + '%' })),
        el('span', { class: 'hbar-value', text: fmt(r.value) + (r.extra ? ' · ' + r.extra : '') })));
    }
    fig.append(list, tableFor(caption || title, ['', 'Count'].concat(rows.some((r) => r.extra) ? ['Share'] : []), rows.map((r) => [r.label, r.value.toLocaleString('en-GB')].concat(rows.some((x) => x.extra) ? [r.extra || ''] : []))));
    return fig;
  }

  // Searches and conversations per day: two lines on one axis (both are counts), with a hover tooltip.
  function lineChart(title, dates, series) {
    const fig = el('figure', { class: 'chart chart-wide' });
    fig.append(el('figcaption', {}, el('strong', { text: title })));
    const total = series.reduce((a, s) => a + s.values.reduce((x, y) => x + y, 0), 0);
    if (!total) { fig.append(el('p', { class: 'hint', text: 'Nothing counted in this period.' })); return fig; }
    const W = 760, H = 240, L = 44, R = 96, T = 14, B = 30;
    const maxV = Math.max(...series.flatMap((s) => s.values), 1);
    const step = maxV <= 5 ? 1 : maxV <= 10 ? 2 : Math.pow(10, Math.floor(Math.log10(maxV))) * (maxV / Math.pow(10, Math.floor(Math.log10(maxV))) > 5 ? 2 : 1);
    const top = Math.ceil(maxV / step) * step;
    const x = (i) => L + (dates.length === 1 ? (W - L - R) / 2 : (i / (dates.length - 1)) * (W - L - R));
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'line-svg', role: 'img', 'aria-label': title + '. ' + series.map((s) => s.name + ': ' + s.values.reduce((a, b) => a + b, 0) + ' in total').join('; ') + '. The table below has the daily numbers.' });
    for (let v = 0; v <= top; v += step) {
      g.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }), svg('text', { x: L - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, fmt(v)));
    }
    const every = Math.max(1, Math.ceil(dates.length / 8));
    dates.forEach((d, i) => { const last = i === dates.length - 1; if (last || (i % every === 0 && dates.length - 1 - i >= every / 2)) g.append(svg('text', { x: x(i), y: H - 8, class: 'tick', 'text-anchor': 'middle' }, shortDate(d))); });
    for (const s of series) {
      const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      g.append(svg('polyline', { points: pts, class: 'line', style: 'stroke:' + s.color }));
      const last = s.values.length - 1;
      g.append(svg('circle', { cx: x(last), cy: y(s.values[last]), r: 4, class: 'end-dot', style: 'fill:' + s.color }));
      g.append(svg('text', { x: x(last) + 10, y: y(s.values[last]) + 4, class: 'end-label' }, s.name));
    }
    // Hover: a crosshair and a tooltip for the nearest day.
    const cross = svg('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' });
    const dots = series.map((s) => svg('circle', { r: 5, class: 'hover-dot', style: 'fill:' + s.color, visibility: 'hidden' }));
    g.append(cross, ...dots);
    const tip = el('div', { class: 'tip', hidden: true });
    const wrap = el('div', { class: 'line-wrap' }, g, tip);
    const hit = svg('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' });
    g.append(hit);
    const move = (ev) => {
      const r = g.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(dates.length - 1, Math.round(((px - L) / (W - L - R)) * (dates.length - 1))));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      series.forEach((s, k) => { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(s.values[i])); dots[k].setAttribute('visibility', 'visible'); });
      tip.replaceChildren(el('strong', { text: shortDate(dates[i]) }), ...series.map((s) => el('div', {}, el('span', { class: 'key', style: 'background:' + s.color }), s.name + ': ' + s.values[i])));
      tip.hidden = false;
      const left = (x(i) / W) * r.width;
      tip.style.left = Math.min(Math.max(left + 12, 0), r.width - 170) + 'px';
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); });
    const legend = el('div', { class: 'legend' }, series.map((s) => el('span', {}, el('span', { class: 'key', style: 'background:' + s.color }), s.name)));
    fig.append(legend, wrap, tableFor(title, ['Date', ...series.map((s) => s.name)], dates.map((d, i) => [shortDate(d), ...series.map((s) => String(s.values[i]))])));
    return fig;
  }

  // Every chart has its numbers in a table, closed by default.
  function tableFor(caption, head, rows) {
    return el('details', { class: 'chart-table' }, el('summary', { text: 'Show as a table' }),
      el('div', { class: 'scroll' }, el('table', { class: 'data' },
        el('caption', { class: 'visually-hidden', text: caption }),
        el('thead', {}, el('tr', {}, head.map((h) => el('th', { scope: 'col', text: h })))),
        el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => (i === 0 ? el('th', { scope: 'row', text: c }) : el('td', { class: 'num-cell', text: c })))))))));
  }

  // ---------- the section ----------
  function render() {
    const box = $('#usage');
    if (!box || !pass) return;
    const { dates, byDay, t } = summarise();
    const ev = (k) => t.ev[k] || 0;
    const searches = ev('search');
    const answered = ev('results') + ev('no-results');
    const contactLinks = ['referral', 'website', 'phone', 'email'].reduce((a, k) => a + (t.links[k] || 0), 0);
    const answers = ['yes', 'notyet', 'no'].reduce((a, k) => a + (t.contacted[k] || 0), 0);

    const tiles = [
      [fmt(ev('visit')), 'page visits'],
      [fmt(ev('conversation')), 'conversations started'],
      [fmt(searches), 'searches'],
      [pct(ev('results'), answered), 'of answered searches found services'],
      [fmt(contactLinks), 'contact or referral links opened'],
      [fmt(t.contacted.yes || 0), answers ? 'said they got in touch (' + pct(t.contacted.yes || 0, answers) + ' of answers)' : 'said they got in touch'],
    ];

    const C1 = '#2a78d6';
    const C2 = '#eb6834';
    const topServices = Object.keys({ ...t.shown, ...t.linkByScheme })
      .map((id) => ({ id, shown: t.shown[id] || 0, links: t.linkByScheme[id] || 0 }))
      .sort((a, b) => b.links - a.links || b.shown - a.shown)
      .slice(0, 12);

    box.replaceChildren(
      el('div', { class: 'toolbar' },
        el('button', { type: 'button', class: 'btn secondary small', text: 'Download usage as CSV', onclick: exportCsv })),
      el('p', { class: 'hint', text: 'Anonymous daily counts: no names, no IP addresses, nothing anyone typed. "Conversations" is the nearest honest measure of people using the finder, as the site deliberately doesn\'t recognise returning visitors.' }),
      el('div', { class: 'summary' }, tiles.map(([n, label]) => el('div', { class: 'stat' }, el('b', { text: n }), label))),
      el('div', { class: 'charts' },
        lineChart('Searches and conversations per day', dates, [
          { name: 'Searches', color: C1, values: dates.map((d) => byDay.get(d).search || 0) },
          { name: 'Conversations', color: C2, values: dates.map((d) => byDay.get(d).conversation || 0) },
        ]),
        hbars('What searches led to', [
          { label: 'Services suggested', value: ev('results'), extra: pct(ev('results'), searches) },
          { label: 'No services suggested', value: ev('no-results'), extra: pct(ev('no-results'), searches) },
          { label: 'A follow-up question', value: ev('question'), extra: pct(ev('question'), searches) },
          { label: 'Urgent support shown', value: ev('urgent'), extra: pct(ev('urgent'), searches) },
        ]),
        hbars('"Have we understood you?" check', [
          { label: 'Yes, show the support', value: t.summary.yes || 0, extra: pct(t.summary.yes || 0, (t.summary.yes || 0) + (t.summary.changed || 0)) },
          { label: 'Changed something first', value: t.summary.changed || 0, extra: pct(t.summary.changed || 0, (t.summary.yes || 0) + (t.summary.changed || 0)) },
        ], { note: 'Shown before the first services in a conversation.' }),
        hbars('How follow-up questions were answered', [
          { label: 'Tapped an answer', value: t.answers.tapped || 0 },
          { label: 'Typed an answer', value: t.answers.typed || 0 },
          { label: 'Tapped and typed', value: t.answers.both || 0 },
        ]),
        hbars('Links opened on service cards', Object.keys(LINK_LABELS).map((k) => ({ label: LINK_LABELS[k], value: t.links[k] || 0 }))),
        hbars('"Did you get in touch?" answers', ['yes', 'notyet', 'no'].map((k) => ({ label: ANSWER_LABELS[k], value: t.contacted[k] || 0, extra: pct(t.contacted[k] || 0, answers) })),
          { note: 'Asked when someone comes back after opening a contact or referral link. Staff are asked "Did you make a referral?".' }),
        hbars('Most used services: links opened', topServices.map((s) => ({ label: nameOf(s.id), labelNode: el('a', { href: 'services.html#svc-' + s.id, text: nameOf(s.id) }), value: s.links, extra: 'shown ' + s.shown + ' times' })),
          { wide: true, note: 'Up to 12 services, most links opened first. "Shown" counts how often each appeared as a card.' }),
        hbars('Searches by language', Object.keys(LANG_LABELS).map((k) => ({ label: LANG_LABELS[k], value: t.lang[k] || 0, extra: pct(t.lang[k] || 0, searches) }))),
        hbars('Searches by who it was for', ['public', 'staff'].map((k) => ({ label: MODE_LABELS[k], value: t.mode[k] || 0, extra: pct(t.mode[k] || 0, searches) }))),
        hbars('Accessibility and other tools', [
          ...Object.keys(A11Y_LABELS).map((k) => ({ label: A11Y_LABELS[k] + ' switched on', value: t.a11y[k] || 0 })),
          { label: 'Listen (read aloud) started', value: (t.listen.reply || 0) + (t.listen.card || 0) },
          { label: 'Copy details used', value: t.copy },
          { label: '"Other options" asked for', value: ev('other') },
        ])
      )
    );
  }

  window.USAGE_VIEW = { load, render };
})();
