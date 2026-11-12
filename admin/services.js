// All services: a searchable, filterable list of every scheme and service (services-all.json, which includes
// those not on the live list), for the development team to check what's there, what's missing and what needs reviewing,
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
  // One passcode for all the Admin pages, shared through team-auth.js.
  const AUTH = window.TEAM_AUTH || { PASS_KEY: 'hwlTeamPass', BY_KEY: 'hwlLogBy', refresh: () => {} };
  const PASS_KEY = AUTH.PASS_KEY;
  const BY_KEY = AUTH.BY_KEY;
  const PLACEHOLDER = 'To be completed';
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
  };
  let pass = store.get(PASS_KEY);
  let team = null; // { <service id>: { decision, note, by, t, history } } once signed in
  let edits = null; // { <service id>: { changes, before, note, by, t, checked, checkedUrl, history } } once signed in
  let added = null; // { <new id>: { service, note, by, created, createdBy, t, checkedUrl, history } } once signed in
  let baseServices = []; // the services in the data; services = these plus new ones waiting to be added
  let choices = {}; // the allowed values for the edit form, from services-all.json
  let organisations = []; // every organisation record (data/organisations.json), from services-all.json
  let venues = []; // every venue record (data/venues.json), from services-all.json
  let venueChanges = null; // { <venue id>: { changes, before, note, by, t } } waiting to be applied, once signed in
  let orgChanges = null; // { <organisation id>: { changes, before, note, by, t } } waiting to be applied, once signed in
  const editing = new Set(); // services whose edit form is open
  let plinks = null; // provider review links (providerlink.js in the Worker), once signed in
  const prefill = {}; // <service id> -> { changes, note } from a provider's reply, opened in the edit form
  const sending = new Set(); // services whose "send to provider" form is open

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
  const LISTING = { include: ['On the live list', 'ok'], review: ['Waiting for review', 'warn'], exclude: ['Excluded', 'bad'], new: ['New: not yet in the data', 'blue'] };
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
  // Compares values whatever order an object's keys are in, treating empty as missing.
  const canon = (v) => {
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return null;
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]).filter(([, x]) => x !== null));
    return v;
  };
  const norm = (v) => JSON.stringify(canon(v));
  const LL = globalThis.LISTING; // shared project and date rules (../listing-logic.js)
  function editState(x) {
    const e = edits && edits[x.s.id];
    if (!e) return 'none';
    // Only "checked and still right" (no changes): applied once the data's last-checked date has caught up.
    if (!Object.keys(e.changes).length) return e.checked && String(x.s.lastUpdated || '') < String(e.t).slice(0, 10) ? 'pending' : 'applied';
    const want = settleVenues(e.changes);
    return Object.keys(e.changes).every((k) => norm(x.s[k]) === norm(want[k])) ? 'applied' : 'pending';
  }
  // A venue written out in a change ({ name, address, postcode }) reads as the venue now in the data with the same
  // address, once applied (the same matching as scripts/apply-decisions.mjs).
  const squash = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function venueIdOf(v) {
    if (!v || typeof v !== 'object') return v;
    const f = venues.find((x) => x.postcode === v.postcode && (squash(x.address) === squash(v.address) || x.name.toLowerCase() === String(v.name).toLowerCase()));
    return f ? f.id : v;
  }
  function settleVenues(c) {
    const out = { ...c };
    if (Array.isArray(out.venues)) out.venues = [...new Set(out.venues.map(venueIdOf))];
    if (Array.isArray(out.projects)) out.projects = out.projects.map((p) => (p.sessions ? { ...p, sessions: p.sessions.map((x) => (x.venue ? { ...x, venue: venueIdOf(x.venue) } : x)) } : p));
    return out;
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
    if (LL.endingSoon(s).length) g.add('ending');
    if (LL.closedParts(s).length) g.add('ended');
    if (LL.parts(s).some((x) => x.state === 'later' || x.sessions.some((c) => c.state === 'later'))) g.add('opening');
    // The timetable: projects with no days or times yet, and services that haven't said who they're for.
    if (list(s.projects).some((p) => !list(p.sessions).some((x) => list(x.days).length) && !list(p.runs).every((r) => r !== 'set'))) g.add('no-times');
    if (!list(s.groups).length) g.add('no-groups');
    if (list(s.projects).some((p) => list(p.sessions).some((x) => x.note && !list(x.days).length))) g.add('times-in-words');
    if (tooLong(s).length) g.add('too-long');
    if (!s.organisationOverview) g.add('no-org-overview');
    return g;
  }
  // Text written before the character limits that is longer than them now. Kept as it is; flagged to shorten.
  function tooLong(s) {
    const out = [];
    if (s.whoFor && s.whoFor.length > LL.LIMITS.whoFor) out.push('Who it\'s for (' + s.whoFor.length + ' of ' + LL.LIMITS.whoFor + ')');
    if (s.organisationOverview && s.organisationOverview.length > LL.LIMITS.orgOverview) out.push('Organisation overview (' + s.organisationOverview.length + ' of ' + LL.LIMITS.orgOverview + ')');
    if (s.coachNotes && s.coachNotes.length > LL.LIMITS.coachNotes) out.push('Anything coaches should know (' + s.coachNotes.length + ' of ' + LL.LIMITS.coachNotes + ')');
    for (const p of list(s.projects)) if (p.overview && p.overview.length > LL.LIMITS.projectOverview) out.push('Overview of "' + p.name + '" (' + p.overview.length + ' of ' + LL.LIMITS.projectOverview + ')');
    return out;
  }

  // Everything searchable, lower-cased once.
  function haystack(s) {
    const p = s.provenance || {};
    return [
      s.id, s.name, s.organisation, s.organisationOverview, s.whoFor, s.age, s.phone, s.email, s.webpage, s.cost, s.languages, s.notes, s.coachNotes, s.workExperience,
      ...list(s.categories), ...list(s.areas), ...list(s.locations), ...list(s.eligibility), ...list(s.exclusions), ...list(s.gate),
      ...list(s.referralRoutes), ...list(s.healthFocus).map((h) => HEALTH[h] || h), ...list(s.audience), LEVEL[s.level],
      s.hwlFunded ? 'healthy working life hwl' : '', s.selfReferral && s.selfReferral.note,
      ...list(s.projects).flatMap((a) => [a.name, a.overview, a.duration, a.when, a.places, a.age, ...list(a.where), ...list(a.eligibility), ...list(a.gate),
        ...list(a.sessions).flatMap((c) => [c.name, c.when, c.note, c.places, c.age, ...list(c.days).map((d) => LL.DAY_NAMES[d]), ...list(c.where), ...list(c.eligibility), ...list(c.gate), ...venueWords(c.venue)])]),
      ...list(s.venues).flatMap(venueWords), ...list(s.groups).map((g) => LL.GROUPS[g] || g),
      p.source, p.status, p.foundVia, p.evidence, s.listing && s.listing.reason,
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

  const ORDER = { new: -1, review: 0, include: 1, exclude: 2 };
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

  const partName = (x) => x.project.name + (x.session ? ' (' + (x.session.name || LL.timeWords(x.session) || 'a session') + ')' : '');
  // A venue's name, address and ward, for search and the timetable.
  const venueWords = (v) => {
    const x = typeof v === 'string' ? venueById(v) : v;
    return x ? [x.name, x.address, x.postcode, x.ward].filter(Boolean) : [];
  };
  const venueById = (id) => venues.find((v) => v.id === id);
  const venueText = (v) => {
    const x = typeof v === 'string' ? venueById(v) : v;
    if (!x) return typeof v === 'string' ? v + ' (not in the venues list)' : '';
    return LL.venueLine(x) + (x.ward ? ' (' + x.ward + ' ward)' : x.id ? ' (ward not looked up yet)' : ' (new venue)');
  };
  // Projects and sessions with what is set for each, and whether they show today.
  const STATE_WORDS = { open: 'Showing', soon: 'Showing: referrals open soon', later: 'Not shown yet: referrals open later', closed: 'Closed: not shown' };
  function projectList(s) {
    return LL.parts(s).map((x) => {
      const p = x.project;
      const bits = (o, dates, st) => [
        list(o.runs).length ? 'Runs: ' + o.runs.map((r) => LL.RUNS[r] || r).join(', ') : '', o.area ? 'Area: ' + o.area : '',
        o.where && o.where.length ? 'Where: ' + o.where.join('; ') : '', o.when ? 'When: ' + o.when : '', o.duration ? 'How long: ' + o.duration : '', o.places ? o.places : '',
        o.age ? 'Age ' + o.age : '', list(o.eligibility).length ? 'Extra criteria: ' + o.eligibility.join('; ') : '', list(o.gate).length ? 'Essential: ' + o.gate.join('; ') : '',
        list(o.audience).length ? 'Works with: ' + o.audience.join(', ') : '', ...LL.dateWords(dates), STATE_WORDS[st],
      ].filter(Boolean).join('. ');
      const sess = [...x.sessions].sort((a2, b2) => LL.byDay(a2.session, b2.session));
      return el('div', { class: 'proj' },
        el('strong', { text: p.name }), el('code', { class: 'pid', text: p.id }), ': ' + (p.overview || ''),
        el('p', { class: 'hint', text: bits(p, x.dates, x.state) }),
        sess.length ? el('table', { class: 'timetable' },
          el('thead', {}, el('tr', {}, ['Session', 'Day and time', 'Venue', 'For', 'Dates'].map((h) => el('th', { scope: 'col', text: h })))),
          el('tbody', {}, sess.map((c) => {
            const se = c.session;
            const when = LL.timeWords(se);
            return el('tr', {},
              el('td', {}, se.name || '', ' ', el('code', { class: 'pid', text: se.id })),
              el('td', {}, when || el('span', { class: 'gap', text: se.note ? 'In words: ' + se.note : 'Not given' })),
              el('td', { text: [se.venue ? venueText(se.venue) : '', ...list(se.where)].filter(Boolean).join('; ') || '' }),
              el('td', { text: [se.age ? 'Age ' + se.age : '', ...list(se.eligibility)].filter(Boolean).join('; ') }),
              el('td', { text: [...LL.dateWords(c.dates), STATE_WORDS[c.state]].join('. ') }));
          }))) : null);
    });
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
      x.isNew ? el('span', { class: 'pill', text: 'Added by ' + x.entry.createdBy + ', ' + when(x.entry.created) }) : null,
      state === 'pending' ? el('span', { class: 'pill blue', text: 'Team chose: ' + CHOICE[t.decision].toLowerCase() + ' (waiting to be applied)' }) : null,
      editState(x) === 'pending' ? el('span', { class: 'pill blue', text: (Object.keys(edits[s.id].changes).length ? 'Details edited by ' : 'Checked as current by ') + edits[s.id].by + ' (waiting to be applied)' }) : null,
      providerNews(x) ? el('span', { class: 'pill warn', text: 'Provider replied: ' + providerNews(x) }) : null,
      x.incomplete ? el('span', { class: 'pill warn', text: 'Details to be completed' }) : null,
      s.hwlFunded ? el('span', { class: 'pill blue', text: 'HWL scheme' }) : null,
      el('span', { class: 'pill', text: LEVEL[s.level] || s.level }),
      el('span', { class: 'pill ' + revClass, text: revText }),
      s.selfReferral ? el('span', { class: 'pill' + (s.selfReferral.allowed === 'yes' ? ' ok' : ''), text: SELF[s.selfReferral.allowed] || s.selfReferral.allowed }) : null,
      x.confidence === 'medium' || x.confidence === 'low' ? el('span', { class: 'pill warn', text: 'Confidence: ' + x.confidence }) : null,
      x.gaps.has('mention') ? el('span', { class: 'pill', text: 'Only shown when mentioned' }) : null,
      x.gaps.has('no-contact') ? el('span', { class: 'pill bad', text: 'No contact details' }) : null,
      ...LL.endingSoon(s).map((e) => el('span', { class: 'pill warn', text: partName(e) + (e.kind === 'ends' ? ' ends ' : ' stops taking referrals ') + LL.longDate(e.date) })),
      ...LL.closedParts(s).map((c) => el('span', { class: 'pill bad', text: partName(c) + ' has closed: no longer shown' })),
      x.gaps.has('too-long') ? el('span', { class: 'pill warn', text: 'Text over the character limits' }) : null
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
    row(dl, 'Projects', projectList(s));
    row(dl, 'Places used by every project', list(s.locations));
    row(dl, 'Areas', list(s.areas).join(', '));
    row(dl, 'Categories', list(s.categories).join(', '));
    row(dl, 'Work experience', s.workExperience);
    row(dl, 'Cost', s.cost);
    row(dl, 'Languages and formats', s.languages);
    row(dl, 'Anything coaches should know', s.coachNotes);
    row(dl, 'Team notes', s.notes ? el('span', { class: 'pre', text: s.notes }) : null);
    row(dl, 'Taking new referrals', s.open ? 'Yes' : 'No (never recommended)');
    row(dl, 'Organisation overview', s.organisationOverview || el('span', { class: 'gap', text: 'None yet' }));
    row(dl, 'Over the character limits', tooLong(s));
    if (x.gaps.has('mention')) row(dl, 'Only shown if the person mentions', list(s.requiresMention).slice(0, 8).join(', ') + (s.requiresMention.length > 8 ? ' and ' + (s.requiresMention.length - 8) + ' more' : ''));
    row(dl, 'Source', p.source);
    row(dl, 'Found via', p.foundVia);
    row(dl, 'Checked against', p.checkedUrl ? link(p.checkedUrl, p.checkedUrl) : null);
    row(dl, 'Evidence it\'s current', p.evidence);
    row(dl, 'Status in the October 2026 research', p.status);
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
      x.isNew ? el('div', { class: 'waiting' }, el('p', { class: 'mt0' }, el('strong', { text: 'New service waiting to be added' }), ' (last saved by ' + x.entry.by + ', ' + when(x.entry.t) + '): ' + x.entry.note),
        el('p', { class: 'hint', text: 'It becomes a file in the data, waiting for review, when the team\'s changes are next applied. If the team has decided to include it, it goes on the live list at the same time.' })) : null,
      edits && !x.isNew && editState(x) === 'pending' ? waitingChanges(x) : null,
      plinks && !x.isNew ? providerPanel(x) : null,
      edits ? (editing.has(s.id) ? editForm(x, x.isNew ? 'new' : 'edit') : el('p', { class: 'edit-open' },
        el('button', { type: 'button', class: 'btn secondary small', text: 'Edit details', onclick: () => { editing.add(s.id); refreshOne(x); const f = document.getElementById('ed-' + s.id + '-name'); if (f) f.focus(); } }),
        x.isNew ? el('button', { type: 'button', class: 'btn secondary small', text: 'Discard this new service', onclick: () => discardNew(x) }) : null)) : null,
      el('p', { class: 'meta', text: 'Last checked ' + fmt(s.lastUpdated) + ' (' + plural(days, 'day', 'days') + ' ago). Areas: ' + list(s.areas).join(', ') + '. ' + list(s.categories).join(', ') + '.' }),
      el('details', {},
        el('summary', { text: 'Full details' }),
        dl,
        x.isNew ? null : el('p', { class: 'links' },
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
    name: 'Name of the service', organisation: 'Organisation', organisationOverview: 'Organisation overview', open: 'Taking new referrals', level: 'Level', whoFor: 'Who your service is for', age: 'Age',
    webpage: 'Website', email: 'Email', phone: 'Phone', social: 'Social media', locations: 'Places used by every project',
    areas: 'Where it runs', audience: 'Who do you work with?', categories: 'Categories', healthFocus: 'Health focus', eligibility: 'Who can use your service', exclusions: "Who you can't support",
    gate: 'Would turn someone away for not having', referralRoutes: 'How to get in', selfReferral: 'Self-referral', projects: 'Projects', workExperience: 'Work experience',
    cost: 'Cost', languages: 'Languages and formats', coachNotes: 'Anything coaches should know', notes: 'Team notes', reviewCycle: 'Review cycle',
    hwlFunded: 'Healthy Working Life funded', mapLinks: 'Map buttons', logo: 'Logo', requiresMention: 'Only shown when mentioned',
    // Older names, for changes saved before November 2026.
    status: 'Status', activities: 'What it offers',
  };

  // A project list in a few words, for "old → new" in the changes waiting.
  function projectWords(ps) {
    return list(ps).map((p) => {
      const d = LL.dateWords(LL.datesOf(p, null));
      const cs = list(p.sessions).map((c) => [c.name, LL.timeWords(c) || c.note, c.venue ? venueText(c.venue) : '', c.age ? 'age ' + c.age : '', ...LL.dateWords(LL.datesOf(p, c))].filter(Boolean).join(', '));
      return (p.name || '') + (p.overview || p.summary ? ': ' + (p.overview || p.summary) : '') + (p.where && p.where.length ? ' Where: ' + p.where.join('; ') + '.' : '') + (p.when ? ' When: ' + p.when + '.' : '') + (p.places ? ' ' + p.places + '.' : '') + (p.age ? ' Age ' + p.age + '.' : '') + (list(p.eligibility).length ? ' Extra criteria: ' + p.eligibility.join('; ') + '.' : '') + (list(p.gate).length ? ' Turned away without: ' + p.gate.join('; ') + '.' : '') + (d.length ? ' ' + d.join(', ') + '.' : '') + (cs.length ? ' Sessions: ' + cs.join('; ') + '.' : '');
    }).join(' | ');
  }

  function waitingChanges(x) {
    const e = edits[x.s.id];
    const fmtVal = (v, k) => (k === 'projects' || k === 'activities' ? projectWords(v) || '(none)' : v == null || v === '' ? '(none)' : Array.isArray(v) ? (v.length ? v.join('; ') : '(none)') : typeof v === 'object' ? (SELF[v.allowed] || v.allowed) + '. ' + v.note + (v.url ? ' ' + v.url : '') : v === true ? 'Yes' : v === false ? 'No' : String(v));
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
      Object.keys(e.changes).length ? null : el('p', { text: 'No changes to the details: the last-checked date moves on when applied.' }),
      el('dl', { class: 'facts' }, Object.keys(e.changes).flatMap((k) => [el('dt', { text: FIELD_LABEL[k] || k }),
        el('dd', {}, el('del', { text: fmtVal(x.s[k], k) }), ' → ', el('ins', { text: fmtVal(e.changes[k], k) }))])),
      discard);
  }

  // ---------- provider review links ----------
  // A private link for one named contact at a scheme (site/provider-check.html#<code>). They check every detail and
  // reply "all correct" or with changes. Replies wait here; the team saves them as an ordinary edit.
  const linksFor = (id) => (plinks || []).filter((l) => l.id === id).sort((a, b) => b.created.localeCompare(a.created));
  const linkUrl = (l) => new URL('../provider-check.html', location.href).href + '#' + l.token;
  const linkState = (l) => (l.cancelled ? 'cancelled' : Date.parse(l.expires) < Date.now() ? 'expired' : 'active');
  // The newest reply the team hasn't acted on yet (nothing saved for the service since).
  function newestReply(id) {
    const replies = linksFor(id).flatMap((l) => l.replies.map((r) => ({ ...r, link: l }))).sort((a, b) => b.t.localeCompare(a.t));
    const r = replies[0];
    const e = edits && edits[id];
    return { reply: r || null, handled: Boolean(r && e && e.t > r.t), count: replies.length };
  }
  function providerNews(x) {
    if (!plinks) return '';
    const { reply, handled } = newestReply(x.s.id);
    if (!reply || handled) return '';
    return reply.allCorrect ? 'all correct' : 'changes to review';
  }
  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const was = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = was; }, 2000);
    } catch {
      prompt('Copy this:', text);
    }
  }
  const emailText = (x, l) => `Subject: Please check your details on the Healthy Working Life Support Finder (${x.s.name})

Hello ${l.contact},

We're piloting the Healthy Working Life Support Finder with a very limited number of schemes at the moment. It's a tool that helps work and health coaches in Kirklees find the right support for the people they work with, and it includes ${x.s.name}.

Please could you check the details we hold about your service, and correct anything that's wrong or missing? It takes about 5 minutes. Use this link (it's just for you, so please don't share it):

${linkUrl(l)}

The link works until ${fmt(l.expires.slice(0, 10))}. We check any changes before they appear on the Support Finder.

Unless we've asked you to take part in the pilot, please don't use the Support Finder itself, or share it with anyone, until it's out of the pilot phase. It's crucial that we learn from the pilot sites first. We'll let you know when it's ready for everyone.

Thank you,
`;

  function providerPanel(x) {
    const s = x.s;
    const links = linksFor(s.id);
    const live = x.listing === 'include';
    const by = () => $('#by').value.trim();
    const msg = el('p', { class: 'msg', role: 'status', hidden: true });
    const say = (text, kind) => { msg.className = 'msg ' + kind; msg.textContent = text; msg.hidden = false; };
    const fail = (err) => { if (err.status === 401) return signOut('Your session has ended. Please enter the passcode again.'); say(err.message, 'err'); };
    const box = el('fieldset', { class: 'decide provider' }, el('legend', { text: 'Check with the provider' }));

    // The newest reply first, with what to do about it.
    const { reply: r, handled, count } = newestReply(s.id);
    if (r) {
      const fmtVal = (v, k) => (k === 'projects' || k === 'activities' ? projectWords(v) || '(none)' : v == null || v === '' ? '(none)' : Array.isArray(v) ? (v.length ? v.join('; ') : '(none)') : typeof v === 'object' ? (SELF[v.allowed] || v.allowed) + '. ' + v.note + (v.url ? ' ' + v.url : '') : v === true ? 'Yes' : v === false ? 'No' : String(v));
      const keys = Object.keys(r.changes || {});
      const who = r.name + (r.name !== r.link.contact ? ' (link sent to ' + r.link.contact + ')' : '');
      const recordChecked = el('button', { type: 'button', class: 'btn primary small', text: 'Record as checked with the provider', onclick: async () => {
        if (!by()) { $('#by').focus(); return say('Please put your name or initials at the top of the page first.', 'err'); }
        if (editState(x) === 'pending' && !confirm('There are changes waiting for this service already. Recording it as checked replaces them. Carry on?')) return;
        recordChecked.disabled = true;
        try {
          const d = await api('PUT', '/log/edits/' + encodeURIComponent(s.id), { changes: {}, before: {}, by: by(), checked: true, checkedUrl: '',
            note: 'Checked with ' + r.name + ' (provider) using a review link, ' + fmt(r.t.slice(0, 10)) + ': everything correct.' + (r.note ? ' They added: ' + r.note : '') });
          edits[s.id] = d.item;
          refreshOne(x);
          summary();
        } catch (err) { recordChecked.disabled = false; fail(err); }
      } });
      const review = el('button', { type: 'button', class: 'btn primary small', text: 'Review these in Edit details', onclick: () => {
        prefill[s.id] = { changes: r.changes || {}, note: 'From ' + r.name + ' (provider) using a review link, ' + fmt(r.t.slice(0, 10)) + '.' + (r.note ? ' They said: ' + r.note : '') };
        editing.add(s.id);
        refreshOne(x);
        const f = document.querySelector('#svc-' + CSS.escape(s.id) + ' .edit');
        if (f) { f.scrollIntoView({ block: 'start' }); const first = f.querySelector('input, textarea, select'); if (first) first.focus(); }
      } });
      box.append(el('div', { class: 'reply' + (handled ? ' handled' : '') },
        el('p', { class: 'mt0' }, el('strong', { text: r.allCorrect ? 'Provider said everything is correct' : keys.length ? 'Provider sent changes' : 'Provider sent a comment' }),
          ' (' + who + ', ' + when(r.t) + ')' + (count > 1 ? '. ' + plural(count, 'reply', 'replies') + ' in all; this is the newest.' : '.')),
        r.note ? el('p', {}, el('em', { text: '"' + r.note + '"' })) : null,
        keys.length ? el('dl', { class: 'facts' }, keys.flatMap((k) => [el('dt', { text: FIELD_LABEL[k] || k }),
          el('dd', {}, el('del', { text: fmtVal(r.before ? r.before[k] : s[k], k) }), ' → ', el('ins', { text: fmtVal(r.changes[k], k) }))])) : null,
        handled ? el('p', { class: 'hint', text: 'The team has saved changes for this service since this reply.' }) : null,
        el('div', { class: 'row-end' }, r.allCorrect ? recordChecked : keys.length ? review : null)));
    }

    // Links already made.
    if (links.length) {
      box.append(el('ul', { class: 'plinks' }, links.map((l) => {
        const st = linkState(l);
        const copyBtn = el('button', { type: 'button', class: 'btn secondary small', text: 'Copy link', onclick: (ev) => copy(linkUrl(l), ev.currentTarget) });
        const mailBtn = el('button', { type: 'button', class: 'btn secondary small', text: 'Copy an email to send', onclick: (ev) => copy(emailText(x, l), ev.currentTarget) });
        const cancelBtn = el('button', { type: 'button', class: 'btn secondary small', text: 'Cancel link', onclick: async () => {
          if (!by()) { $('#by').focus(); return say('Please put your name or initials at the top of the page first.', 'err'); }
          if (!confirm('Cancel the link for ' + l.contact + '? It stops working straight away. Their replies are kept.')) return;
          try {
            const d = await api('POST', '/log/provider-links/' + l.token + '/cancel', { by: by() });
            Object.assign(l, d.link);
            refreshOne(x);
          } catch (err) { fail(err); }
        } });
        const stateText = st === 'active' ? 'works until ' + fmt(l.expires.slice(0, 10)) : st === 'expired' ? 'expired ' + fmt(l.expires.slice(0, 10)) : 'cancelled by ' + l.cancelled.by + ', ' + when(l.cancelled.t);
        return el('li', { class: 'plink ' + st },
          el('span', { text: 'Link for ' + l.contact + ' (made by ' + l.by + ', ' + when(l.created) + '): ' + stateText + '. ' + (l.replies.length ? plural(l.replies.length, 'reply', 'replies') + '.' : 'No reply yet.') }),
          st === 'active' ? el('span', { class: 'row-end' }, copyBtn, mailBtn, cancelBtn) : null);
      })));
    }

    // Making a new link.
    if (!live) {
      box.append(el('p', { class: 'hint', text: 'Provider links can only be made for services on the live list.' }));
    } else if (sending.has(s.id)) {
      const who = el('input', { type: 'text', id: 'pl-who-' + s.id, maxlength: '80', autocomplete: 'off' });
      const days = el('select', { id: 'pl-days-' + s.id }, [14, 30, 60, 90].map((d) => el('option', { value: String(d), text: d + ' days', selected: d === 30 })));
      const make = el('button', { type: 'button', class: 'btn primary small', text: 'Make the link', onclick: async () => {
        if (who.value.trim().length < 2) { who.focus(); return say("Give the name of the person you're sending it to.", 'err'); }
        if (!by()) { $('#by').focus(); return say('Please put your name or initials at the top of the page first.', 'err'); }
        make.disabled = true;
        try {
          const d = await api('POST', '/log/provider-links', { id: s.id, contact: who.value.trim(), days: Number(days.value), by: by() });
          plinks.push(d.link);
          sending.delete(s.id);
          refreshOne(x);
          const again = document.querySelector('#svc-' + CSS.escape(s.id) + ' .provider');
          if (again) again.append(el('p', { class: 'msg ok', text: 'Link made. Use "Copy an email to send" (or "Copy link") and email it to ' + d.link.contact + ' yourself.' }));
        } catch (err) { make.disabled = false; fail(err); }
      } });
      box.append(el('div', { class: 'edit-grid' },
        el('div', { class: 'field' }, el('label', { for: who.id, text: 'Name of the person at the service' }), who, el('p', { class: 'hint', text: 'Just their name. Don\'t put their email address here.' })),
        el('div', { class: 'field' }, el('label', { for: days.id, text: 'Link works for' }), days)),
        el('div', { class: 'row-end' }, make, el('button', { type: 'button', class: 'btn secondary small', text: 'Cancel', onclick: () => { sending.delete(s.id); refreshOne(x); } })));
      setTimeout(() => who.focus(), 0);
    } else {
      box.append(el('p', { class: 'hint mt0', text: links.length ? '' : 'Send the provider a private link to check every detail of this service (including who it\'s for and who can\'t use it) and send corrections. Their reply comes back here for the team to check.' }),
        el('div', { class: 'row-end' }, el('button', { type: 'button', class: 'btn secondary small', text: links.length ? 'Make another link' : 'Send to provider for checking', onclick: () => { sending.add(s.id); refreshOne(x); } })));
    }
    box.append(msg);
    return box;
  }

  // mode: 'edit' a service in the data, 'new' a new service waiting to be added, or 'add' a brand new one.
  // The questions are the shared listing form (../listing-form.js), the same as the provider review page, plus the
  // team-only questions.
  function editForm(x, mode = 'edit') {
    const s = x.s;
    const teamPending = (mode === 'edit' && edits[s.id] && editState(x) === 'pending' && edits[s.id].changes) || {};
    const fromProvider = mode === 'edit' ? prefill[s.id] : null;
    const pending = fromProvider ? { ...teamPending, ...fromProvider.changes } : teamPending;
    const id = (k) => 'ed-' + s.id + '-' + k;
    const lf = LISTING_FORM.build({
      values: { ...s, ...pending }, original: s, mode: 'team', choices, organisations: orgNames(), venues, prefix: 'ed-' + s.id, headingLevel: mode === 'add' ? 3 : 5,
      onChange: () => lf && lf.mark(mode === 'edit' ? lf.changes() : {}),
    });
    if (mode === 'edit') lf.mark(lf.changes());
    const form = el('form', { class: 'edit-form lf', novalidate: true });
    let idBox = null;
    let idTouched = false;
    if (mode === 'add') {
      idBox = el('input', { id: id('newid'), type: 'text', maxlength: '50', value: '', oninput: () => { idTouched = true; } });
      form.append(el('div', { class: 'lf-field' }, el('label', { for: id('newid'), text: 'Id (used for the file name)' }), el('p', { class: 'hint', text: 'Made from the name. Lower-case letters, numbers and hyphens.' }), idBox));
      lf.node.querySelector('#' + CSS.escape(id('name'))).addEventListener('input', (ev) => { if (!idTouched) idBox.value = slug(ev.target.value); });
      if (s.name) idBox.value = slug(s.name);
    }
    form.append(lf.node);

    const checkedBox = el('input', { type: 'checkbox', id: id('checked'), checked: mode !== 'edit' || Boolean(fromProvider) });
    const where = el('input', { id: id('checked-url'), type: 'url', value: '' });
    const why = el('textarea', { id: id('why'), rows: '2', maxlength: '1000' });
    const msg = el('p', { class: 'msg', role: 'status', hidden: true });
    const say = (text, kind) => { msg.className = 'msg ' + kind; msg.textContent = text; msg.hidden = false; };
    if (mode !== 'edit') where.value = (added && added[s.id] && added[s.id].checkedUrl) || '';
    if (mode === 'new' && added[s.id]) why.value = added[s.id].note || '';
    if (mode === 'add' && x.why) why.value = x.why;
    if (fromProvider) why.value = fromProvider.note;
    const cancel = () => {
      delete prefill[s.id];
      if (mode === 'add') { $('#add-panel').replaceChildren(); $('#add-panel').hidden = true; $('#add-service').focus(); return; }
      editing.delete(s.id);
      refreshOne(x);
    };
    form.append(el('fieldset', { class: 'checks save-box' }, el('legend', { text: 'Save' }),
      mode === 'edit' ? el('label', { class: 'inline' }, checkedBox, 'I have checked these details are current (with the provider or its website)') : null,
      el('div', { class: 'field' }, el('label', { for: id('checked-url'), text: mode === 'edit' ? 'Where you checked (optional web address)' : 'Where you checked the details (optional web address)' }), where),
      el('div', { class: 'field' }, el('label', { for: id('why'), text: mode === 'edit' ? 'What changed and why' : 'Where this service came from, and why add it' }), why),
      el('div', { class: 'row-end' },
        el('button', { type: 'submit', class: 'btn primary small', text: mode === 'add' ? 'Add this service for review' : 'Save changes' }),
        el('button', { type: 'button', class: 'btn secondary small', text: 'Cancel', onclick: cancel }),
        msg)));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const out = lf.read();
      const problem = lf.check();
      if (problem) { if (problem.el && problem.el.focus) problem.el.focus(); return say(problem.message, 'err'); }
      const by = $('#by').value.trim();
      if (mode !== 'edit') return saveNew(out, by);

      // Only what differs from the data is sent, with what the data said, so a later change can be spotted.
      const changes = lf.changes();
      const before = {};
      for (const k of Object.keys(changes)) before[k] = s[k] === undefined ? null : s[k];
      if (!Object.keys(changes).length) return say(edits[s.id] ? 'Nothing differs from the data. Use "Discard these changes" to drop the waiting changes.' : 'Nothing has changed.', 'err');
      if (!by) { $('#by').focus(); return say('Please put your name or initials at the top of the page first.', 'err'); }
      if (why.value.trim().length < 3) { why.focus(); return say('Please say briefly what changed and why.', 'err'); }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const d = await api('PUT', '/log/edits/' + encodeURIComponent(s.id), { changes, before, note: why.value.trim(), by, checked: checkedBox.checked, checkedUrl: where.value.trim() });
        edits[s.id] = d.item;
        editing.delete(s.id);
        delete prefill[s.id];
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

    // A new service (added now, or waiting to be added): the whole service is saved, not just what changed.
    let dupeWarned = '';
    async function saveNew(out, by) {
      const newId = mode === 'add' ? idBox.value.trim() : s.id;
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(newId) || newId.length > 50) { if (idBox) idBox.focus(); return say('The id must be lower-case letters, numbers and single hyphens (up to 50).', 'err'); }
      if (mode === 'add' && (services.some((y) => y.s.id === newId))) { idBox.focus(); return say('A service with that id already exists. Choose another id.', 'err'); }
      if (!by) { $('#by').focus(); return say('Please put your name or initials at the top of the page first.', 'err'); }
      if (why.value.trim().length < 3) { why.focus(); return say('Please say briefly where this service came from and why it should be added.', 'err'); }
      if (mode === 'add') {
        const dupes = possibleDuplicates(out, newId);
        const key = dupes.map((y) => y.s.id).join();
        if (dupes.length && dupeWarned !== key) {
          dupeWarned = key;
          return say('This may already be listed: ' + dupes.slice(0, 4).map((y) => y.s.name + ' (' + y.s.organisation + ')').join('; ') + '. Check, then press "Add this service for review" again to add it anyway.', 'err');
        }
      }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const d = await api('PUT', '/log/new/' + encodeURIComponent(newId), { service: out, note: why.value.trim(), by, checkedUrl: where.value.trim() });
        added[newId] = d.item;
        editing.delete(newId);
        rebuild();
        if (mode === 'add') {
          $('#add-panel').replaceChildren();
          $('#add-panel').hidden = true;
          for (const f of FIELDS) if (f !== 'sort') input[f].value = '';
          input.listing.value = 'new';
        }
        summary();
        update();
        const again = document.getElementById('svc-' + newId);
        if (again) {
          again.querySelector('.waiting').prepend(el('p', { class: 'msg ok', text: mode === 'add' ? 'Added. The team can now review it, edit it and decide on it like any other service.' : 'Saved.' }));
          again.scrollIntoView({ block: 'nearest' });
        }
      } catch (err) {
        btn.disabled = false;
        if (err.status === 401) return signOut('Your session has ended. Please enter the passcode again.');
        say(err.message, 'err');
      }
    }

    const heading = mode === 'add' ? 'Add a service' : 'Edit details';
    const intro = mode === 'add'
      ? 'The new service is saved for the team straight away, as "New: not yet in the data". It is reviewed and decided on like any other, and becomes part of the data when the team\'s changes are next applied. It is never put live without a team decision to include it.'
      : (fromProvider && fromProvider.from === 'suggestion' ? 'The project from the suggestion is added at the end of "Projects" below. Check it with the service, add what is missing, then save. '
        : fromProvider ? 'The provider\'s changes are filled in below (on top of any changes already waiting). Check them, adjust anything, then save. ' : '') + 'Changes are saved for the team straight away and reach the finder once applied. Boxes still marked "' + PLACEHOLDER + '" are highlighted.';
    return el('section', { class: 'edit', 'aria-label': mode === 'add' ? heading : 'Edit ' + s.name }, el(mode === 'add' ? 'h2' : 'h4', { text: heading }), el('p', { class: 'hint', text: intro }),
      x.fromNote ? el('p', { class: 'msg warn from-suggestion', text: x.fromNote }) : null, form);
  }

  const slug = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
  const simple = (t) => String(t || '').toLowerCase().replace(/\b(the|and|of|for|in|ltd|cic|kirklees|service|services)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  // Services that look like the same thing: the same simplified name, or the same web site (bar big shared sites).
  function possibleDuplicates(out, newId) {
    const n = simple(out.name);
    const h = host(out.webpage);
    const shared = /^(gov\.uk|nhs\.uk|kirklees\.gov\.uk|facebook\.com|westyorks-ca\.gov\.uk)$/;
    return services.filter((y) => y.s.id !== newId && ((n && simple(y.s.name) === n) || (n.length > 6 && simple(y.s.name).includes(n)) || (h && !shared.test(h) && host(y.s.webpage) === h)));
  }

  function blankService() {
    return {
      id: 'new-service', name: '', organisation: '', open: true, hwlFunded: false, level: 'local', audience: ['individual'],
      categories: [], whoFor: '', age: null, webpage: null, email: null, phone: null, social: [], locations: [], areas: [], eligibility: [], exclusions: [],
      gate: [], healthFocus: [], groups: [], referralRoutes: [], selfReferral: { allowed: 'tbc', note: '' }, projects: [{ id: '', name: '', overview: '' }],
      workExperience: 'No', reviewCycle: 'Quarterly',
    };
  }

  // A "Suggest a service" form from the finder, turned into a draft listing. Only what the form asked is filled
  // in; everything is a starting point for the team to check with the service, never put live as it is.
  const DRAFT_KEY = 'hwl-listing-draft';
  const lines = (t) => String(t || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const STATUS_FROM = { now: 'Live - open to referrals', soon: 'Starting soon', paused: 'Paused', ended: 'Closed' };
  // The project a suggestion describes. Suggestions sent before November 2026 used "activities", "addresses",
  // "dates" and "running"; their words are kept (dates written as text go in "How long it lasts" for the team to
  // turn into real dates).
  // A place written in a suggestion: with a postcode, a venue (one we know with that address, or a new one written
  // out for the team to check); without, it stays as words.
  const PC_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
  function placeOf(text) {
    const m = String(text || '').match(PC_RE);
    if (!m) return null;
    const postcode = (m[1] + ' ' + m[2]).toUpperCase();
    const address = text.slice(0, m.index + m[0].length).trim().replace(/[,\s]+$/, '');
    const name = (address.split(',')[0] || address).replace(PC_RE, '').trim() || address;
    return venueIdOf({ name, address, postcode });
  }
  // The projects a suggestion describes. From November 2026 a suggestion has "projects", each with its venues, days
  // and times. Older suggestions used one project ("projectName", "where", "when"), and before that "activities",
  // "addresses", "dates" and "running"; their words are kept (dates written as text go in "How long it lasts" for the
  // team to turn into real dates).
  function projectsFromSuggestion(d) {
    if (Array.isArray(d.projects) && d.projects.length) {
      return d.projects.map((x) => {
        const p = { id: '', name: x.name || d.name || '', overview: x.overview || d.whoFor || '' };
        const runs = [];
        const where = [];
        const sessions = [];
        for (const se of list(x.sessions)) {
          const v = placeOf(se.where);
          const one = { id: '' };
          if (v) one.venue = v;
          else if (se.where) where.push(se.where);
          if (se.day) one.days = [se.day];
          if (se.start) one.start = se.start;
          if (se.end) one.end = se.end;
          if (Object.keys(one).length > 1) sessions.push(one);
        }
        if (sessions.length) { runs.push('set'); p.sessions = sessions; }
        if (x.appointment) runs.push('appointment');
        if (x.online) { runs.push('online'); where.push('Online or by phone'); }
        if (runs.length) p.runs = runs;
        if (where.length) p.where = where;
        for (const k of ['duration', 'places', ...LL.DATE_KEYS]) if (x[k]) p[k] = x[k];
        return p;
      });
    }
    const p = { id: '', name: d.projectName || d.name || '', overview: d.projectOverview || d.activities || d.description || '' };
    const where = [];
    const sessions = [];
    for (const l of lines(d.where || d.addresses)) {
      const v = placeOf(l);
      if (v) sessions.push({ id: '', venue: v });
      else where.push(l);
    }
    if (where.length) p.where = where;
    if (sessions.length) p.sessions = sessions;
    for (const k of ['when', 'duration', 'places']) if (d[k]) p[k] = d[k];
    if (!d.duration && d.dates) p.duration = d.dates;
    for (const k of LL.DATE_KEYS) if (/^\d{4}-\d{2}-\d{2}$/.test(d[k] || '')) p[k] = d[k];
    return [p];
  }
  function fromSuggestion(d) {
    const s = blankService();
    const ok = (k, v) => (choices[k] || []).includes(v);
    s.name = d.name || '';
    s.organisation = d.organisation || '';
    s.organisationOverview = d.organisationOverview || null;
    s.webpage = d.website || null;
    s.email = d.email || null;
    s.phone = d.phone || null;
    s.social = lines(d.social);
    s.areas = d.area && ok('areas', d.area) ? [d.area] : [];
    if (ok('level', d.level)) s.level = d.level;
    s.audience = (d.audience || []).filter((a) => ok('audience', a));
    if (!s.audience.length) s.audience = ['individual'];
    s.categories = (d.categories || []).filter((c) => ok('categories', c));
    s.whoFor = d.whoFor || d.description || '';
    s.age = d.age || null;
    s.eligibility = lines(d.eligibility);
    if (d.healthNeed === 'specific') s.eligibility.push('Has a health condition: ' + (d.conditions || 'to be checked with the service'));
    s.gate = lines(d.gate);
    s.groups = (d.groups || []).filter((g) => ok('groups', g));
    s.exclusions = lines(d.exclusions);
    s.healthFocus = d.healthNeed === 'any' ? ['any'] : [];
    s.referralRoutes = lines(d.referral);
    s.selfReferral = { allowed: ok('selfReferral', d.selfReferral) ? d.selfReferral : 'tbc', note: '' };
    s.cost = d.cost || null;
    s.languages = d.languages || null;
    s.coachNotes = d.coachNotes || null;
    s.workExperience = d.workExperience || 'Not stated';
    if (d.open) s.open = d.open === 'yes';
    if (d.running) {
      s.open = d.running === 'now';
      s.notes = 'From the suggestion: ' + STATUS_FROM[d.running] + (d.dates ? ', ' + d.dates : '');
    }
    if (d.noMap) s.mapLinks = false;
    s.projects = projectsFromSuggestion(d);
    return s;
  }
  function suggestionNote(d) {
    const by = d.role === 'provider' ? 'someone from the service' : d.role === 'suggester' ? 'someone who knows about it' : 'someone';
    const extra = [];
    if (d.healthNeed === 'specific') extra.push('Needs a specific health condition (' + (d.conditions || 'not said') + '): choose the health focus.');
    if (d.noMap) extra.push('Online or phone only, with no venue to map: consider turning the map buttons off in the file.');
    if (d.logoOk) extra.push('They said we may use their logo: ask them for it.');
    return 'From "Suggest a service" (feedback #' + d.from + ', sent ' + d.date + ') by ' + by + '. Check every detail with the service before including it.' + (extra.length ? ' ' + extra.join(' ') : '');
  }
  // The Feedback and usage page leaves a draft in this tab; open it once, then forget it.
  function openDraft() {
    const raw = store.get(DRAFT_KEY);
    if (!raw) return;
    store.del(DRAFT_KEY);
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    const note = suggestionNote(d);
    // A new project for a service already listed: open that service's edit form with the project added.
    const target = d.addTo && services.find((y) => y.s.id === d.addTo && !y.isNew);
    if (target && edits) {
      const pending = (editState(target) === 'pending' && edits[target.s.id].changes) || {};
      prefill[target.s.id] = { changes: { projects: [...list(pending.projects || target.s.projects), ...projectsFromSuggestion(d)] }, note, from: 'suggestion' };
      editing.add(target.s.id);
      for (const f of FIELDS) if (f !== 'sort') input[f].value = '';
      input.q.value = target.s.id;
      update();
      const box = document.getElementById('svc-' + target.s.id);
      if (box) { box.scrollIntoView({ block: 'start' }); const f = box.querySelector('.lf-proj:last-of-type input'); if (f) f.focus(); }
      return;
    }
    openAdd({ s: fromSuggestion(d), why: note, fromNote: 'Filled in from a suggestion sent through the finder. Boxes it didn\'t answer are left blank or set to a default: check everything with the service, and add what is missing, before adding it for review.' });
    $('#add-panel').scrollIntoView({ block: 'start' });
  }

  function openAdd(prefill) {
    const panel = $('#add-panel');
    const x = { s: blankService(), listing: 'new', isNew: true, ...(prefill && prefill.s ? prefill : {}) };
    panel.replaceChildren(editForm(x, 'add'));
    panel.hidden = false;
    panel.querySelector('input').focus();
  }

  async function discardNew(x) {
    if (!confirm('Discard the new service ' + x.s.name + '? It has not been added to the data yet.')) return;
    try {
      await api('DELETE', '/log/new/' + encodeURIComponent(x.s.id), { by: $('#by').value.trim() || 'someone' });
      delete added[x.s.id];
      rebuild();
      summary();
      update();
    } catch (err) {
      if (err.status === 401) return signOut('Your session has ended. Please enter the passcode again.');
      alert(err.message);
    }
  }

  // A new service waiting to be added, shaped like the others so it can be listed, filtered and decided on.
  function newX(id, entry) {
    const s = { hwlFunded: false, ...entry.service, id, lastUpdated: String(entry.t).slice(0, 10), listing: { decision: 'review', reason: 'New service added on this page by ' + entry.createdBy + '.' },
      provenance: { source: 'Added on the All services page by ' + entry.createdBy, evidence: entry.note, ...(entry.checkedUrl ? { checkedUrl: entry.checkedUrl } : {}) } };
    for (const k of Object.keys(s)) if (s[k] === null && ['cost', 'languages', 'notes', 'coachNotes', 'logo', 'requiresMention'].includes(k)) delete s[k];
    return { s, isNew: true, entry, listing: 'new', incomplete: JSON.stringify(s).includes(PLACEHOLDER), review: review(s), confidence: confidence(s), gaps: gaps(s), text: haystack(s) };
  }
  function rebuild() {
    const inData = new Set(baseServices.map((x) => x.s.id));
    services = [...baseServices, ...Object.entries(added || {}).filter(([id]) => !inData.has(id)).map(([id, e]) => newX(id, e))];
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

  // ---------- "Apply changes now" (worker/src/applynow.js) ----------
  // Starts the Apply team changes workflow on GitHub, which checks the changes, merges them and deploys. The page then
  // follows the run and the two deploys it starts, and says when the changes are live.
  let applyOn = false;
  let applyTimer = null;
  let applyAsked = 0; // when this page asked for a run, so an older run isn't mistaken for it
  const hhmm = (iso) => {
    const d = new Date(iso);
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' + time;
  };
  const waiting = () => services.filter((x) => x.isNew || teamState(x) === 'pending' || editState(x) === 'pending').length;

  function showApply() {
    $('#apply-now').hidden = !(team && applyOn);
    $('#apply-hint').hidden = Boolean(team && applyOn);
    if (!team || !applyOn) return;
    const n = waiting();
    const o = Object.keys(orgChanges || {}).filter((id) => orgPending(id)).length;
    const vc = Object.keys(venueChanges || {}).filter((id) => venuePending(id)).length;
    const parts = [n ? plural(n, 'service has', 'services have') + ' changes' : '', o ? plural(o, 'organisation change', 'organisation changes') : '', vc ? plural(vc, 'venue change', 'venue changes') : ''].filter(Boolean);
    $('#apply-pending').textContent = parts.length ? parts.join(' and ') + ' waiting to be applied.' : 'Nothing waiting to be applied.';
  }

  function applyMessage(text, kind, link) {
    const m = $('#apply-status');
    m.className = 'msg ' + (kind || 'info');
    m.replaceChildren(text, ...(link ? [' ', el('a', { href: link, target: '_blank', rel: 'noopener', text: 'See the details on GitHub' }), '.'] : []));
    m.hidden = false;
  }

  // What the latest run means for the person looking at the page. Returns true while there's more to wait for.
  function showRun(st) {
    const a = st.apply;
    const ours = a && Date.parse(a.created) >= applyAsked - 30000;
    if (applyAsked && !ours) { applyMessage('Starting…'); return true; }
    if (!a) return false;
    // Only describe runs started with this button. A run started on GitHub's Actions tab just opens a pull request,
    // so a later deploy (from merging something else) mustn't be read as "the team's changes are live".
    if (!/put them live/.test(a.title || '')) { $('#apply-status').hidden = true; $('#apply-btn').disabled = a.status !== 'completed'; return a.status !== 'completed'; }
    // On opening the page, only mention a finished run from the last 12 hours.
    if (!applyAsked && a.status === 'completed' && Date.now() - Date.parse(a.updated) > 12 * 3600e3) { $('#apply-status').hidden = true; return false; }
    const busy = (r) => r && r.status !== 'completed';
    const failed = (r) => r && r.status === 'completed' && r.conclusion !== 'success';
    $('#apply-btn').disabled = busy(a) || busy(st.site) || busy(st.worker);
    if (busy(a)) { applyMessage('Applying: checking the changes and the data (started ' + hhmm(a.created) + '). This takes a minute or two.'); return true; }
    if (failed(a)) { applyMessage('Not applied: the check found a problem, so nothing went live (' + hhmm(a.updated) + '). Your changes are still saved. Please tell Phil.', 'err', a.url); return false; }
    if (!st.site && !st.worker) {
      // The run finished without starting a deploy: there was nothing new to apply.
      if (applyAsked) applyMessage('Nothing new to apply: the live finder already has all the team\u2019s changes.', 'ok');
      else $('#apply-status').hidden = true;
      return false;
    }
    if (busy(st.site) || busy(st.worker) || !st.site || !st.worker) { applyMessage('Checks passed and the changes are merged. Updating the live finder now…'); return true; }
    if (failed(st.site) || failed(st.worker)) { applyMessage('The changes are merged, but updating the live finder failed. Please tell Phil.', 'err', (failed(st.site) ? st.site : st.worker).url); return false; }
    const done = hhmm(st.site.updated > st.worker.updated ? st.site.updated : st.worker.updated);
    const m = $('#apply-status');
    applyMessage('Live: the finder, the AI and the printable directory have the team\u2019s changes (' + done + '). ', 'ok');
    if (applyAsked) m.append(el('button', { type: 'button', class: 'btn secondary small', text: 'Reload this page', onclick: () => location.reload() }));
    return false;
  }

  async function checkApply() {
    clearTimeout(applyTimer);
    let st;
    try {
      st = await api('GET', '/log/apply/status');
    } catch (e) {
      applyOn = e.status !== 404 && e.status !== 401;
      showApply();
      if (applyOn && applyAsked) { applyMessage(e.message, 'err'); applyTimer = setTimeout(checkApply, 15000); }
      return;
    }
    applyOn = true;
    showApply();
    if (showRun(st)) applyTimer = setTimeout(checkApply, 8000);
    else { applyAsked = 0; $('#apply-btn').disabled = false; }
  }

  async function applyNow() {
    const by = $('#by').value.trim();
    if (!by) { applyMessage('Please put your name or initials in the box above first.', 'err'); $('#by').focus(); return; }
    const n = waiting();
    if (!window.confirm((n ? 'Put the changes to ' + plural(n, 'service', 'services') : 'Check for changes and put them') + ' live now?\n\nThey are checked first. If the check passes they go live on the finder in about 3 minutes; if not, nothing changes.')) return;
    $('#apply-btn').disabled = true;
    try {
      await api('POST', '/log/apply', { by });
    } catch (e) {
      applyMessage(e.message, 'err');
      $('#apply-btn').disabled = false;
      if (e.status === 409) checkApply();
      return;
    }
    applyAsked = Date.now();
    applyMessage('Starting…');
    applyTimer = setTimeout(checkApply, 5000);
  }

  function showSignedIn() {
    const by = $('#by').value.trim();
    $('#signin-form').hidden = Boolean(team);
    $('#signed-in').hidden = !team;
    $('#export-decisions').hidden = !team;
    $('#add-service').hidden = !team;
    $('#open-orgs').hidden = !team;
    $('#open-venues').hidden = !team;
    showApply();
    $('#signed-in-text').textContent = team ? 'Signed in' + (by ? ' as ' + by : '') + '. ' + plural(Object.keys(team).length, 'decision', 'decisions') + ', ' + plural(Object.keys(edits || {}).length, 'edited service', 'edited services') + ' and ' + plural(services.filter((y) => y.isNew).length, 'new service', 'new services') + ' so far.' : '';
  }

  async function signIn(candidate) {
    pass = candidate;
    const msg = $('#signin-msg');
    msg.hidden = true;
    try {
      const [d, e, nw, pl, og, vg] = await Promise.all([api('GET', '/log/decisions'), api('GET', '/log/edits'), api('GET', '/log/new'), api('GET', '/log/provider-links').catch(() => ({ links: [] })), api('GET', '/log/orgs').catch(() => ({ orgs: {} })), api('GET', '/log/venues').catch(() => ({ venues: {} }))]);
      team = d.decisions || {};
      edits = e.edits || {};
      added = nw.added || {};
      plinks = list(pl.links);
      orgChanges = og.orgs || {};
      venueChanges = vg.venues || {};
      rebuild();
    } catch (e) {
      team = null;
      edits = null;
      added = null;
      plinks = null;
      pass = '';
      store.del(PASS_KEY);
    AUTH.refresh();
      msg.textContent = e.status === 404 ? 'Admin has not been switched on yet (the TEAM_PASSCODE secret is not set). Ask Phil.' : e.status === 401 ? 'That passcode is not right.' : e.message;
      msg.hidden = false;
      showSignedIn();
      return;
    }
    store.set(PASS_KEY, pass);
    AUTH.refresh();
    $('#pass').value = '';
    showSignedIn();
    summary();
    update();
    checkApply();
    openDraft();
  }

  function signOut(message) {
    clearTimeout(applyTimer);
    applyAsked = 0;
    $('#apply-status').hidden = true;
    team = null;
    edits = null;
    added = null;
    plinks = null;
    editing.clear();
    sending.clear();
    rebuild();
    $('#add-panel').replaceChildren();
    $('#add-panel').hidden = true;
    $('#orgs-panel').replaceChildren();
    $('#orgs-panel').hidden = true;
    orgChanges = null;
    venueChanges = null;
    $('#venues-panel').replaceChildren();
    $('#venues-panel').hidden = true;
    pass = '';
    store.del(PASS_KEY);
    AUTH.refresh();
    showSignedIn();
    if (message) { $('#signin-msg').textContent = message; $('#signin-msg').hidden = false; }
    summary();
    update();
  }

  function exportDecisions() {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), decisions: team || {}, edits: edits || {}, added: added || {} }, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'support-finder-team-changes-' + new Date().toISOString().slice(0, 10) + '.json' });
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
        [n((x) => x.isNew), 'new services waiting to be added', { listing: 'new' }],
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
    const a = el('a', { href: url, download: 'support-finder-services-' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- organisations ----------
  // One record per organisation (data/organisations.json). The team can give it an overview and website, rename it
  // (the old name is kept as an alias) or combine it into another record when the same organisation is listed under
  // two names. Nothing is combined automatically. Changes wait here until applied, like service edits. The
  // Healthy Working Life marker stays on each service: an organisation record never carries it.
  // An organisation change still waiting: not yet in data/organisations.json. (Applied changes stay in the team
  // store, like service edits, and are recognised by comparing with the data.)
  function orgPending(id) {
    const c = (orgChanges || {})[id];
    if (!c || !c.changes) return null;
    const o = organisations.find((x) => x.id === id);
    if (c.changes.mergeInto) return o ? c : null;
    if (!o) return null;
    const same = Object.entries(c.changes).every(([k, v]) => (k === 'name' ? o.name === v : (o[k] || null) === (v || null)));
    return same ? null : c;
  }
  function orgNames() {
    const names = new Set(organisations.map((o) => o.name));
    for (const id of Object.keys(orgChanges || {})) { const c = orgPending(id); if (c && c.changes.name) names.add(c.changes.name); }
    for (const y of services) if (y.s.organisation) names.add(y.s.organisation);
    return [...names].sort((a, b) => a.localeCompare(b, 'en-GB', { sensitivity: 'base' }));
  }
  const servicesOf = (o) => services.filter((y) => y.s.organisation === o.name || list(o.aliases).includes(y.s.organisation));
  const orgSimple = (t) => String(t || '').toLowerCase().replace(/\b(the|ltd|limited|cic|plc|charity|trust)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  function maybeSameOrgs() {
    const out = [];
    for (let i = 0; i < organisations.length; i++) for (let j = i + 1; j < organisations.length; j++) {
      const a = orgSimple(organisations[i].name);
      const b = orgSimple(organisations[j].name);
      if (a && b && (a === b || (a.length > 5 && b.startsWith(a + ' ')) || (b.length > 5 && a.startsWith(b + ' ')))) out.push([organisations[i], organisations[j]]);
    }
    return out;
  }

  function openOrgs() {
    const panel = $('#orgs-panel');
    panel.hidden = false;
    drawOrgs();
    panel.scrollIntoView({ block: 'start' });
    panel.querySelector('input').focus();
  }

  function drawOrgs(keepQuery) {
    const panel = $('#orgs-panel');
    const q = el('input', { id: 'org-q', type: 'search', autocomplete: 'off', value: keepQuery || '' });
    const listBox = el('div', { class: 'org-list' });
    const draw = () => {
      const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = organisations.filter((o) => words.every((w) => (o.name + ' ' + list(o.aliases).join(' ') + ' ' + (o.overview || '')).toLowerCase().includes(w)));
      listBox.replaceChildren(el('p', { class: 'count', text: plural(hits.length, 'organisation', 'organisations') }), ...hits.slice(0, 40).map(orgEntry));
    };
    q.addEventListener('input', draw);
    const pairs = maybeSameOrgs();
    const waiting = Object.keys(orgChanges || {}).map((id) => [id, orgPending(id)]).filter(([, c]) => c);
    panel.replaceChildren(
      el('h2', { class: 'mt0', text: 'Organisations' }),
      el('p', { class: 'hint', text: 'Each organisation has one record, shared by all its services. Give it a short overview (about two sentences, up to ' + LL.LIMITS.orgOverview + ' characters) and its website. If the same organisation is listed under two names, combine one into the other: its services move across and the old name is kept so it is still recognised. Nothing is combined automatically. The Healthy Working Life marker stays on each service, never on the organisation. Changes wait here until the team\'s changes are applied.' }),
      waiting.length ? el('div', { class: 'waiting' }, el('p', { class: 'mt0' }, el('strong', { text: 'Organisation changes waiting to be applied' })),
        el('ul', {}, waiting.map(([id, c]) => {
          const o = organisations.find((x) => x.id === id);
          const to = c.changes.mergeInto && organisations.find((x) => x.id === c.changes.mergeInto);
          return el('li', {}, (o ? o.name : id) + ': ' + [c.changes.mergeInto ? 'combine into ' + (to ? to.name : c.changes.mergeInto) : '', c.changes.name ? 'rename to "' + c.changes.name + '"' : '', 'overview' in c.changes ? 'new overview' : '', 'website' in c.changes ? 'website ' + (c.changes.website || '(none)') : ''].filter(Boolean).join(', ') + ' (' + c.by + ', ' + when(c.t) + ': ' + c.note + ') ',
            el('button', { type: 'button', class: 'btn secondary small', text: 'Discard', onclick: async () => {
              if (!confirm('Discard this organisation change?')) return;
              try { await api('DELETE', '/log/orgs/' + id, { by: $('#by').value.trim() || 'someone' }); delete orgChanges[id]; drawOrgs(q.value); showApply(); } catch (err) { if (err.status === 401) return signOut('Your session has ended. Please enter the passcode again.'); alert(err.message); }
            } }));
        }))) : null,
      pairs.length ? el('details', {}, el('summary', { text: plural(pairs.length, 'pair of names that may be the same organisation', 'pairs of names that may be the same organisation') }),
        el('p', { class: 'hint', text: 'Check each pair: some are different organisations with similar names. To combine, open the one to remove and choose the one to keep.' }),
        el('ul', {}, pairs.map(([a, b]) => el('li', {}, a.name + '  |  ' + b.name + ' ', el('button', { type: 'button', class: 'btn secondary small', text: 'Show both', onclick: () => { q.value = orgSimple(a.name).split(' ')[0]; draw(); } }))))) : null,
      el('div', { class: 'field' }, el('label', { for: 'org-q', text: 'Find an organisation' }), q),
      listBox,
      el('p', {}, el('button', { type: 'button', class: 'btn secondary small', text: 'Close organisations', onclick: () => { panel.replaceChildren(); panel.hidden = true; $('#open-orgs').focus(); } })));
    draw();
  }

  function orgEntry(o) {
    const c = orgPending(o.id);
    const val = (k) => (c && k in c.changes ? c.changes[k] : o[k]);
    const svcs = servicesOf(o);
    const id = (k) => 'org-' + o.id + '-' + k;
    const name = el('input', { id: id('name'), type: 'text', value: val('name') || '', maxlength: '150' });
    const ov = el('textarea', { id: id('ov'), rows: '3', value: val('overview') || '' });
    const count = el('p', { class: 'lf-count' });
    const upd = () => { const n = ov.value.trim().length; count.textContent = n + ' of ' + LL.LIMITS.orgOverview + ' characters' + (n > LL.LIMITS.orgOverview ? ' (too long)' : ''); count.classList.toggle('over', n > LL.LIMITS.orgOverview); };
    ov.addEventListener('input', upd);
    upd();
    const web = el('input', { id: id('web'), type: 'url', value: val('website') || '' });
    const merge = el('select', { id: id('merge') }, el('option', { value: '', text: 'No, keep it separate' }),
      organisations.filter((x) => x.id !== o.id).map((x) => el('option', { value: x.id, text: x.name })));
    merge.value = val('mergeInto') || '';
    const why = el('textarea', { id: id('why'), rows: '2', maxlength: '1000' });
    const msg = el('p', { class: 'msg', role: 'status', hidden: true });
    const say = (t, k) => { msg.className = 'msg ' + k; msg.textContent = t; msg.hidden = false; };
    const save = el('button', { type: 'button', class: 'btn primary small', text: 'Save organisation changes', onclick: async () => {
      const by = $('#by').value.trim();
      const changes = {};
      if (name.value.trim() !== o.name) changes.name = name.value.trim();
      if (ov.value.trim() !== (o.overview || '')) changes.overview = ov.value.trim() || null;
      if (web.value.trim() !== (o.website || '')) changes.website = web.value.trim() || null;
      if (merge.value) changes.mergeInto = merge.value;
      if (!Object.keys(changes).length) return say('Nothing has changed.', 'err');
      if (!name.value.trim()) { name.focus(); return say('The organisation needs a name.', 'err'); }
      if (changes.overview && changes.overview.length > LL.LIMITS.orgOverview) { ov.focus(); return say('The overview is too long: please keep it to ' + LL.LIMITS.orgOverview + ' characters.', 'err'); }
      if (/healthy working life|\bhwl\b/i.test(changes.overview || '')) { ov.focus(); return say('The organisation overview describes the organisation as a whole, so it shouldn\'t say it is a Healthy Working Life project: that goes on the services that are.', 'err'); }
      if (changes.website && !/^https?:\/\/\S+$/.test(changes.website)) { web.focus(); return say('The website must start with http:// or https://', 'err'); }
      if (!by) { $('#by').focus(); return say('Please put your name or initials at the top of the page first.', 'err'); }
      if (why.value.trim().length < 3) { why.focus(); return say('Please say briefly what changed and why.', 'err'); }
      if (changes.mergeInto && !confirm('Combine ' + o.name + ' into ' + merge.selectedOptions[0].text + '? Its ' + plural(svcs.length, 'service moves', 'services move') + ' across when the changes are applied.')) return;
      save.disabled = true;
      try {
        const d = await api('PUT', '/log/orgs/' + o.id, { changes, before: { name: o.name, overview: o.overview || null, website: o.website || null }, note: why.value.trim(), by });
        orgChanges[o.id] = d.item;
        showApply();
        drawOrgs($('#org-q').value);
        const again = document.getElementById(id('name'));
        if (again) again.closest('details').open = true;
      } catch (err) {
        save.disabled = false;
        if (err.status === 401) return signOut('Your session has ended. Please enter the passcode again.');
        say(err.message, 'err');
      }
    } });
    return el('details', { class: 'entry org' },
      el('summary', {}, el('strong', { text: o.name }), ' (' + plural(svcs.length, 'service', 'services') + ')' + (o.overview ? '' : ', no overview yet') + (c ? ', changes waiting' : '')),
      el('p', { class: 'hint', text: 'Services: ' + (svcs.map((y) => y.s.name + (y.s.hwlFunded ? ' (HWL)' : '')).join('; ') || 'none') + (list(o.aliases).length ? '. Also known as: ' + o.aliases.join('; ') : '') }),
      el('div', { class: 'field' }, el('label', { for: id('name'), text: 'Name' }), name, el('p', { class: 'hint', text: 'Renaming keeps the old name, so services and suggestions using it are still recognised.' })),
      el('div', { class: 'field' }, el('label', { for: id('ov'), text: 'Organisation overview' }), el('p', { class: 'hint', text: "About two sentences on the organisation's wider work, shown with all its services. Not a description of one project, and no Healthy Working Life marker." }), ov, count),
      el('div', { class: 'field' }, el('label', { for: id('web'), text: 'Website' }), web),
      el('div', { class: 'field' }, el('label', { for: id('merge'), text: 'Combine into another organisation?' }), el('p', { class: 'hint', text: 'Only if this is the same organisation listed under another name. Its services move to the one you choose; its overview and website are kept on that one if it has none.' }), merge),
      el('div', { class: 'field' }, el('label', { for: id('why'), text: 'What changed and why' }), why),
      el('div', { class: 'row-end' }, save, msg));
  }

  // ---------- venues ----------
  // One record per place (data/venues.json), shared by every service that meets there. The ward and map position
  // come from the postcode (looked up when changes are applied), so they can't be typed in. The team can rename a
  // venue, correct its address or postcode, add notes, or combine two records for the same place. Nothing is
  // combined automatically. Changes wait here until applied, like service edits.
  function venuePending(id) {
    const c = (venueChanges || {})[id];
    if (!c || !c.changes) return null;
    const v = venueById(id);
    if (c.changes.mergeInto) return v ? c : null;
    if (!v) return null;
    return Object.entries(c.changes).every(([k, val]) => (v[k] || null) === (val || null)) ? null : c;
  }
  const venueUsers = (id) => services.filter((y) => !y.isNew && LL.venueIds(y.s).includes(id));

  function openVenues() {
    const panel = $('#venues-panel');
    panel.hidden = false;
    drawVenues();
    panel.scrollIntoView({ block: 'start' });
    panel.querySelector('input').focus();
  }

  function drawVenues(keepQuery) {
    const panel = $('#venues-panel');
    const q = el('input', { id: 'venue-q', type: 'search', autocomplete: 'off', value: keepQuery || '' });
    const listBox = el('div', { class: 'org-list' });
    const draw = () => {
      const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = venues.filter((v) => words.every((w) => [v.name, v.address, v.postcode, v.ward, ...list(v.aliases)].join(' ').toLowerCase().includes(w)));
      listBox.replaceChildren(el('p', { class: 'count', text: plural(hits.length, 'venue', 'venues') }), ...hits.slice(0, 40).map(venueEntry));
    };
    q.addEventListener('input', draw);
    const byPc = new Map();
    for (const v of venues) byPc.set(v.postcode, [...(byPc.get(v.postcode) || []), v]);
    const shared = [...byPc.values()].filter((xs) => xs.length > 1);
    const noWard = venues.filter((v) => !v.ward);
    const waiting = Object.keys(venueChanges || {}).map((vid) => [vid, venuePending(vid)]).filter(([, c]) => c);
    panel.replaceChildren(
      el('h2', { class: 'mt0', text: 'Venues' }),
      el('p', { class: 'hint', text: 'Each place has one record, shared by every session there. The ward and map position come from the postcode: they are looked up when changes are applied. If one place is listed twice (for example with two ways of writing the address), combine one into the other: its sessions move across and its name is kept. Nothing is combined automatically.' }),
      waiting.length ? el('div', { class: 'waiting' }, el('p', { class: 'mt0' }, el('strong', { text: 'Venue changes waiting to be applied' })),
        el('ul', {}, waiting.map(([vid, c]) => {
          const v = venueById(vid);
          const to = c.changes.mergeInto && venueById(c.changes.mergeInto);
          return el('li', {}, (v ? v.name : vid) + ': ' + [c.changes.mergeInto ? 'combine into ' + (to ? to.name : c.changes.mergeInto) : '', ...['name', 'address', 'postcode', 'notes'].filter((k) => k in c.changes).map((k) => k + ' ' + (c.changes[k] || '(none)'))].filter(Boolean).join(', ') + ' (' + c.by + ', ' + when(c.t) + ': ' + c.note + ') ',
            el('button', { type: 'button', class: 'btn secondary small', text: 'Discard', onclick: async () => {
              if (!confirm('Discard this venue change?')) return;
              try { await api('DELETE', '/log/venues/' + vid, { by: $('#by').value.trim() || 'someone' }); delete venueChanges[vid]; drawVenues(q.value); showApply(); } catch (err) { if (err.status === 401) return signOut('Your session has ended. Please enter the passcode again.'); alert(err.message); }
            } }));
        }))) : null,
      shared.length ? el('details', {}, el('summary', { text: plural(shared.length, 'postcode shared by more than one venue', 'postcodes shared by more than one venue') }),
        el('p', { class: 'hint', text: 'Some are the same place written differently; others are different buildings with one postcode. Combine only the same place.' }),
        el('ul', {}, shared.map((xs) => el('li', {}, xs[0].postcode + ': ' + xs.map((v) => v.name).join('  |  ') + ' ', el('button', { type: 'button', class: 'btn secondary small', text: 'Show them', onclick: () => { q.value = xs[0].postcode; draw(); } }))))) : null,
      noWard.length ? el('p', { class: 'hint', text: plural(noWard.length, 'venue has', 'venues have') + ' no ward yet: it is looked up from the postcode the next time changes are applied (or run "Look up venue wards" in GitHub).' }) : null,
      el('div', { class: 'field' }, el('label', { for: 'venue-q', text: 'Find a venue (name, address, postcode or ward)' }), q),
      listBox,
      el('p', {}, el('button', { type: 'button', class: 'btn secondary small', text: 'Close venues', onclick: () => { panel.replaceChildren(); panel.hidden = true; $('#open-venues').focus(); } })));
    draw();
  }

  function venueEntry(v) {
    const c = venuePending(v.id);
    const val = (k) => (c && k in c.changes ? c.changes[k] : v[k]);
    const users = venueUsers(v.id);
    const id = (k) => 'ven-' + v.id + '-' + k;
    const name = el('input', { id: id('name'), type: 'text', value: val('name') || '', maxlength: '150' });
    const addr = el('input', { id: id('addr'), type: 'text', value: val('address') || '', maxlength: '300' });
    const pc = el('input', { id: id('pc'), type: 'text', value: val('postcode') || '', maxlength: '10', size: '10' });
    const notes = el('textarea', { id: id('notes'), rows: '2', value: val('notes') || '' });
    const merge = el('select', { id: id('merge') }, el('option', { value: '', text: 'No, keep it separate' }),
      venues.filter((x) => x.id !== v.id).map((x) => el('option', { value: x.id, text: x.name + ' (' + x.postcode + ')' })));
    merge.value = val('mergeInto') || '';
    const why = el('textarea', { id: id('why'), rows: '2', maxlength: '1000' });
    const msg = el('p', { class: 'msg', role: 'status', hidden: true });
    const say = (t, k) => { msg.className = 'msg ' + k; msg.textContent = t; msg.hidden = false; };
    const save = el('button', { type: 'button', class: 'btn primary small', text: 'Save venue changes', onclick: async () => {
      const by = $('#by').value.trim();
      const changes = {};
      if (name.value.trim() !== v.name) changes.name = name.value.trim();
      if (addr.value.trim() !== v.address) changes.address = addr.value.trim();
      if (pc.value.trim().toUpperCase() !== v.postcode) changes.postcode = pc.value.trim();
      if (notes.value.trim() !== (v.notes || '')) changes.notes = notes.value.trim() || null;
      if (merge.value) changes.mergeInto = merge.value;
      if (!Object.keys(changes).length) return say('Nothing has changed.', 'err');
      if (!by) { $('#by').focus(); return say('Please put your name or initials at the top of the page first.', 'err'); }
      if (why.value.trim().length < 3) { why.focus(); return say('Please say briefly what changed and why.', 'err'); }
      if (changes.mergeInto && !confirm('Combine ' + v.name + ' into ' + merge.selectedOptions[0].text + '? Its sessions move across when the changes are applied.')) return;
      save.disabled = true;
      try {
        const d = await api('PUT', '/log/venues/' + v.id, { changes, before: { name: v.name, address: v.address, postcode: v.postcode, notes: v.notes || null }, note: why.value.trim(), by });
        venueChanges[v.id] = d.item;
        showApply();
        drawVenues($('#venue-q').value);
      } catch (err) {
        save.disabled = false;
        if (err.status === 401) return signOut('Your session has ended. Please enter the passcode again.');
        say(err.message, 'err');
      }
    } });
    return el('details', { class: 'entry org venue' },
      el('summary', {}, el('strong', { text: v.name }), ' ' + v.postcode + (v.ward ? ', ' + v.ward + ' ward' : ', ward not looked up yet') + ' (' + plural(users.length, 'service', 'services') + ')' + (c ? ', changes waiting' : '')),
      el('p', { class: 'hint', text: LL.venueLine(v) + '. Used by: ' + (users.map((y) => y.s.name).join('; ') || 'nothing yet') + (list(v.aliases).length ? '. Also known as: ' + v.aliases.join('; ') : '') }),
      el('div', { class: 'field' }, el('label', { for: id('name'), text: 'Name' }), name),
      el('div', { class: 'field' }, el('label', { for: id('addr'), text: 'Address' }), addr),
      el('div', { class: 'field' }, el('label', { for: id('pc'), text: 'Postcode' }), el('p', { class: 'hint', text: 'Changing it means the ward is looked up again.' }), pc),
      el('div', { class: 'field' }, el('label', { for: id('notes'), text: 'Team notes' }), el('p', { class: 'hint', text: 'For example access, parking or "confidential address: don\'t show on a map".' }), notes),
      el('div', { class: 'field' }, el('label', { for: id('merge'), text: 'Combine into another venue?' }), el('p', { class: 'hint', text: 'Only if this is the same place listed twice.' }), merge),
      el('div', { class: 'field' }, el('label', { for: id('why'), text: 'What changed and why' }), why),
      el('div', { class: 'row-end' }, save, msg));
  }

  // ---------- start ----------
  // services-all.json (every service) is published with the Admin pages; fall back to the live list if it's missing.
  const getJson = (u) => fetch(u).then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });
  getJson('services-all.json')
    .catch(() => getJson('../services.json'))
    .then((d) => {
      choices = d.choices || {};
      organisations = list(d.organisations);
      venues = list(d.venues);
      baseServices = list(d.services).map((s) => ({ s, listing: listing(s), incomplete: JSON.stringify(s).includes(PLACEHOLDER), review: review(s), confidence: confidence(s), gaps: gaps(s), text: haystack(s) }));
      rebuild();
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
  $('#add-service').addEventListener('click', () => openAdd());
  $('#open-orgs').addEventListener('click', openOrgs);
  $('#open-venues').addEventListener('click', openVenues);
  $('#by').value = store.get(BY_KEY);
  $('#by').addEventListener('change', () => { store.set(BY_KEY, $('#by').value.trim()); AUTH.refresh(); showSignedIn(); });
  $('#unlock').addEventListener('click', () => { if ($('#pass').value) signIn($('#pass').value); });
  $('#pass').addEventListener('keydown', (e) => { if (e.key === 'Enter' && $('#pass').value) signIn($('#pass').value); });
  $('#lock').addEventListener('click', () => signOut(''));
  $('#apply-btn').addEventListener('click', applyNow);
})();
