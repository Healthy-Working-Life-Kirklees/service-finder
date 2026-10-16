// All services: a searchable, filterable list of every scheme and service (services-all.json, which includes
// those not on the live list), for the MVP team to check what's there, what's missing and what needs reviewing,
// and to decide for each one: include it on the live list, give it further review, or exclude it completely.
//
// The search and filters live in the address (for example services.html?listing=review), so a filtered view
// can be shared as a link. Decisions are stored on the Worker with the team log, behind the team passcode,
// which is kept in this browser tab only (sessionStorage), as on the log page. They reach the live finder
// when scripts/apply-decisions.mjs writes them into the data in a pull request.
(() => {
  'use strict';

  const STALE_DAYS = 135; // the page's "may be out of date" warning, as on the scheme cards
  const CYCLE_DAYS = { Quarterly: 91, 'Six-monthly': 182, Yearly: 365 };
  const REPO = 'https://github.com/Healthy-Working-Life-Kirklees/service-finder';
  const $ = (s) => document.querySelector(s);
  const cfg = window.FINDER_CONFIG || {};
  const API = String(cfg.apiBase || '').replace(/\/$/, '');
  const PASS_KEY = 'hwlLogPass'; // shared with the log page, so signing in on one signs in on both
  const BY_KEY = 'hwlLogBy';
  const PLACEHOLDER = 'To be completed';
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
  };
  let pass = store.get(PASS_KEY);
  let team = null; // { <service id>: { decision, note, by, t, history } } once signed in
  let edits = null; // { <service id>: { changes, before, note, by, t, checked, checkedUrl, history } } once signed in
  let choices = {}; // the allowed values for the edit form, from services-all.json
  const editing = new Set(); // services whose edit form is open

  // ---------- small DOM helper (text only, never innerHTML) ----------
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = Boolean(v);
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
  const LISTING = { include: ['On the live list', 'ok'], review: ['Waiting for review', 'warn'], exclude: ['Excluded', 'bad'] };
  const CHOICE = { include: 'Include on the live list', review: 'Needs further review', exclude: 'Exclude completely' };
  const when = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const listing = (s) => (s.listing && LISTING[s.listing.decision] ? s.listing.decision : 'include');
  // Where the team has got to with a service: no decision yet, decided but not yet in the data, or applied.
  function teamState(x) {
    const t = team && team[x.s.id];
    if (!t) return x.s.listing && x.s.listing.by ? 'applied' : 'undecided';
    return t.decision === x.listing ? 'applied' : 'pending';
  }
  // A change to a service's details: none, waiting to be applied, or already in the data.
  const norm = (v) => JSON.stringify(v === undefined || v === '' ? null : v);
  function editState(x) {
    const e = edits && edits[x.s.id];
    if (!e) return 'none';
    return Object.keys(e.changes).every((k) => norm(x.s[k]) === norm(e.changes[k])) ? 'applied' : 'pending';
  }

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
      p.source, p.foundVia, p.evidence, s.listing && s.listing.reason,
    ].filter(Boolean).join(' \n ').toLowerCase();
  }

  // ---------- state, kept in the address ----------
  const FIELDS = ['q', 'listing', 'decision', 'type', 'level', 'area', 'category', 'health', 'audience', 'self', 'review', 'confidence', 'gap', 'sort'];
  const input = {
    q: $('#q'), listing: $('#f-listing'), decision: $('#f-decision'), type: $('#f-type'), level: $('#f-level'), area: $('#f-area'), category: $('#f-category'), health: $('#f-health'),
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
    if (v('listing') && x.listing !== v('listing')) return false;
    if (v('decision')) {
      const t = team && team[s.id];
      if (v('decision') === 'undecided' && teamState(x) !== 'undecided') return false;
      if (v('decision') === 'pending' && teamState(x) !== 'pending') return false;
      if (v('decision') === 'edited' && editState(x) !== 'pending') return false;
      if (v('decision').startsWith('team-') && (!t || 'team-' + t.decision !== v('decision'))) return false;
    }
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

  const ORDER = { review: 0, include: 1, exclude: 2 };
  const SORTS = {
    listing: (a, b) => ORDER[a.listing] - ORDER[b.listing] || SORTS.name(a, b),
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

    const [lText, lClass] = LISTING[x.listing];
    const t = team && team[s.id];
    const state = teamState(x);
    const pills = el('p', { class: 'badges' },
      el('span', { class: 'pill ' + lClass, text: lText }),
      state === 'pending' ? el('span', { class: 'pill blue', text: 'Team chose: ' + CHOICE[t.decision].toLowerCase() + ' (waiting to be applied)' }) : null,
      editState(x) === 'pending' ? el('span', { class: 'pill blue', text: 'Details edited by ' + edits[s.id].by + ' (waiting to be applied)' }) : null,
      x.incomplete ? el('span', { class: 'pill warn', text: 'Details to be completed' }) : null,
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
    const L = s.listing || {};
    return el('article', { class: 'entry svc' + (s.hwlFunded ? ' hwl' : '') + ' listing-' + x.listing, id: 'svc-' + s.id },
      el('h3', {}, el('a', { href: '#svc-' + s.id, class: 'anchor', text: s.name })),
      el('p', { class: 'org' }, s.organisation, el('span', { class: 'id' }, el('code', { text: s.id }))),
      pills,
      L.reason ? el('p', { class: 'listing', text: lText + ': ' + L.reason + (L.by ? ' (' + L.by + (L.date ? ', ' + fmt(L.date) : '') + ')' : '') }) : null,
      team ? decidePanel(x) : null,
      edits && editState(x) === 'pending' ? waitingChanges(x) : null,
      edits ? (editing.has(s.id) ? editForm(x) : el('p', { class: 'edit-open' }, el('button', { type: 'button', class: 'btn secondary small', text: 'Edit details', onclick: () => { editing.add(s.id); refreshOne(x); const f = document.getElementById('ed-' + s.id + '-name'); if (f) f.focus(); } }))) : null,
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

  // ---------- decisions ----------
  function decidePanel(x) {
    const s = x.s;
    const t = team[s.id];
    const name = 'dec-' + s.id;
    const note = el('textarea', { rows: '2', maxlength: '1000', id: 'note-' + s.id, value: t ? t.note || '' : '' });
    const msg = el('p', { class: 'msg', role: 'status', hidden: true });
    const warn = el('p', { class: 'msg info', hidden: true, text: 'Its details still say "' + PLACEHOLDER + '". The decision will be saved, but it can\'t go on the live list until someone fills them in.' });
    const radios = Object.keys(CHOICE).map((d) => el('label', {}, el('input', { type: 'radio', name, value: d, checked: t ? t.decision === d : false,
      onchange: () => { warn.hidden = !(d === 'include' && x.incomplete); } }), CHOICE[d]));
    const save = el('button', { type: 'button', class: 'btn primary small', text: t ? 'Change decision' : 'Save decision', onclick: async () => {
      const picked = radios.map((l) => l.querySelector('input')).find((i) => i.checked);
      const by = $('#by').value.trim();
      const show = (text, kind) => { msg.className = 'msg ' + kind; msg.textContent = text; msg.hidden = false; };
      if (!picked) return show('Choose include, further review or exclude.', 'err');
      if (!by) { $('#by').focus(); return show('Please put your name or initials at the top of the page first.', 'err'); }
      if (picked.value !== 'include' && note.value.trim().length < 3) { note.focus(); return show('Please say briefly why.', 'err'); }
      save.disabled = true;
      try {
        const d = await api('PUT', '/log/decisions/' + encodeURIComponent(s.id), { decision: picked.value, note: note.value.trim(), by });
        team[s.id] = d.item;
        refreshOne(x);
        summary();
        const again = document.getElementById('svc-' + s.id);
        const m = again && again.querySelector('.decide .msg[role=status]');
        if (m) { m.className = 'msg ok'; m.textContent = 'Saved.'; m.hidden = false; }
      } catch (e) {
        save.disabled = false;
        if (e.status === 401) { signOut('Your session has ended. Please enter the passcode again.'); return; }
        show(e.message, 'err');
      }
    } });
    const history = t ? [{ decision: t.decision, note: t.note, by: t.by, t: t.t }, ...[...(t.history || [])].reverse()] : [];
    return el('fieldset', { class: 'decide' },
      el('legend', { text: 'Team decision' }),
      t ? el('p', { class: 'current', text: 'Decided: ' + CHOICE[t.decision] + ' (' + (t.by || 'someone') + ', ' + when(t.t) + ').' + (teamTextApplied(x) ) }) : el('p', { class: 'current', text: 'Not yet decided by the team.' }),
      el('div', { class: 'choices' }, radios),
      warn,
      el('label', { class: 'note', for: 'note-' + s.id, text: 'Why (needed for further review or exclude)' }),
      note,
      el('div', { class: 'row-end' }, save, msg),
      history.length > 1 ? el('details', {}, el('summary', { text: 'Earlier decisions' }),
        el('ul', { class: 'notes' }, history.slice(1).map((h) => el('li', {}, el('span', { class: 'when', text: when(h.t) + (h.by ? ' \u00b7 ' + h.by : '') }), CHOICE[h.decision] + (h.note ? ': ' + h.note : ''))))) : null
    );
  }
  const teamTextApplied = (x) => (teamState(x) === 'applied' ? ' The finder already reflects this.' : ' Waiting to be applied to the finder.');

  // ---------- editing details ----------
  const FIELD_LABEL = {
    name: 'Name', organisation: 'Organisation', status: 'Status', open: 'Open to referrals', level: 'Level', whoFor: "Who it's for", age: 'Age',
    webpage: 'Web page', email: 'Email', phone: 'Phone', social: 'Social media', locations: 'Where (venues, times or how it is delivered)',
    areas: 'Areas', audience: 'Audience', categories: 'Categories', healthFocus: 'Health focus', eligibility: 'Eligibility', exclusions: "Can't help",
    gate: 'Must already be', referralRoutes: 'How to get in', selfReferral: 'Self-referral', activities: 'What it offers', workExperience: 'Work experience',
    cost: 'Cost', languages: 'Languages and formats', notes: 'Notes', reviewCycle: 'Review cycle',
  };
  const TEXT_FIELDS = ['name', 'organisation', 'status', 'age', 'phone', 'webpage', 'email', 'workExperience', 'cost', 'languages'];
  const AREA_FIELDS = ['whoFor', 'notes'];
  const LINE_FIELDS = ['locations', 'eligibility', 'exclusions', 'gate', 'referralRoutes', 'social'];
  const CHECK_FIELDS = ['audience', 'categories', 'areas', 'healthFocus'];
  const REQUIRED = new Set(['name', 'organisation', 'status', 'whoFor', 'workExperience']);
  const HINT = {
    age: 'For example 18+ or 16-25. Leave empty if not known.', webpage: 'Starting https://', gate: 'Things a person must already be, written "Is ..." or "Has ...".',
    referralRoutes: 'At least one.', status: 'For example "Live - open to referrals".',
  };

  function waitingChanges(x) {
    const e = edits[x.s.id];
    const fmtVal = (v) => (v == null || v === '' ? '(none)' : Array.isArray(v) ? (v.length ? v.map((a) => (typeof a === 'object' ? a.name + ': ' + a.summary : a)).join('; ') : '(none)') : typeof v === 'object' ? (SELF[v.allowed] || v.allowed) + '. ' + v.note + (v.url ? ' ' + v.url : '') : v === true ? 'Yes' : v === false ? 'No' : String(v));
    const discard = el('button', { type: 'button', class: 'btn secondary small', text: 'Discard these changes', onclick: async () => {
      if (!confirm('Discard the changes waiting for ' + x.s.name + '?')) return;
      try {
        await api('DELETE', '/log/edits/' + encodeURIComponent(x.s.id), { by: $('#by').value.trim() || 'someone' });
        delete edits[x.s.id];
        refreshOne(x);
        summary();
      } catch (err) {
        if (err.status === 401) return signOut('Your session has ended. Please enter the passcode again.');
        alert(err.message);
      }
    } });
    return el('div', { class: 'waiting' },
      el('p', { class: 'mt0' }, el('strong', { text: 'Changes waiting to be applied' }), ' (' + e.by + ', ' + when(e.t) + (e.checked ? ', checked as current' : '') + '): ' + e.note),
      el('dl', { class: 'facts' }, Object.keys(e.changes).flatMap((k) => [el('dt', { text: FIELD_LABEL[k] || k }),
        el('dd', {}, el('del', { text: fmtVal(x.s[k]) }), ' → ', el('ins', { text: fmtVal(e.changes[k]) }))])),
      discard);
  }

  function editForm(x) {
    const s = x.s;
    const pending = (edits[s.id] && editState(x) === 'pending' && edits[s.id].changes) || {};
    const val = (k) => (k in pending ? pending[k] : s[k]);
    const id = (k) => 'ed-' + s.id + '-' + k;
    const tbc = (v) => String(v == null ? '' : JSON.stringify(v)).includes(PLACEHOLDER);
    const label = (k, extra) => el('label', { for: id(k), text: FIELD_LABEL[k] + (REQUIRED.has(k) ? '' : extra || '') });
    const hint = (k) => (HINT[k] ? el('p', { class: 'hint', text: HINT[k] }) : null);
    const field = (k, input) => el('div', { class: 'field' + (tbc(val(k)) ? ' tbc' : '') }, label(k), input, hint(k));
    const form = el('form', { class: 'edit-form', novalidate: true });
    const grid = el('div', { class: 'edit-grid' });

    for (const k of ['name', 'organisation', 'status']) grid.append(field(k, el('input', { id: id(k), type: 'text', value: val(k) || '' })));
    grid.append(field('open', el('select', { id: id('open') }, el('option', { value: 'yes', text: 'Yes' }), el('option', { value: 'no', text: 'No (never recommended)' }))));
    grid.append(field('level', el('select', { id: id('level') }, (choices.level || []).map((v) => el('option', { value: v, text: LEVEL[v] || v })))));
    grid.append(field('reviewCycle', el('select', { id: id('reviewCycle') }, (choices.reviewCycle || []).map((v) => el('option', { value: v, text: v })))));
    for (const k of ['age', 'phone', 'webpage', 'email', 'workExperience', 'cost', 'languages']) grid.append(field(k, el('input', { id: id(k), type: k === 'email' ? 'email' : k === 'webpage' ? 'url' : 'text', value: val(k) || '' })));
    form.append(grid);
    for (const k of AREA_FIELDS) form.append(field(k, el('textarea', { id: id(k), rows: '3', value: val(k) || '' })));

    for (const k of CHECK_FIELDS) {
      const have = new Set(list(val(k)));
      form.append(el('fieldset', { class: 'checks', id: id(k) }, el('legend', { text: FIELD_LABEL[k] + (k === 'healthFocus' ? ' (none ticked means no health requirement)' : '') }),
        el('div', { class: 'choices' }, (choices[k] || []).map((v) => el('label', {}, el('input', { type: 'checkbox', value: v, checked: have.has(v) }), k === 'healthFocus' ? HEALTH[v] || v : k === 'audience' ? v[0].toUpperCase() + v.slice(1) : v)))));
    }
    for (const k of LINE_FIELDS) form.append(el('div', { class: 'field' + (tbc(val(k)) ? ' tbc' : '') }, label(k, ''), el('textarea', { id: id(k), rows: '3', value: list(val(k)).join('\n') }), el('p', { class: 'hint', text: 'One per line. ' + (HINT[k] || '') })));

    const sr = val('selfReferral') || { allowed: 'tbc', note: '' };
    form.append(el('fieldset', { class: 'checks' + (tbc(sr) ? ' tbc' : '') }, el('legend', { text: 'Self-referral' }),
      el('div', { class: 'edit-grid' },
        el('div', { class: 'field' }, el('label', { for: id('sr-allowed'), text: 'Can people refer themselves?' }), el('select', { id: id('sr-allowed') }, (choices.selfReferral || []).map((v) => el('option', { value: v, text: SELF[v] || v })))),
        el('div', { class: 'field' }, el('label', { for: id('sr-note'), text: 'Explanation' }), el('input', { id: id('sr-note'), type: 'text', value: sr.note || '' })),
        el('div', { class: 'field' }, el('label', { for: id('sr-url'), text: 'Self-referral link (optional)' }), el('input', { id: id('sr-url'), type: 'url', value: sr.url || '' })))));

    const acts = el('div', { class: 'acts' });
    const addAct = (a = { name: '', summary: '', duration: '' }) => {
      const n = acts.children.length;
      const row = el('div', { class: 'act' + (tbc(a) ? ' tbc' : '') },
        el('div', { class: 'field' }, el('label', { for: id('act-name-' + n), text: 'Name' }), el('input', { id: id('act-name-' + n), class: 'act-name', type: 'text', value: a.name })),
        el('div', { class: 'field' }, el('label', { for: id('act-summary-' + n), text: 'Summary' }), el('textarea', { id: id('act-summary-' + n), class: 'act-summary', rows: '2', value: a.summary })),
        el('div', { class: 'field' }, el('label', { for: id('act-duration-' + n), text: 'How long (optional)' }), el('input', { id: id('act-duration-' + n), class: 'act-duration', type: 'text', value: a.duration || '' })),
        el('button', { type: 'button', class: 'btn secondary small', text: 'Remove', onclick: () => row.remove() }));
      acts.append(row);
    };
    list(val('activities')).forEach((a) => addAct(a));
    form.append(el('fieldset', { class: 'checks' }, el('legend', { text: 'What it offers' }), acts,
      el('button', { type: 'button', class: 'btn secondary small', text: 'Add another', onclick: () => addAct() })));

    const checkedBox = el('input', { type: 'checkbox', id: id('checked') });
    const where = el('input', { id: id('checked-url'), type: 'url', value: '' });
    const why = el('textarea', { id: id('why'), rows: '2', maxlength: '1000' });
    const msg = el('p', { class: 'msg', role: 'status', hidden: true });
    const say = (text, kind) => { msg.className = 'msg ' + kind; msg.textContent = text; msg.hidden = false; };
    form.append(el('fieldset', { class: 'checks save-box' }, el('legend', { text: 'Save' }),
      el('label', { class: 'inline' }, checkedBox, 'I have checked these details are current (with the provider or its website)'),
      el('div', { class: 'field' }, el('label', { for: id('checked-url'), text: 'Where you checked (optional web address)' }), where),
      el('div', { class: 'field' }, el('label', { for: id('why'), text: 'What changed and why' }), why),
      el('div', { class: 'row-end' },
        el('button', { type: 'submit', class: 'btn primary small', text: 'Save changes' }),
        el('button', { type: 'button', class: 'btn secondary small', text: 'Cancel', onclick: () => { editing.delete(s.id); refreshOne(x); } }),
        msg)));

    form.querySelector('#' + CSS.escape(id('open'))).value = val('open') === false ? 'no' : 'yes';
    form.querySelector('#' + CSS.escape(id('level'))).value = val('level');
    form.querySelector('#' + CSS.escape(id('reviewCycle'))).value = val('reviewCycle');
    form.querySelector('#' + CSS.escape(id('sr-allowed'))).value = sr.allowed;

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const q = (k) => form.querySelector('#' + CSS.escape(id(k)));
      const out = {};
      for (const k of TEXT_FIELDS) out[k] = q(k).value.trim();
      for (const k of AREA_FIELDS) out[k] = q(k).value.trim();
      for (const k of ['age', 'phone', 'webpage', 'email', 'cost', 'languages', 'notes']) out[k] = out[k] || null;
      out.open = q('open').value === 'yes';
      out.level = q('level').value;
      out.reviewCycle = q('reviewCycle').value;
      for (const k of CHECK_FIELDS) out[k] = [...q(k).querySelectorAll('input:checked')].map((i) => i.value);
      for (const k of LINE_FIELDS) out[k] = q(k).value.split('\n').map((l) => l.trim()).filter(Boolean);
      const srOut = { allowed: q('sr-allowed').value, note: q('sr-note').value.trim() };
      if (q('sr-url').value.trim()) srOut.url = q('sr-url').value.trim();
      out.selfReferral = srOut;
      out.activities = [...acts.querySelectorAll('.act')].map((r) => ({ name: r.querySelector('.act-name').value.trim(), summary: r.querySelector('.act-summary').value.trim(), duration: r.querySelector('.act-duration').value.trim() }));

      // Only what differs from the data is sent, with what the data said, so a later change can be spotted.
      const changes = {};
      const before = {};
      for (const [k, v] of Object.entries(out)) if (norm(s[k]) !== norm(v)) { changes[k] = v; before[k] = s[k] === undefined ? null : s[k]; }
      const by = $('#by').value.trim();
      for (const k of REQUIRED) if (!out[k]) { q(k).focus(); return say(FIELD_LABEL[k] + " can't be empty.", 'err'); }
      if (!Object.keys(changes).length) return say(edits[s.id] ? 'Nothing differs from the data. Use "Discard these changes" to drop the waiting changes.' : 'Nothing has changed.', 'err');
      if (!by) { $('#by').focus(); return say('Please put your name or initials at the top of the page first.', 'err'); }
      if (why.value.trim().length < 3) { why.focus(); return say('Please say briefly what changed and why.', 'err'); }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const d = await api('PUT', '/log/edits/' + encodeURIComponent(s.id), { changes, before, note: why.value.trim(), by, checked: checkedBox.checked, checkedUrl: where.value.trim() });
        edits[s.id] = d.item;
        editing.delete(s.id);
        refreshOne(x);
        summary();
        const again = document.getElementById('svc-' + s.id);
        const w = again && again.querySelector('.waiting');
        if (w) { w.prepend(el('p', { class: 'msg ok', text: 'Saved. The changes will reach the finder once they are applied.' })); w.scrollIntoView({ block: 'nearest' }); }
      } catch (err) {
        btn.disabled = false;
        if (err.status === 401) return signOut('Your session has ended. Please enter the passcode again.');
        say(err.message, 'err');
      }
    });
    return el('section', { class: 'edit', 'aria-label': 'Edit ' + s.name }, el('h4', { text: 'Edit details' }),
      el('p', { class: 'hint', text: 'Changes are saved for the team straight away and reach the finder once applied. Boxes still marked "' + PLACEHOLDER + '" are highlighted.' }), form);
  }

  function refreshOne(x) {
    const old = document.getElementById('svc-' + x.s.id);
    if (!old) return;
    const open = old.querySelector('details') && old.querySelector('details').open;
    const fresh = entry(x);
    if (open) fresh.querySelector('details').open = true;
    old.replaceWith(fresh);
  }

  async function api(method, path, body) {
    if (!API) throw Object.assign(new Error('This page has not been connected to the Worker yet.'), { status: 0 });
    let res;
    try {
      res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', 'x-team-passcode': pass }, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('Could not save. Please check your connection.'), { status: 0 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
    return data;
  }

  function showSignedIn() {
    const by = $('#by').value.trim();
    $('#signin-form').hidden = Boolean(team);
    $('#signed-in').hidden = !team;
    $('#export-decisions').hidden = !team;
    $('#signed-in-text').textContent = team ? 'Signed in' + (by ? ' as ' + by : '') + '. ' + plural(Object.keys(team).length, 'decision', 'decisions') + ' and ' + plural(Object.keys(edits || {}).length, 'edited service', 'edited services') + ' so far.' : '';
  }

  async function signIn(candidate) {
    pass = candidate;
    const msg = $('#signin-msg');
    msg.hidden = true;
    try {
      const [d, e] = await Promise.all([api('GET', '/log/decisions'), api('GET', '/log/edits')]);
      team = d.decisions || {};
      edits = e.edits || {};
    } catch (e) {
      team = null;
      edits = null;
      pass = '';
      store.del(PASS_KEY);
      msg.textContent = e.status === 404 ? 'Decisions are not switched on yet (the team passcode has not been set). Ask Phil.' : e.status === 401 ? 'That passcode is not right.' : e.message;
      msg.hidden = false;
      showSignedIn();
      return;
    }
    store.set(PASS_KEY, pass);
    $('#pass').value = '';
    showSignedIn();
    summary();
    update();
  }

  function signOut(message) {
    team = null;
    edits = null;
    editing.clear();
    pass = '';
    store.del(PASS_KEY);
    showSignedIn();
    if (message) { $('#signin-msg').textContent = message; $('#signin-msg').hidden = false; }
    summary();
    update();
  }

  function exportDecisions() {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), decisions: team || {}, edits: edits || {} }, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'service-finder-team-changes-' + new Date().toISOString().slice(0, 10) + '.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Summary figures. Each one is a button that applies the matching filter.
  function summary() {
    const n = (f) => services.filter(f).length;
    const stats = [
      [services.length, 'services in total', {}],
      [n((x) => x.listing === 'include'), 'on the live list', { listing: 'include' }],
      [n((x) => x.listing === 'review'), 'waiting for review', { listing: 'review' }],
      [n((x) => x.listing === 'exclude'), 'excluded', { listing: 'exclude' }],
      ...(team ? [
        [n((x) => teamState(x) === 'undecided'), 'not yet decided by the team', { decision: 'undecided' }],
        [n((x) => teamState(x) === 'pending'), 'decided, waiting to be applied', { decision: 'pending' }],
        [n((x) => editState(x) === 'pending'), 'with edited details waiting to be applied', { decision: 'edited' }],
      ] : []),
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
    const head = ['ID', 'Name', 'Organisation', 'Live list', 'Why (in the data)', 'Team decision', 'Team note', 'Decided by', 'Decided on', 'Details edited (waiting)', 'HWL scheme', 'Level', 'Open', 'Review', 'Last checked', 'Days since check', 'Confidence',
      'Who it\'s for', 'Age', 'Audience', 'Health focus', 'Gate', 'Eligibility', 'Phone', 'Email', 'Web page', 'How to get in', 'Self-referral',
      'Areas', 'Categories', 'Locations', 'Cost', 'Languages', 'Source', 'Found via', 'Checked against', 'Evidence', 'File'];
    const lines = [head.map(csvCell).join(',')];
    for (const x of shown()) {
      const s = x.s, p = s.provenance || {};
      const t = (team && team[s.id]) || {};
      lines.push([s.id, s.name, s.organisation, LISTING[x.listing][0], s.listing && s.listing.reason, t.decision ? CHOICE[t.decision] : '', t.note, t.by, t.t ? t.t.slice(0, 10) : '', editState(x) === 'pending' ? Object.keys(edits[s.id].changes).map((k) => FIELD_LABEL[k] || k).join(', ') + ' (' + edits[s.id].by + ')' : '', s.hwlFunded ? 'Yes' : 'No', LEVEL[s.level], s.open ? 'Yes' : 'No', REVIEW[x.review][0], s.lastUpdated,
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
  // services-all.json (every service) is published with the MVP pages; fall back to the live list if it's missing.
  const getJson = (u) => fetch(u).then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });
  getJson('services-all.json')
    .catch(() => getJson('../services.json'))
    .then((d) => {
      choices = d.choices || {};
      services = list(d.services).map((s) => ({ s, listing: listing(s), incomplete: JSON.stringify(s).includes(PLACEHOLDER), review: review(s), confidence: confidence(s), gaps: gaps(s), text: haystack(s) }));
      const all = services.map((x) => x.s);
      fill(input.area, all.flatMap((s) => list(s.areas)));
      fill(input.category, all.flatMap((s) => list(s.categories)));
      fill(input.health, all.flatMap((s) => (list(s.healthFocus).length ? s.healthFocus : ['none'])), (h) => HEALTH[h] || h);
      fill(input.audience, all.flatMap((s) => list(s.audience)), (a) => a[0].toUpperCase() + a.slice(1));
      readUrl();
      summary();
      update();
      if (pass) signIn(pass);
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
  $('#export-decisions').addEventListener('click', exportDecisions);
  $('#by').value = store.get(BY_KEY);
  $('#by').addEventListener('change', () => { store.set(BY_KEY, $('#by').value.trim()); showSignedIn(); });
  $('#unlock').addEventListener('click', () => { if ($('#pass').value) signIn($('#pass').value); });
  $('#pass').addEventListener('keydown', (e) => { if (e.key === 'Enter' && $('#pass').value) signIn($('#pass').value); });
  $('#lock').addEventListener('click', () => signOut(''));
})();
