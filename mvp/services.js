// All services: a searchable, filterable list of every scheme in services.json, for the MVP team to
// check what's there, what's missing and what needs reviewing.
//
// Like the rest of the site it stores nothing. The search and filters live in the address (for example
// services.html?level=national&review=overdue), so a filtered view can be shared as a link.
(() => {
  'use strict';

  const STALE_DAYS = 135; // the page's "may be out of date" warning, as on the scheme cards
  const CYCLE_DAYS = { Quarterly: 91, 'Six-monthly': 182, Yearly: 365 };
  const REPO = 'https://github.com/Healthy-Working-Life-Kirklees/service-finder';
  const $ = (s) => document.querySelector(s);

  // ---------- small DOM helper (text only, never innerHTML) ----------
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }
  const isUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
  const link = (href, text) => (isUrl(href) ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text }) : document.createTextNode(text || ''));
  const list = (v) => (Array.isArray(v) ? v : []);
  const fmt = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const daysSince = (iso) => Math.floor((Date.now() - Date.parse(iso + 'T00:00:00')) / 86400000);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  const HEALTH = {
    any: 'Any health condition or disability',
    'mental-health': 'Mental health',
    'severe-mental-illness': 'Severe mental illness',
    'musculoskeletal-pain': 'Musculoskeletal pain',
    'substance-use': 'Substance use',
    'learning-disability-autism': 'Learning disability or autism',
    'unpaid-caring': 'Unpaid caring',
    none: 'No health requirement',
  };
  const SELF = { yes: 'Can refer themselves', partly: 'Self-referral: partly', no: 'Needs a referral', tbc: 'Self-referral: to be confirmed' };
  const LEVEL = { local: 'Local', regional: 'Regional', national: 'National' };

  // ---------- derived facts about each service ----------
  function review(s) {
    if (!s.open) return 'closed';
    const days = daysSince(s.lastUpdated);
    if (days > STALE_DAYS) return 'overdue';
    if (days > (CYCLE_DAYS[s.reviewCycle] || 91)) return 'due';
    return 'current';
  }
  const REVIEW = { overdue: ['Overdue a check', 'bad'], due: ['Due a check', 'warn'], current: ['Up to date', 'ok'], closed: ['Not open', 'bad'] };
  const confidence = (s) => (s.provenance && s.provenance.confidence) || 'none';
  // "Free if eligible", "Toolkit free; masterclasses paid", "£5 per 28 days" and so on. "Not stated" isn't a charge.
  function notFree(s) {
    const c = String(s.cost || '').trim();
    if (!c || /^not stated/i.test(c)) return false;
    return !/^free\b/i.test(c) || /fees|paid|interest|£|if eligible|for most|for jobseekers/i.test(c);
  }

  function gaps(s) {
    const g = new Set();
    if (!s.phone) g.add('no-phone');
    if (!s.email) g.add('no-email');
    if (!s.webpage) g.add('no-web');
    if (!s.phone && !s.email && !s.webpage) g.add('no-contact');
    if (!s.age) g.add('no-age');
    if (list(s.gate).length) g.add('gated');
    if (list(s.requiresMention).length) g.add('mention');
    if (notFree(s)) g.add('not-free');
    return g;
  }

  // Everything searchable, lower-cased once.
  function haystack(s) {
    const p = s.provenance || {};
    return [
      s.id, s.name, s.organisation, s.status, s.whoFor, s.age, s.phone, s.email, s.webpage, s.cost, s.languages, s.notes, s.workExperience,
      ...list(s.categories), ...list(s.areas), ...list(s.locations), ...list(s.eligibility), ...list(s.exclusions), ...list(s.gate),
      ...list(s.referralRoutes), ...list(s.healthFocus).map((h) => HEALTH[h] || h), ...list(s.audience), LEVEL[s.level],
      s.hwlFunded ? 'healthy working life hwl' : '', s.selfReferral && s.selfReferral.note,
      ...list(s.activities).flatMap((a) => [a.name, a.summary, a.duration]),
      p.source, p.foundVia, p.evidence,
    ].filter(Boolean).join(' \n ').toLowerCase();
  }

  // ---------- state, kept in the address ----------
  const FIELDS = ['q', 'type', 'level', 'area', 'category', 'health', 'audience', 'self', 'review', 'confidence', 'gap', 'sort'];
  const input = {
    q: $('#q'), type: $('#f-type'), level: $('#f-level'), area: $('#f-area'), category: $('#f-category'), health: $('#f-health'),
    audience: $('#f-audience'), self: $('#f-self'), review: $('#f-review'), confidence: $('#f-confidence'), gap: $('#f-gap'), sort: $('#f-sort'),
  };

  function readUrl() {
    const p = new URLSearchParams(location.search);
    for (const f of FIELDS) {
      const v = p.get(f) || '';
      const box = input[f];
      if (box.tagName === 'SELECT') box.value = [...box.options].some((o) => o.value === v) ? v : box.options[0].value;
      else box.value = v;
    }
  }
  function writeUrl() {
    const p = new URLSearchParams();
    for (const f of FIELDS) {
      const v = input[f].value.trim();
      if (v && !(f === 'sort' && v === 'name')) p.set(f, v);
    }
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }
  const anyFilter = () => FIELDS.some((f) => f !== 'sort' && input[f].value.trim());

  // ---------- filtering ----------
  let services = [];

  function matches(x) {
    const s = x.s;
    const v = (f) => input[f].value;
    if (v('type') === 'hwl' && !s.hwlFunded) return false;
    if (v('type') === 'other' && s.hwlFunded) return false;
    if (v('level') && s.level !== v('level')) return false;
    if (v('area') && !list(s.areas).includes(v('area'))) return false;
    if (v('category') && !list(s.categories).includes(v('category'))) return false;
    if (v('health') === 'none' ? list(s.healthFocus).length : v('health') && !list(s.healthFocus).includes(v('health'))) return false;
    if (v('audience') && !list(s.audience).includes(v('audience'))) return false;
    if (v('self') && (!s.selfReferral || s.selfReferral.allowed !== v('self'))) return false;
    if (v('review') && x.review !== v('review')) return false;
    if (v('confidence') && x.confidence !== v('confidence')) return false;
    if (v('gap') && !x.gaps.has(v('gap'))) return false;
    const words = input.q.value.toLowerCase().split(/\s+/).filter(Boolean);
    return words.every((w) => x.text.includes(w));
  }

  const SORTS = {
    name: (a, b) => a.s.name.localeCompare(b.s.name, 'en-GB', { sensitivity: 'base' }),
    org: (a, b) => a.s.organisation.localeCompare(b.s.organisation, 'en-GB', { sensitivity: 'base' }) || SORTS.name(a, b),
    oldest: (a, b) => a.s.lastUpdated.localeCompare(b.s.lastUpdated) || SORTS.name(a, b),
    newest: (a, b) => b.s.lastUpdated.localeCompare(a.s.lastUpdated) || SORTS.name(a, b),
  };

  function shown() {
    return services.filter(matches).sort(SORTS[input.sort.value] || SORTS.name);
  }

  // ---------- drawing ----------
  function row(dl, label, value) {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) return;
    const dd = el('dd');
    if (Array.isArray(value)) dd.append(el('ul', {}, value.map((x) => el('li', {}, x))));
    else dd.append(value);
    dl.append(el('dt', { text: label }), dd);
  }

  function entry(x) {
    const s = x.s;
    const days = daysSince(s.lastUpdated);
    const [revText, revClass] = REVIEW[x.review];
    const p = s.provenance || {};

    const pills = el('p', { class: 'badges' },
      s.hwlFunded ? el('span', { class: 'pill blue', text: 'HWL scheme' }) : null,
      el('span', { class: 'pill', text: LEVEL[s.level] || s.level }),
      el('span', { class: 'pill ' + revClass, text: revText }),
      s.selfReferral ? el('span', { class: 'pill' + (s.selfReferral.allowed === 'yes' ? ' ok' : ''), text: SELF[s.selfReferral.allowed] || s.selfReferral.allowed }) : null,
      x.confidence === 'medium' || x.confidence === 'low' ? el('span', { class: 'pill warn', text: 'Confidence: ' + x.confidence }) : null,
      x.gaps.has('mention') ? el('span', { class: 'pill', text: 'Only shown when mentioned' }) : null,
      x.gaps.has('no-contact') ? el('span', { class: 'pill bad', text: 'No contact details' }) : null
    );

    const dl = el('dl', { class: 'facts' });
    const contact = [];
    if (s.phone) contact.push(el('span', { text: 'Phone: ' + s.phone }));
    if (s.email) contact.push(el('span', {}, 'Email: ', el('a', { href: 'mailto:' + s.email, text: s.email })));
    if (s.webpage) contact.push(el('span', {}, 'Web: ', link(s.webpage, s.webpage)));
    row(dl, 'Contact', contact.length ? el('span', { class: 'stack' }, contact) : el('span', { class: 'gap', text: 'None listed' }));
    row(dl, 'Who it\'s for', s.whoFor);
    row(dl, 'Age', s.age || el('span', { class: 'gap', text: 'Not given' }));
    row(dl, 'Audience', list(s.audience).map((a) => a[0].toUpperCase() + a.slice(1)).join(', '));
    row(dl, 'Health focus', list(s.healthFocus).length ? list(s.healthFocus).map((h) => HEALTH[h] || h).join(', ') : 'No health requirement');
    row(dl, 'Must already be', list(s.gate));
    row(dl, 'Eligibility', list(s.eligibility));
    row(dl, 'Can\'t help', list(s.exclusions));
    row(dl, 'How to get in', list(s.referralRoutes).map((r) => {
      const m = r.match(/^(.*?):?\s*(https?:\/\/\S+)$/);
      return m ? el('span', {}, m[1] ? m[1] + ': ' : '', link(m[2], m[2])) : r;
    }));
    row(dl, 'Self-referral', s.selfReferral ? (SELF[s.selfReferral.allowed] || '') + (s.selfReferral.note ? '. ' + s.selfReferral.note : '') : '');
    row(dl, 'What it offers', list(s.activities).map((a) => a.name + ': ' + a.summary + (a.duration ? ' (' + a.duration + ')' : '')));
    row(dl, 'Where', list(s.locations));
    row(dl, 'Areas', list(s.areas).join(', '));
    row(dl, 'Categories', list(s.categories).join(', '));
    row(dl, 'Work experience', s.workExperience);
    row(dl, 'Cost', s.cost);
    row(dl, 'Languages and formats', s.languages);
    row(dl, 'Notes', s.notes);
    row(dl, 'Status', s.status + (s.open ? '' : ' (not open: never recommended)'));
    if (x.gaps.has('mention')) row(dl, 'Only shown if the person mentions', list(s.requiresMention).slice(0, 8).join(', ') + (s.requiresMention.length > 8 ? ' and ' + (s.requiresMention.length - 8) + ' more' : ''));
    row(dl, 'Source', p.source);
    row(dl, 'Found via', p.foundVia);
    row(dl, 'Checked against', p.checkedUrl ? link(p.checkedUrl, p.checkedUrl) : null);
    row(dl, 'Evidence it\'s current', p.evidence);
    row(dl, 'Confidence', p.confidence ? p.confidence[0].toUpperCase() + p.confidence.slice(1) : 'Not rated');
    row(dl, 'Review cycle', s.reviewCycle);

    const file = 'data/services/' + s.id + '.json';
    return el('article', { class: 'entry svc' + (s.hwlFunded ? ' hwl' : ''), id: 'svc-' + s.id },
      el('h3', {}, el('a', { href: '#svc-' + s.id, class: 'anchor', text: s.name })),
      el('p', { class: 'org' }, s.organisation, el('span', { class: 'id' }, el('code', { text: s.id }))),
      pills,
      el('p', { class: 'meta', text: 'Last checked ' + fmt(s.lastUpdated) + ' (' + plural(days, 'day', 'days') + ' ago). Areas: ' + list(s.areas).join(', ') + '. ' + list(s.categories).join(', ') + '.' }),
      el('details', {},
        el('summary', { text: 'Full details' }),
        dl,
        el('p', { class: 'links' },
          el('a', { href: REPO + '/edit/main/' + file, target: '_blank', rel: 'noopener noreferrer', text: 'Edit on GitHub' }),
          el('a', { href: REPO + '/blob/main/' + file, target: '_blank', rel: 'noopener noreferrer', text: 'View the file' }),
          el('a', { href: REPO + '/commits/main/' + file, target: '_blank', rel: 'noopener noreferrer', text: 'Change history' })))
    );
  }

  // Summary figures. Each one is a button that applies the matching filter.
  function summary() {
    const n = (f) => services.filter(f).length;
    const stats = [
      [services.length, 'services in total', {}],
      [n((x) => x.s.hwlFunded), 'Healthy Working Life schemes', { type: 'hwl' }],
      [n((x) => !x.s.hwlFunded), 'other services', { type: 'other' }],
      [n((x) => x.review === 'overdue'), 'overdue a check', { review: 'overdue' }],
      [n((x) => x.review === 'due'), 'due a check', { review: 'due' }],
      [n((x) => x.confidence === 'medium' || x.confidence === 'low'), 'medium or low confidence', { confidence: 'medium' }],
      [n((x) => x.gaps.has('no-contact')), 'with no contact details', { gap: 'no-contact' }],
      [n((x) => x.review === 'closed'), 'not open', { review: 'closed' }],
    ];
    const box = $('#summary');
    box.replaceChildren(...stats.map(([num, label, set]) =>
      el('button', { type: 'button', class: 'stat', title: 'Show these', onclick: () => {
        for (const f of FIELDS) if (f !== 'sort') input[f].value = '';
        for (const [k, v] of Object.entries(set)) input[k].value = v;
        update();
      } }, el('b', { text: String(num) }), label)));
  }

  let expanded = false;
  function update() {
    writeUrl();
    const rows = shown();
    const listEl = $('#list');
    listEl.replaceChildren(...rows.map(entry));
    if (expanded) listEl.querySelectorAll('details').forEach((d) => (d.open = true));
    $('#count').textContent = anyFilter()
      ? 'Showing ' + rows.length + ' of ' + plural(services.length, 'service', 'services') + '.'
      : 'Showing all ' + plural(services.length, 'service', 'services') + '.';
    $('#empty').hidden = rows.length > 0;
    $('#export').disabled = rows.length === 0;
  }

  // Fill a filter list from the data, most used first is less useful for scanning, so alphabetical with counts.
  function fill(select, values, label = (v) => v) {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    const keys = [...counts.keys()].sort((a, b) => String(label(a)).localeCompare(String(label(b)), 'en-GB'));
    for (const k of keys) select.append(el('option', { value: k, text: label(k) + ' (' + counts.get(k) + ')' }));
  }

  // ---------- CSV ----------
  function csvCell(v) {
    const t = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v);
    return '"' + t.replace(/"/g, '""') + '"';
  }
  function exportCsv() {
    const head = ['ID', 'Name', 'Organisation', 'HWL scheme', 'Level', 'Open', 'Review', 'Last checked', 'Days since check', 'Confidence',
      'Who it\'s for', 'Age', 'Audience', 'Health focus', 'Gate', 'Eligibility', 'Phone', 'Email', 'Web page', 'How to get in', 'Self-referral',
      'Areas', 'Categories', 'Locations', 'Cost', 'Languages', 'Source', 'Found via', 'Checked against', 'Evidence', 'File'];
    const lines = [head.map(csvCell).join(',')];
    for (const x of shown()) {
      const s = x.s, p = s.provenance || {};
      lines.push([s.id, s.name, s.organisation, s.hwlFunded ? 'Yes' : 'No', LEVEL[s.level], s.open ? 'Yes' : 'No', REVIEW[x.review][0], s.lastUpdated,
        daysSince(s.lastUpdated), p.confidence || '', s.whoFor, s.age, s.audience, s.healthFocus, s.gate, s.eligibility, s.phone, s.email, s.webpage,
        s.referralRoutes, s.selfReferral && s.selfReferral.allowed, s.areas, s.categories, s.locations, s.cost, s.languages, p.source, p.foundVia,
        p.checkedUrl, p.evidence, 'data/services/' + s.id + '.json'].map(csvCell).join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'service-finder-services-' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- start ----------
  fetch('../services.json')
    .then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then((d) => {
      services = list(d.services).map((s) => ({ s, review: review(s), confidence: confidence(s), gaps: gaps(s), text: haystack(s) }));
      const all = services.map((x) => x.s);
      fill(input.area, all.flatMap((s) => list(s.areas)));
      fill(input.category, all.flatMap((s) => list(s.categories)));
      fill(input.health, all.flatMap((s) => (list(s.healthFocus).length ? s.healthFocus : ['none'])), (h) => HEALTH[h] || h);
      fill(input.audience, all.flatMap((s) => list(s.audience)), (a) => a[0].toUpperCase() + a.slice(1));
      readUrl();
      summary();
      update();
      // Opening a link to one service (services.html#svc-<id>) scrolls to it and opens its details.
      const target = location.hash && document.getElementById(location.hash.slice(1));
      if (target) {
        target.querySelector('details').open = true;
        target.scrollIntoView();
      }
    })
    .catch(() => {
      $('#load-error').hidden = false;
    });

  let timer = null;
  input.q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(update, 150);
  });
  for (const f of FIELDS) if (f !== 'q') input[f].addEventListener('change', update);
  $('#clear').addEventListener('click', () => {
    for (const f of FIELDS) input[f].value = f === 'sort' ? 'name' : '';
    update();
    input.q.focus();
  });
  $('#expand').addEventListener('click', (e) => {
    expanded = !expanded;
    e.currentTarget.textContent = expanded ? 'Hide all details' : 'Show all details';
    $('#list').querySelectorAll('details').forEach((d) => (d.open = expanded));
  });
  $('#export').addEventListener('click', exportCsv);
})();
