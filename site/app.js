(() => {
  'use strict';

  // Where the Worker lives. Written into config.js by the Pages deploy from the WORKER_URL variable.
  const API = String((window.FINDER_CONFIG && window.FINDER_CONFIG.apiBase) || '').replace(/\/$/, '');

  const STALE_DAYS = 135; // quarterly review plus a few weeks of slack
  const $ = (sel) => document.querySelector(sel);
  const logEl = $('#log');
  const form = $('#form');
  const input = $('#message');
  const sendBtn = $('#send');
  const peopleEl = $('#people');
  const sendLabel = $('#send-label');

  // Everything lives in memory only. Nothing is written to storage.
  let services = new Map();
  let organisations = []; // [{ id, name, aliases? }] from services.json, for the suggest form's organisation box
  let venues = new Map(); // id -> { name, address, postcode, ward, lat, lng }, for sessions on the cards
  let history = [];
  let busy = false;
  // Tap-to-answer follow-up questions on the latest reply: { box, questions, picked: Map(index -> answer) }.
  let pendingQuestions = null;
  // "Have we understood you?": results held back until the person checks the summary.
  // { data, box } while waiting; checked is true once they have said yes in this conversation.
  let pendingCheck = null;
  let checked = false;

  // Page text comes from i18n.js.
  const t = (key, vars) => window.I18N.t(key, vars);
  // Service details come from services.json and are in English. They are marked as English so screen
  // readers say them correctly, and dir="auto" lays them out properly on the Urdu (right-to-left) page.
  const EN = { lang: 'en', dir: 'auto' };

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
  // "Who is this for?" has no default: the person has to choose, so results aren't worded for the wrong person.
  const mode = () => { const r = document.querySelector('input[name=mode]:checked'); return r ? r.value : null; };
  const modeError = $('#mode-error');
  function needMode() {
    if (mode()) return false;
    modeError.textContent = t('modeError');
    modeError.hidden = false;
    document.querySelector('fieldset.mode').classList.add('invalid');
    document.querySelector('input[name=mode]').focus();
    return true;
  }
  function clearModeError() {
    modeError.hidden = true;
    modeError.textContent = '';
    document.querySelector('fieldset.mode').classList.remove('invalid');
  }
  for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', clearModeError);

  function link(href, text) {
    return isUrl(href) ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text }) : document.createTextNode(text);
  }

  const PHONE_RE = /\b0\d{2,4} ?\d{3} ?\d{3,4}\b/g;
  function phoneNodes(text) {
    const nodes = [];
    let last = 0;
    for (const m of text.matchAll(PHONE_RE)) {
      if (m.index > last) nodes.push(text.slice(last, m.index));
      nodes.push(el('a', { href: 'tel:' + m[0].replace(/\s/g, ''), text: m[0] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
  }

  function fmtDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString(window.I18N.locale, { day: 'numeric', month: 'long', year: 'numeric' });
  }
  const ageInDays = (iso) => (Date.now() - Date.parse(iso)) / 86400000;

  // "Online self referral: https://..." -> link, otherwise plain text
  function routeNode(route) {
    const m = route.match(/^(.*?):?\s*(https?:\/\/\S+)$/);
    if (m) {
      const label = m[1].trim();
      return el('li', label ? EN : {}, link(m[2], label || t('onlineForm')));
    }
    return el('li', { ...EN, text: route });
  }

  // ---------- cards ----------
  // Decorative gradient on each card, picked from the service id so a service always gets the same one.
  const THUMBS = 5;
  function thumbIndex(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % THUMBS;
  }

  // The picture at the top left of a card: the organisation's logo when services.json names one (the file
  // lives in site/img/logos/), otherwise a coloured block. If a logo file is missing, it falls back to the block.
  // The organisation's name is written next to it, so the logo is decorative for screen readers.
  function thumb(s) {
    const box = el('div', { class: 'thumb thumb-' + thumbIndex(s.id), 'aria-hidden': 'true' });
    if (typeof s.logo === 'string' && /^[\w.-]+\.(png|jpe?g|webp|svg)$/i.test(s.logo)) {
      box.classList.add('logo');
      box.append(el('img', { src: 'img/logos/' + s.logo, alt: '', loading: 'lazy', onerror: () => { box.classList.remove('logo'); box.replaceChildren(); } }));
    }
    return box;
  }

  // ---------- where a service is: addresses with map and directions links ----------
  // A location line counts as an address when it has a full UK postcode. The link text sent to Google Maps is the
  // line up to and including the postcode, so notes after it ("near the train station") are left off.
  const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/i;
  const PLACES_SHOWN = 2;
  const pinSvg = () => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '18'); svg.setAttribute('height', '18'); svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'pin');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z');
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', '12'); dot.setAttribute('cy', '9.5'); dot.setAttribute('r', '2.5');
    svg.append(path, dot);
    return svg;
  };

  // The places for a card: the service's own, then those of the projects and sessions being shown. A venue is
  // written out with its address and postcode, so it gets map and directions links.
  const venueLineOf = (id) => (venues.has(id) ? LISTING.venueLine(venues.get(id)) : null);
  function placeLines(s, picked) {
    const out = [...(s.venues || []).map(venueLineOf).filter(Boolean), ...(s.locations || [])];
    for (const x of picked || []) {
      out.push(...(x.project.where || []));
      for (const c of x.sessions) {
        if (c.session.venue && venueLineOf(c.session.venue)) out.push(venueLineOf(c.session.venue));
        out.push(...(c.session.where || []));
      }
    }
    return [...new Set(out)];
  }
  function places(s, picked) {
    const lines = placeLines(s, picked);
    const addresses = lines.filter((x) => POSTCODE_RE.test(x)).map((x) => {
      const m = x.match(POSTCODE_RE);
      return { text: x, query: x.slice(0, m.index + m[0].length) };
    });
    const areas = s.areas || [];
    const all = lines.join(' ').toLowerCase();
    const labels = [];
    if (areas.includes('Kirklees-wide')) labels.push(t('placeAcross'));
    if (areas.includes('Online') || /\bonline\b/.test(all)) labels.push(t('placeOnline'));
    if (/\bphone\b/.test(all)) labels.push(t('placePhone'));
    return { addresses, labels, others: lines.filter((x) => !POSTCODE_RE.test(x)) };
  }

  // The short place shown with the badges: the first town, or "Across Kirklees" / "Online".
  function placeBadge(s, picked) {
    const towns = (s.areas || []).filter((a) => a !== 'Kirklees-wide' && a !== 'Online');
    const p = places(s, picked);
    const text = towns.length ? towns[0] + (towns.length > 1 ? ' +' + (towns.length - 1) : '') : p.labels[0];
    return text ? el('span', { class: 'badge place' }, pinSvg(), el('span', { ...(towns.length ? EN : {}), text })) : null;
  }

  function whereBlock(s, picked) {
    const p = places(s, picked);
    if (!p.addresses.length && !p.labels.length && !p.others.length) return null;
    const list = el('ul', { class: 'places' });
    // Services can turn the map links off for a place that shouldn't be shown (for example a confidential venue).
    const links = s.mapLinks !== false;
    for (const a of p.addresses.slice(0, PLACES_SHOWN)) {
      const q = encodeURIComponent(a.query);
      list.append(el('li', {},
        el('span', { class: 'place-text' }, pinSvg(), el('span', { ...EN, text: a.text })),
        links ? el('span', { class: 'place-links' },
          el('a', { class: 'btn secondary small', href: 'https://www.google.com/maps/dir/?api=1&destination=' + q, target: '_blank', rel: 'noopener noreferrer', 'aria-label': t('directionsTo', { place: a.query }) }, t('placeDirections')),
          el('a', { class: 'map-link', href: 'https://www.google.com/maps/search/?api=1&query=' + q, target: '_blank', rel: 'noopener noreferrer', 'aria-label': t('mapOf', { place: a.query }) }, t('placeMap'))
        ) : null));
    }
    if (p.addresses.length > PLACES_SHOWN) list.append(el('li', { class: 'place-more', text: t('placeMore', { n: p.addresses.length - PLACES_SHOWN }) }));
    if (!p.addresses.length) {
      for (const x of p.others.slice(0, 2)) list.append(el('li', {}, el('span', { class: 'place-text no-pin', ...EN, text: x })));
    }
    return [
      el('h4', { text: t('where') }),
      p.labels.length ? el('p', { class: 'place-labels' }, p.labels.map((l) => el('span', { class: 'badge', text: l }))) : null,
      list,
    ];
  }

  // ---------- projects and sessions on a card ----------
  // A service's projects (and a project's sessions) each have their own dates. The Worker says which ones fit the
  // person (rec.parts) and the date it used; only those that are open, or open to referrals soon, are shown
  // (listing-logic.js). Dates are written in the page's language.
  const LISTING = window.LISTING;
  function dateWords(d, on) {
    const w = [];
    if (d.referralsFrom && d.referralsFrom > on) w.push(t('refOpenFrom', { date: fmtDate(d.referralsFrom) }));
    if (d.referralsUntil) w.push(t('refUntil', { date: fmtDate(d.referralsUntil) }));
    if (d.runsFrom && d.runsTo) w.push(t('runsRange', { from: fmtDate(d.runsFrom), to: fmtDate(d.runsTo) }));
    else if (d.runsFrom && d.runsFrom > on) w.push(t('startsOn', { date: fmtDate(d.runsFrom) }));
    else if (d.runsTo) w.push(t('runsUntil', { date: fmtDate(d.runsTo) }));
    return w;
  }
  // The age to show with the badges: the one age of what is shown when they all have one, otherwise the service's.
  function ageOf(s, picked) {
    const ages = new Set();
    for (const x of picked) {
      const forGroups = x.sessions.filter((c) => LISTING.forGroup(c.session));
      if (forGroups.length) for (const c of forGroups) ages.add(c.session.age || x.project.age || s.age || '');
      else ages.add(x.project.age || s.age || '');
    }
    return ages.size === 1 && [...ages][0] ? [...ages][0] : s.age;
  }
  // A session's days and times in the page's language: "Tuesday, 1:00 pm to 3:00 pm, every other week".
  function clockOf(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    try { return new Date(2000, 0, 1, h, m).toLocaleTimeString(window.I18N.locale || 'en-GB', { hour: 'numeric', minute: '2-digit' }); } catch { return hhmm; }
  }
  function sessionTime(se) {
    const w = [];
    if ((se.days || []).length) w.push(se.days.map((d) => t('fbDay_' + d)).join(', '));
    if (se.start && se.end) w.push(t('timeRange', { from: clockOf(se.start), to: clockOf(se.end) }));
    else if (se.start) w.push(clockOf(se.start));
    if (se.frequency && se.frequency !== 'weekly') w.push(t('freq_' + se.frequency));
    return w.join(', ');
  }
  // The timetable for a project: one line per session, the ones the AI picked for the person first.
  function sessionsList(x, on, s) {
    const rows = x.sessions.filter((c) => !LISTING.forGroup(c.session) || c.named || x.sessions.every((y) => LISTING.forGroup(y.session)));
    const named = rows.filter((c) => c.named);
    const rest = rows.filter((c) => !c.named).sort((a, b) => LISTING.byDay(a.session, b.session));
    return el('ul', { class: 'sessions' }, [...named, ...rest].map((c) => {
      const se = c.session;
      const v = se.venue && venues.get(se.venue);
      const time = sessionTime(se);
      return el('li', { class: c.named && rest.length ? 'named' : null },
        se.name ? el('span', { ...EN, class: 'session-name', text: se.name }) : null,
        time ? el('span', { class: 'session-time', text: time }) : null,
        v ? el('span', { ...EN, class: 'session-venue', text: v.name + (v.ward ? ', ' + v.ward : '') }) : null,
        se.note || se.when ? el('span', { ...EN, class: 'session-note', text: se.note || se.when }) : null,
        c.named && rest.length ? el('span', { class: 'badge soon', text: t('suggestedSession') }) : null,
        partFacts({ ...se, when: null, age: se.age || x.project.age }, c.dates, on, s));
    }));
  }
  // The lines about one project or session: when, how long, places, age, extra criteria and dates.
  function partFacts(o, dates, on, s) {
    const li = [];
    if (o.when) li.push(el('li', {}, t('whenLabel'), el('span', { ...EN, text: o.when })));
    if (o.duration) li.push(el('li', {}, t('howLong'), el('span', { ...EN, text: o.duration })));
    if (o.places) li.push(el('li', {}, t('placesLabel'), el('span', { ...EN, text: o.places })));
    if (o.age && o.age !== s.age) li.push(el('li', {}, t('age'), el('span', { ...EN, text: o.age })));
    if ((o.eligibility || []).length) li.push(el('li', {}, t('extraCriteria'), el('span', { ...EN, text: o.eligibility.join('; ') })));
    for (const w of dateWords(dates, on)) li.push(el('li', { class: 'dates', text: w }));
    return li.length ? el('ul', { class: 'part-facts' }, li) : null;
  }
  function projectsBlock(s, picked, on) {
    if (!picked.length) return null;
    return [
      el('h4', { text: t('whatWhere') }),
      el('ul', { class: 'projects' }, picked.map((x) => el('li', {},
        el('strong', { ...EN, text: x.project.name }),
        x.project.overview ? el('p', { ...EN, text: x.project.overview }) : null,
        partFacts(x.project, x.sessions.length ? {} : x.dates, on, s),
        x.project.area ? el('p', {}, t('areaCovered'), el('span', { ...EN, text: x.project.area })) : null,
        x.sessions.length ? sessionsList(x, on, s) : null))),
    ];
  }

  function card(rec, opts) {
    const s = services.get(rec.id);
    if (!s) return null;
    const on = (opts && opts.date) || (LISTING ? LISTING.today() : new Date().toISOString().slice(0, 10));
    const picked = LISTING ? LISTING.pick(s, rec.parts, on) : [];
    // "Referrals open from ..." with the badges when everything shown opens to referrals soon.
    const soon = picked.length && picked.every((x) => x.state === 'soon' && (!x.sessions.length || x.sessions.every((c) => c.state === 'soon')))
      ? picked.map((x) => (x.sessions.length ? x.sessions.map((c) => c.dates.referralsFrom) : [x.dates.referralsFrom])).flat().filter(Boolean).sort()[0] : null;
    const age = ageOf(s, picked);

    const badges = el('div', { class: 'badges' },
      rec.fit === 'strong' ? el('span', { class: 'badge fit-strong', text: t('fitStrong') }) : null,
      rec.fit === 'possible' ? el('span', { class: 'badge fit-possible', text: t('fitPossible') }) : null,
      soon ? el('span', { class: 'badge soon', text: t('refOpenFrom', { date: fmtDate(soon) }) }) : s.open ? el('span', { class: 'badge live', text: t('open') }) : el('span', { class: 'badge notopen', text: t('notOpen') }),
      s.selfReferral && s.selfReferral.allowed === 'yes' ? el('span', { class: 'badge self', text: t('selfYes') }) : null,
      s.selfReferral && s.selfReferral.allowed === 'partly' ? el('span', { class: 'badge self', text: t('selfPartly') }) : null,
      s.selfReferral && s.selfReferral.allowed === 'tbc' ? el('span', { class: 'badge', text: t('selfTbc') }) : null,
      s.selfReferral && s.selfReferral.allowed === 'no' ? el('span', { class: 'badge', text: t('selfNo') }) : null,
      s.level === 'regional' ? el('span', { class: 'badge', text: t('levelRegional') }) : null,
      s.level === 'national' ? el('span', { class: 'badge', text: t('levelNational') }) : null,
      age ? el('span', { class: 'badge' }, t('age'), el('span', { ...EN, text: age })) : null,
      placeBadge(s, picked)
    );

    const contact = el('ul', { class: 'contact' });
    if (s.phone) contact.append(el('li', {}, t('phone'), el('span', EN, ...phoneNodes(s.phone))));
    if (s.email) contact.append(el('li', {}, t('email'), el('a', { href: 'mailto:' + s.email, dir: 'ltr', text: s.email })));
    if (s.webpage) contact.append(el('li', {}, t('website'), link(s.webpage, t('webpageLink'))));
    if (!contact.children.length) contact.append(el('li', { text: t('noContact') }));

    const stale = ageInDays(s.lastUpdated) > STALE_DAYS;

    // Everything below "who it's for", folded away until "Show full details" is pressed.
    const more = el('div', { class: 'more', id: 'more-' + s.id + '-' + ++moreSeq },
      el('h4', { text: t('contact') }),
      contact,
      whereBlock(s, picked),
      el('h4', { text: t('howIn') }),
      el('ul', { class: 'routes' }, (s.referralRoutes || []).map(routeNode)),
      el('h4', { text: t('whoJoin') }),
      el('ul', {}, (s.eligibility || []).map((x) => el('li', { ...EN, text: x }))),
      s.exclusions && s.exclusions.length ? el('h4', { text: t('whoNot') }) : null,
      s.exclusions && s.exclusions.length ? el('ul', {}, s.exclusions.map((x) => el('li', { ...EN, text: x }))) : null,
      projectsBlock(s, picked, on),
      s.coachNotes ? el('h4', { text: t('goodToKnow') }) : null,
      s.coachNotes ? el('p', { ...EN, text: s.coachNotes }) : null,
      s.cost ? el('h4', { text: t('cost') }) : null,
      s.cost ? el('ul', {}, el('li', { ...EN, text: s.cost })) : null,
      s.languages ? el('h4', { text: t('languages') }) : null,
      s.languages ? el('ul', {}, el('li', { ...EN, text: s.languages })) : null,
      s.organisationOverview ? el('h4', { text: t('aboutOrg') }) : null,
      s.organisationOverview ? el('p', { ...EN, text: s.organisationOverview }) : null,
      el('p', { class: 'meta', text: t('lastChecked', { date: fmtDate(s.lastUpdated) }) }));
    const toggle = moreToggle(s, more, Boolean(opts && opts.open));

    const node = el('article', { class: 'card', 'data-scheme': s.id },
      el('div', { class: 'card-head' },
        thumb(s),
        el('div', { class: 'card-title' },
          el('h3', { ...EN, text: s.name }),
          el('p', { ...EN, class: 'org', text: s.organisation }),
          badges)),
      rec.why ? el('p', { class: 'why', dir: 'auto', text: rec.why }) : null,
      rec.check_first ? el('p', { class: 'check' }, t('checkFirst'), el('span', { dir: 'auto', text: rec.check_first })) : null,
      el('p', { ...EN, class: 'whofor', text: s.whoFor }),
      stale ? el('p', { class: 'stale', text: t('stale') }) : null,
      more,
      el('div', { class: 'tools' },
        toggle,
        el('button', { type: 'button', class: 'btn secondary small', text: t('copy'), onclick: (e) => copyDetails(s, e.currentTarget, picked, on) }),
        window.ACCESS ? window.ACCESS.listenButton(() => spokenText(s, picked), 'en-GB', t('listenTo', { name: s.name })) : null),
      // "Report a problem with this listing" (feedback.js). Only there when feedback is switched on.
      window.FEEDBACK ? window.FEEDBACK.cardControl(s) : null
    );
    return node;
  }

  // Cards start folded so several fit on a screen. "Show full details" opens one; the rest of its details sit
  // in a section with an id the button points to. A single result starts open.
  let moreSeq = 0;
  function moreToggle(s, more, startOpen) {
    const label = el('span', {});
    const chevron = el('span', { class: 'chev', 'aria-hidden': 'true' });
    const btn = el('button', { type: 'button', class: 'btn small more-btn', 'aria-controls': more.id }, chevron, label);
    let tracked = false;
    const set = (open) => {
      more.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      label.textContent = open ? t('lessDetails') : t('moreDetails');
      btn.closest('.card')?.classList.toggle('open', open);
    };
    btn.addEventListener('click', () => {
      const open = more.hidden;
      set(open);
      if (open && !tracked && window.USAGE) { tracked = true; window.USAGE.track('expand', { s: s.id }); }
    });
    btn._set = set;
    queueMicrotask(() => set(startOpen));
    return btn;
  }

  // Opens or folds every card in a set of results.
  function setAllCards(container, open) {
    for (const b of container.querySelectorAll('.more-btn')) b._set(open);
  }

  // What the Listen button on a card reads out. Scheme details are in English, so they are read in English.
  function spokenText(s, picked) {
    const parts = [s.name + '. ' + s.organisation + '.'];
    if (s.whoFor) parts.push(s.whoFor);
    for (const x of picked || []) parts.push(x.project.name + (x.sessions.length ? ': ' + x.sessions.map((c) => [c.session.name, LISTING.timeWords(c.session), c.session.venue && venues.has(c.session.venue) ? venues.get(c.session.venue).name : ''].filter(Boolean).join(', ')).join('; ') : '') + '.');
    if (s.phone) parts.push('Phone: ' + s.phone + '.');
    if (s.email) parts.push('Email: ' + s.email + '.');
    if (s.referralRoutes && s.referralRoutes.length) parts.push('How to get in: ' + s.referralRoutes.join('. ') + '.');
    return parts.join(' ');
  }

  function copyText(s, picked, on) {
    const lines = [s.name + ' - ' + s.organisation, s.whoFor];
    for (const x of picked || []) {
      if (x.sessions.length) for (const c of x.sessions) lines.push(x.project.name + [c.session.name, LISTING.timeWords(c.session) || c.session.note || c.session.when, venueLineOf(c.session.venue), ...dateWords(c.dates, on)].filter(Boolean).map((w) => ', ' + w).join(''));
      else lines.push(x.project.name + [x.project.when, ...dateWords(x.dates, on)].filter(Boolean).map((w) => '. ' + w).join(''));
    }
    if (s.phone) lines.push(t('phone') + s.phone);
    if (s.email) lines.push(t('email') + s.email);
    if (s.webpage) lines.push(t('website') + s.webpage);
    if (s.referralRoutes && s.referralRoutes.length) lines.push(t('howIn') + ': ' + s.referralRoutes.join('; '));
    lines.push(t('lastChecked', { date: fmtDate(s.lastUpdated) }) + ' ' + t('copyConfirm'));
    return lines.join('\n');
  }

  async function copyDetails(s, btn, picked, on) {
    const old = btn.textContent;
    try {
      await navigator.clipboard.writeText(copyText(s, picked, on));
      btn.textContent = t('copied');
      if (window.USAGE) window.USAGE.track('copy', { s: s.id });
    } catch {
      btn.textContent = t('copyFailed');
    }
    setTimeout(() => (btn.textContent = old), 2000);
  }

  // ---------- conversation ----------
  // Screen readers: the conversation area is not announced as a whole (that would read every card in full).
  // Instead a short summary of each reply goes into a hidden status message. Clearing it first makes a
  // screen reader announce it again even if the wording is the same as last time.
  const statusEl = $('#sr-status');
  let announceTimer = null;
  function announce(text) {
    if (!statusEl) return;
    clearTimeout(announceTimer);
    statusEl.textContent = '';
    announceTimer = setTimeout(() => { statusEl.textContent = text; }, 150);
  }

  function bubble(kind, text) {
    const b = el('div', { class: 'bubble ' + kind });
    for (const para of String(text).split(/\n{2,}/)) b.append(el('p', { dir: 'auto', text: para.trim() }));
    logEl.append(b);
    b.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return b;
  }

  // Support details shown for the kinds of urgent support below: the key of a whole sentence in i18n.js, for example
  // 'For domestic abuse support, call <name> on <number>.' Only add a contact once the programme team has checked it
  // from an official source, never from a general web search. With no key, the panel shows only 999 and NHS 111.
  // Checked by the programme team on 5 November 2026 against Kirklees Council, the Kirklees Safeguarding Children
  // Partnership "Duty and Advice quick reference numbers", Pennine Domestic Abuse Partnership and Refuge. The same
  // numbers are on safety.html: change both together.
  const URGENT_CONTACTS = {
    domestic_abuse: 'urgentDomesticAbuse',
    child_safeguarding: 'urgentChild',
    adult_safeguarding: 'urgentAdult',
  };

  function crisisPanel(types) {
    const kinds = Array.isArray(types) && types.length ? types : ['mental_health_crisis'];
    const lines = [];
    if (kinds.includes('mental_health_crisis')) {
      lines.push([t('crisisMhA'), el('a', { href: 'tel:01924316830', text: '01924 316830' }), t('crisisMhB')]);
    }
    if (kinds.includes('medical')) lines.push([t('crisisMedical')]);
    const others = ['domestic_abuse', 'child_safeguarding', 'adult_safeguarding'].filter((k) => kinds.includes(k));
    if (others.length) {
      lines.push([t('crisisOther')]);
      for (const k of others) if (URGENT_CONTACTS[k]) lines.push(window.I18N.telNodes(t(URGENT_CONTACTS[k])));
      lines.push([el('a', { href: 'safety.html' + location.search, class: 'safety-link', text: t('urgentAll') })]);
    }
    return el('div', { class: 'crisis', role: 'alert' }, lines.map((nodes) => el('p', {}, ...nodes)));
  }

  // Illustrations for the landing page. Four are picked at random each time the page loads or is reset.
  // To add more, drop the image into site/img/ and add its file name here.
  const PEOPLE = ['person-1.png', 'person-2.png', 'person-3.png', 'person-4.png', 'person-5.png', 'person-6.png', 'person-7.png'];
  const PEOPLE_SHOWN = 4;

  function showPeople() {
    const pool = PEOPLE.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    peopleEl.replaceChildren(...pool.slice(0, PEOPLE_SHOWN).map((f) => el('div', { class: 'person' }, el('img', { src: 'img/' + f, alt: '' }))));
  }

  function welcome() {
    document.body.classList.remove('chatting');
    showPeople();
    updatePlaceholder();
  }

  // The example text in the message box is only shown before the chat starts.
  function updatePlaceholder() {
    input.placeholder = document.body.classList.contains('chatting') ? '' : t('placeholder');
  }

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v;
    sendLabel.textContent = v ? t('sending') : t('send');
  }

  // ---------- tap-to-answer follow-up questions ----------
  // Each question is a group of radio buttons styled as large tap targets: the model's answers plus
  // "Prefer not to say". Picking answers and pressing Continue sends them as the person's next message,
  // together with anything typed in the message box. Typing alone still works as before.
  let questionSet = 0;
  function questionBox(qs) {
    const n = ++questionSet;
    const picked = new Map();
    const error = el('p', { class: 'answer-error', role: 'alert', hidden: true });
    const groups = qs.map((q, i) => {
      const name = 'q' + n + '-' + i;
      const choices = [...q.options, t('answerPreferNot')];
      return el('fieldset', { class: 'answer-q' },
        el('legend', { dir: 'auto', text: q.question }),
        el('div', { class: 'answer-options' }, choices.map((c, j) => el('label', { class: 'answer-option' },
          el('input', { type: 'radio', name, value: c, onchange: () => { picked.set(i, c); error.hidden = true; } }),
          el('span', { dir: 'auto', text: c })
        )))
      );
    });
    const box = el('div', { class: 'answer-box' },
      groups,
      el('p', { class: 'answer-hint', text: t('answerHint') }),
      error,
      el('button', { type: 'button', class: 'btn primary small answer-continue', text: t('answerContinue'), onclick: () => {
        const text = withAnswers(input.value);
        if (!text.trim()) { error.textContent = t('answerNeedOne'); error.hidden = false; return; }
        send(text);
      } })
    );
    pendingQuestions = { box, questions: qs, picked };
    return box;
  }

  // The person's message with any tapped answers in front of it, one line per question.
  let answerKind = null; // tapped, typed or both: counted (anonymously) when the answer is sent
  function withAnswers(typed) {
    const lines = [];
    if (pendingQuestions) {
      const tapped = pendingQuestions.picked.size > 0;
      const wrote = Boolean(typed && typed.trim());
      answerKind = tapped && wrote ? 'both' : tapped ? 'tapped' : wrote ? 'typed' : null;
      pendingQuestions.questions.forEach((q, i) => {
        if (pendingQuestions.picked.has(i)) lines.push(q.question + ' ' + pendingQuestions.picked.get(i));
      });
    }
    if (typed && typed.trim()) lines.push(typed.trim());
    return lines.join('\n').slice(0, 1500);
  }

  // Once a reply has been sent, the old questions stay on screen (showing what was picked) but can't be changed.
  function closeQuestions() {
    if (!pendingQuestions) return;
    if (answerKind && window.USAGE) window.USAGE.track('answers', { k: answerKind });
    answerKind = null;
    for (const f of pendingQuestions.box.querySelectorAll('fieldset')) f.disabled = true;
    const btn = pendingQuestions.box.querySelector('.answer-continue');
    const hint = pendingQuestions.box.querySelector('.answer-hint');
    if (btn) btn.remove();
    if (hint) hint.remove();
    pendingQuestions = null;
  }

  // A question that is already written out in the message is taken out of the message when it is shown as
  // a set of answers below, so the person doesn't read it twice.
  function withoutQuestions(message, qs) {
    let out = String(message);
    for (const q of qs) if (q.options.length && out.includes(q.question)) out = out.split(q.question).join(' ');
    out = out.replace(/[ \t]+/g, ' ').replace(/\s*\b(And|And also|Also|I|Oraz)\s*$/u, '').replace(/\s*اور\s*$/u, '').trim();
    return out;
  }

  // ---------- "Have we understood you?" ----------
  // Before the first set of cards in a conversation, the page shows what the AI took from the conversation
  // and asks the person to check it. The results are already here, so saying yes shows them straight away
  // (no second call to the AI). Saying something is wrong puts them back in the message box; their
  // correction is sent with a note that the summary was not right, and the AI looks again.
  function checkBox(data) {
    const staff = mode() === 'staff';
    const titleId = 'check-' + Date.now();
    const yes = el('button', { type: 'button', class: 'btn primary', text: t('checkYes'), onclick: () => confirmCheck() });
    const no = el('button', { type: 'button', class: 'btn secondary', text: t('checkNo'), onclick: () => {
      const fix = box.querySelector('.check-fix');
      fix.hidden = false;
      announce(fix.textContent);
      input.focus();
    } });
    const box = el('div', { class: 'bubble assistant check-summary', role: 'group', 'aria-labelledby': titleId },
      el('h2', { id: titleId, class: 'check-title', text: t(staff ? 'checkTitleStaff' : 'checkTitleSelf') }),
      el('p', { text: t('checkIntro') }),
      el('ul', { class: 'check-list' }, data.understood_needs.map((x) => el('li', { dir: 'auto', text: capitalise(x) }))),
      el('div', { class: 'check-actions' }, yes, no),
      el('p', { class: 'check-fix', hidden: true, text: t('checkFix') })
    );
    if (window.ACCESS) box.append(el('div', { class: 'bubble-tools' }, window.ACCESS.listenButton(() => [...box.querySelectorAll('h2, p:not([hidden]), li')].map((p) => p.textContent).join(' '), window.I18N.locale)));
    return box;
  }

  // Summary lines are written as short phrases ("off work sick"); each starts with a capital on screen.
  function capitalise(x) {
    const s = String(x).trim();
    return s.charAt(0).toLocaleUpperCase(window.I18N.locale) + s.slice(1);
  }

  function confirmCheck() {
    if (!pendingCheck) return;
    const { data, box } = pendingCheck;
    pendingCheck = null;
    checked = true;
    box.querySelector('.check-actions').replaceWith(el('p', { class: 'check-done', text: t('checkThanks') }));
    const fix = box.querySelector('.check-fix');
    if (fix) fix.remove();
    if (window.USAGE) window.USAGE.track('summary', { k: 'yes' });
    showReply(data);
  }

  // The person has written something new while the summary was waiting: record in the history that the
  // summary was shown and not confirmed, so the AI knows to look again, and close the check.
  function closeCheck() {
    if (!pendingCheck) return;
    const { data, box } = pendingCheck;
    pendingCheck = null;
    const actions = box.querySelector('.check-actions');
    if (actions) actions.remove();
    const fix = box.querySelector('.check-fix');
    if (fix) fix.remove();
    if (window.USAGE) window.USAGE.track('summary', { k: 'changed' });
    history.push({ role: 'assistant', content: 'Here is what I understood: ' + data.understood_needs.join('; ') + '.\n\n(Summary shown to the person to check. They said something was not right, so no services were shown yet.)' });
  }

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    if (needMode()) return;
    setBusy(true);
    // Only the latest reply offers "other options".
    for (const n of logEl.querySelectorAll('.more-options')) n.remove();
    document.body.classList.add('chatting');
    updatePlaceholder();
    closeQuestions();
    closeCheck();
    bubble('user', text);
    input.value = '';
    history.push({ role: 'user', content: text });
    const thinking = bubble('thinking', t('thinking'));
    announce(t('thinking'));

    try {
      if (!API) {
        thinking.remove();
        history.pop();
        input.value = text;
        announce(bubble('error', t('notConnected')).textContent);
        return;
      }
      const r = await fetch(API + '/chat', {
        method: 'POST',
        // Admin test mode (team-test.js): the Worker counts this search apart from real use.
        headers: { 'content-type': 'application/json', ...(window.HWL_TEAM_TEST ? { 'x-team-test': window.HWL_TEAM_TEST } : {}) },
        body: JSON.stringify({ mode: mode(), lang: window.I18N.lang, messages: history }),
      });
      const data = await r.json().catch(() => ({}));
      thinking.remove();
      if (!r.ok) {
        history.pop();
        input.value = text;
        // The Worker's error wording is English, so other languages get the page's own wording for the same problem.
        const own = r.status === 429 ? t('rateLimited') : r.status === 503 ? t('busy') : t('generic');
        announce(bubble('error', window.I18N.lang === 'en' ? data.error || t('generic') : own).textContent);
        return;
      }

      data.understood_needs = Array.isArray(data.understood_needs) ? data.understood_needs.filter((x) => typeof x === 'string' && x.trim()) : [];
      const hasCards = (data.recommendations || []).some((x) => services.has(x.id));
      // First results in this conversation: check the summary with the person before showing the cards.
      if (!checked && hasCards && !data.safety_concern && data.status === 'results' && data.understood_needs.length) {
        const box = checkBox(data);
        logEl.append(box);
        box.append(privacyNote(data));
        pendingCheck = { data, box };
        announce([...box.querySelectorAll('h2, p:not([hidden]), li')].filter((n) => !n.matches('.privacy-note:not(.pii-note)')).map((n) => n.textContent.trim()).join(' '));
        box.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      showReply(data);
    } catch {
      thinking.remove();
      history.pop();
      input.value = text;
      announce(bubble('error', t('network')).textContent);
    } finally {
      setBusy(false);
      // Put the cursor back in the message box without scrolling down to it.
      input.focus({ preventScroll: true });
    }
  }

  // Under every reply: a reminder that nothing typed is saved. When the message looks like it holds personal
  // details, a fuller note says so and reassures. The AI flags names, addresses and dates of birth (pii_detected);
  // the page also checks the latest message itself for emails, phone numbers, postcodes and NI numbers, using
  // the same patterns as feedback, so the note still shows if the AI misses them.
  function privacyNote(data) {
    const last = [...history].reverse().find((m) => m.role === 'user');
    const own = !!(last && window.FEEDBACK && window.FEEDBACK.redact && window.FEEDBACK.redact(last.content) !== last.content);
    const personal = data.pii_detected === true || own;
    return el('p', { class: 'privacy-note' + (personal ? ' pii-note' : ''), dir: 'auto', text: t(personal ? 'pii' : 'notStored') });
  }

  // Shows a reply from the AI (its message, any questions, and the scheme cards) and adds it to the history.
  function showReply(data) {
    {
      // Follow-up questions. With answer options they are shown as tap-to-answer groups under the message.
      // Without, they are listed under the message if the AI only said it had questions without writing them.
      const asked = Array.isArray(data.question_options) && data.question_options.length
        ? data.question_options.filter((q) => q && typeof q.question === 'string' && q.question.trim()).map((q) => ({ question: q.question.trim(), options: Array.isArray(q.options) ? q.options.filter((o) => typeof o === 'string' && o.trim()) : [] }))
        : (Array.isArray(data.follow_up_questions) ? data.follow_up_questions : []).filter((q) => typeof q === 'string' && q.trim()).map((q) => ({ question: q.trim(), options: [] }));
      const tappable = asked.filter((q) => q.options.length);
      const questions = asked.map((q) => q.question);
      const message = tappable.length ? withoutQuestions(data.message, tappable) : data.message;
      const b = message ? bubble('assistant', message) : el('div', { class: 'bubble assistant' });
      if (!message) logEl.append(b);
      if (data.safety_concern) b.append(crisisPanel(data.urgent_types));
      const squash = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      const missing = asked.filter((q) => !q.options.length && !squash(data.message).includes(squash(q.question))).map((q) => q.question);
      if (missing.length) b.append(el('ol', { class: 'questions', dir: 'auto' }, missing.map((q) => el('li', { text: q }))));
      if (tappable.length && !data.safety_concern) b.append(questionBox(tappable));
      const needs = data.understood_needs || [];
      // Shown only under results that didn't go through the summary check (for example, no services found).
      // Not under questions (the check comes next) and not once the summary has been checked.
      if (needs.length && !data.safety_concern && data.status === 'results' && !checked) b.append(el('p', { class: 'understood', dir: 'auto', text: t('understood') + needs.join(t('listSep')) + t('end') }));
      b.append(privacyNote(data));
      // Listen button: reads the whole reply, including any urgent support panel and questions, in the page's language.
      if (window.ACCESS) {
        const reply = b;
        b.append(el('div', { class: 'bubble-tools' }, window.ACCESS.listenButton(() => [...reply.querySelectorAll('p:not([hidden]), li, legend, .answer-option span')].filter((p) => !p.matches('.privacy-note:not(.pii-note)')).map((p) => p.textContent).join(' '), window.I18N.locale)));
      }
      // The chat message comes first, with the scheme cards underneath it.
      const list = (data.recommendations || []).filter((r) => services.has(r.id));
      const day = typeof data.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.date) ? data.date : null;
      const recs = list.map((r) => card(r, { open: list.length === 1, date: day })).filter(Boolean);
      if (recs.length) {
        // A heading screen reader users can jump to; hidden on screen, where the cards speak for themselves.
        logEl.append(el('h2', { class: 'visually-hidden', text: t('resultsHeading') }));
        const cardsEl = el('div', { class: 'cards' }, recs);
        // With more than one card, a button to open or fold them all at once.
        if (recs.length > 1) {
          let allOpen = false;
          const allBtn = el('button', { type: 'button', class: 'link-btn all-btn', text: t('openAll'), onclick: () => {
            allOpen = !allOpen;
            setAllCards(cardsEl, allOpen);
            allBtn.textContent = allOpen ? t('closeAll') : t('openAll');
          } });
          logEl.append(el('div', { class: 'cards-bar' }, allBtn));
        }
        logEl.append(cardsEl);
        // After every set of results, offer a quick way to ask for different services. The AI is told not to
        // repeat services already shown. With one card the wording asks about that one; with more, about others.
        if (!data.safety_concern) {
          const staffMode = mode() === 'staff';
          const ask = recs.length === 1 ? t(staffMode ? 'otherOptionsStaff' : 'otherOptionsSelf') : t(staffMode ? 'moreOptionsStaff' : 'moreOptionsSelf');
          logEl.append(el('div', { class: 'more-options' }, el('button', { type: 'button', class: 'chip', text: ask, onclick: () => { if (window.USAGE) window.USAGE.track('other'); send(ask); } })));
        }
      }
      // Feedback under a result reply (feedback.js): "Was this helpful?" when it has cards, and "Tell us what's
      // missing" always. Never under urgent support or a reply that asks questions. Only scheme ids are sent.
      if (window.FEEDBACK && data.status === 'results' && !data.safety_concern) {
        const fb = window.FEEDBACK.replyControls((data.recommendations || []).map((x) => x.id).filter((id) => services.has(id)));
        if (fb) logEl.append(fb);
      }
      // Screen readers hear the reply (and any questions) and how many services
      // were suggested, but not the cards themselves; they can move through those with their heading keys.
      // The urgent support panel is left out here because it announces itself (role=alert).
      const replyText = [...b.querySelectorAll('p:not([hidden]), li, legend')].filter((n) => !n.closest('.bubble-tools, .crisis') && !n.matches('.privacy-note:not(.pii-note)')).map((n) => n.textContent.trim()).join(' ');
      announce(replyText + (recs.length ? ' ' + (recs.length === 1 ? t('servicesOne') : t('servicesMany', { n: recs.length })) : ''));
      // Keep the reader at the start of the reply, with the cards below it, rather than at the end of the cards.
      b.scrollIntoView({ block: 'start', behavior: 'smooth' });

      // Remember which services were shown so follow-up questions make sense.
      const shown = (data.recommendations || []).map((x) => x.id).join(', ');
      // The Worker counts the "(Follow-up questions asked: N)" marker to keep to its limit on questions.
      const askedCount = questions.length;
      const notInMessage = asked.filter((q) => !squash(data.message).includes(squash(q.question))).map((q) => q.question);
      history.push({ role: 'assistant', content: data.message + (notInMessage.length ? '\n\n' + notInMessage.join('\n') : '') + (shown ? '\n\n(Services shown: ' + shown + ')' : '') + (askedCount ? '\n\n(Follow-up questions asked: ' + askedCount + ')' : '') });
    }
  }

  function reset() {
    if (window.ACCESS) window.ACCESS.stop();
    history = [];
    pendingQuestions = null;
    pendingCheck = null;
    checked = false;
    logEl.replaceChildren();
    // Start again clears "Who is this for?" too, so the next person chooses for themselves.
    for (const r of document.querySelectorAll('input[name=mode]')) r.checked = false;
    clearModeError();
    input.value = '';
    welcome();
    input.focus();
  }

  // ---------- anonymous usage counts (usage.js) ----------
  // Which kind of link was opened on a card. Only the scheme id and the kind are counted.
  function linkKind(a) {
    if (a.closest('.places')) return a.classList.contains('map-link') ? 'map' : 'directions';
    const href = a.getAttribute('href') || '';
    if (href.startsWith('tel:')) return 'phone';
    if (href.startsWith('mailto:')) return 'email';
    if (a.closest('.routes')) return 'referral';
    if (a.closest('.contact')) return 'website';
    return null;
  }
  // Links that mean the person may be getting in touch: after one of these, we ask "Did you get in touch?"
  // when they come back to this page.
  const CONTACT_KINDS = new Set(['referral', 'website', 'phone', 'email']);
  const pendingAsk = new Map(); // scheme id -> card
  const asked = new Set();
  let away = false;

  function onLinkOpen(e) {
    const a = e.target.closest('a');
    const cardEl = a && a.closest('.card');
    if (!cardEl || (e.type === 'auxclick' && e.button !== 1)) return;
    const kind = linkKind(a);
    if (!kind) return;
    const id = cardEl.dataset.scheme;
    if (window.USAGE) window.USAGE.track('link', { s: id, k: kind });
    if (CONTACT_KINDS.has(kind) && !asked.has(id)) pendingAsk.set(id, cardEl);
  }
  logEl.addEventListener('click', onLinkOpen);
  logEl.addEventListener('auxclick', onLinkOpen);

  // Listen buttons: counted when someone starts listening (the button's own handler has already run).
  logEl.addEventListener('click', (e) => {
    const b = e.target.closest('.listen');
    if (b && b.getAttribute('aria-pressed') === 'true' && window.USAGE) window.USAGE.track('listen', { k: b.closest('.card') ? 'card' : 'reply' });
  });

  // "Did you get in touch?" Asked once per service, on the card, when the person comes back to this page after
  // opening one of its contact or referral links. Nothing blocks them on the way out.
  function askContact(id, cardEl) {
    const s = services.get(id);
    if (!s || !cardEl.isConnected) return;
    const qId = 'ask-' + id + '-' + Date.now();
    const question = t(mode() === 'staff' ? 'askReferred' : 'askContacted', { name: s.name });
    const box = el('div', { class: 'contact-ask', role: 'group', 'aria-labelledby': qId },
      el('p', { id: qId, class: 'contact-q', dir: 'auto', text: question }),
      el('div', { class: 'contact-btns' }, ['yes', 'notyet', 'no'].map((k) => el('button', {
        type: 'button', class: 'btn secondary small', text: t('ask_' + k),
        onclick: () => {
          if (window.USAGE) window.USAGE.track('contacted', { s: id, k });
          box.replaceChildren(el('p', { class: 'contact-thanks', text: t('askThanks') }));
          announce(t('askThanks'));
        },
      })))
    );
    cardEl.append(box);
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    announce(question);
  }
  function leave() { if (pendingAsk.size) away = true; }
  function comeBack() {
    if (!away || document.hidden) return;
    away = false;
    for (const [id, cardEl] of pendingAsk) {
      pendingAsk.delete(id);
      if (asked.has(id)) continue;
      asked.add(id);
      askContact(id, cardEl);
    }
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? leave() : comeBack()));
  window.addEventListener('blur', leave);
  window.addEventListener('focus', comeBack);

  // ---------- wiring ----------
  // Switching language changes the fixed text (i18n.js does that). Messages and
  // cards already on screen stay as they are; new replies come back in the new language.
  window.I18N.onChange(() => {
    updatePlaceholder();
    if (!busy) sendLabel.textContent = t('send');
  });
  // A typed message also carries any answers tapped on the latest questions.
  form.addEventListener('submit', (e) => { e.preventDefault(); send(withAnswers(input.value)); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(withAnswers(input.value)); }
  });
  $('#reset').addEventListener('click', reset);
  // The logo goes back to the main page (a fresh start), keeping the language, text size and contrast in the address.
  $('#home-link').addEventListener('click', (e) => { e.currentTarget.href = './' + location.search; });
  // The same for "Help with abuse and safety" in the footer, so the safety page opens in the same language.
  $('#safety-link').addEventListener('click', (e) => { e.currentTarget.href = 'safety.html' + location.search; });

  // Feedback links (feedback.js). They appear once the Worker's /health says feedback is on.
  if (window.FEEDBACK) window.FEEDBACK.init({ el, announce, api: API, mode: () => mode() || 'public', services: () => services, organisations: () => organisations });

  // ---------- floating emergency footer ----------
  // The footer floats at the bottom of the screen when the page opens, fades out once the person scrolls
  // down, and is always shown in its own place at the very end of the page. It also comes back if they
  // scroll to the top, or if keyboard focus moves into it. While faded it is only made transparent, so
  // screen readers can still read it at any time.
  (() => {
    const footer = document.querySelector('.site-footer');
    const spot = document.getElementById('footer-spot');
    if (!footer || !spot || !('IntersectionObserver' in window)) return;
    let atEnd = false;
    const update = () => {
      const show = window.scrollY < 40 || atEnd || footer.matches(':focus-within');
      footer.classList.toggle('footer-faded', !show);
    };
    new IntersectionObserver(([e]) => { atEnd = e.isIntersecting; update(); }).observe(spot);
    window.addEventListener('scroll', update, { passive: true });
    footer.addEventListener('focusin', update);
    footer.addEventListener('focusout', () => setTimeout(update, 0));
    update();
  })();

  fetch('services.json')
    .then((r) => r.json())
    .then((d) => { services = new Map(d.services.map((s) => [s.id, s])); organisations = d.organisations || []; venues = new Map((d.venues || []).map((v) => [v.id, v])); })
    .catch(() => bubble('error', t('loadFailed')));

  // On the preview site (see the preview workflow), a label so testers know this isn't the live version.
  if (window.FINDER_CONFIG && window.FINDER_CONFIG.preview) {
    const notice = document.querySelector('.notice');
    const bar = el('p', { class: 'preview-bar', role: 'note', 'data-i18n': 'previewBar', text: t('previewBar') });
    if (notice) notice.before(bar);
  }

  welcome();
})();
