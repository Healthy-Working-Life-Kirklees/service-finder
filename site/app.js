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
  const chipsEl = $('#chips');
  const peopleEl = $('#people');
  const sendLabel = $('#send-label');

  // Everything lives in memory only. Nothing is written to storage.
  let services = new Map();
  let history = [];
  let busy = false;

  // Page text comes from i18n.js. The example questions are in there too.
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

  function places(s) {
    const lines = s.locations || [];
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
  function placeBadge(s) {
    const towns = (s.areas || []).filter((a) => a !== 'Kirklees-wide' && a !== 'Online');
    const p = places(s);
    const text = towns.length ? towns[0] + (towns.length > 1 ? ' +' + (towns.length - 1) : '') : p.labels[0];
    return text ? el('span', { class: 'badge place' }, pinSvg(), el('span', { ...(towns.length ? EN : {}), text })) : null;
  }

  function whereBlock(s) {
    const p = places(s);
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

  function card(rec) {
    const s = services.get(rec.id);
    if (!s) return null;

    const badges = el('div', { class: 'badges' },
      rec.fit === 'strong' ? el('span', { class: 'badge fit-strong', text: t('fitStrong') }) : null,
      rec.fit === 'possible' ? el('span', { class: 'badge fit-possible', text: t('fitPossible') }) : null,
      s.open ? el('span', { class: 'badge live', text: t('open') }) : el('span', { class: 'badge notopen', text: t('notOpen') }),
      s.selfReferral && s.selfReferral.allowed === 'yes' ? el('span', { class: 'badge self', text: t('selfYes') }) : null,
      s.selfReferral && s.selfReferral.allowed === 'partly' ? el('span', { class: 'badge self', text: t('selfPartly') }) : null,
      s.selfReferral && s.selfReferral.allowed === 'tbc' ? el('span', { class: 'badge', text: t('selfTbc') }) : null,
      s.selfReferral && s.selfReferral.allowed === 'no' ? el('span', { class: 'badge', text: t('selfNo') }) : null,
      s.level === 'regional' ? el('span', { class: 'badge', text: t('levelRegional') }) : null,
      s.level === 'national' ? el('span', { class: 'badge', text: t('levelNational') }) : null,
      s.age ? el('span', { class: 'badge' }, t('age'), el('span', { ...EN, text: s.age })) : null,
      placeBadge(s)
    );

    const contact = el('ul', { class: 'contact' });
    if (s.phone) contact.append(el('li', {}, t('phone'), el('span', EN, ...phoneNodes(s.phone))));
    if (s.email) contact.append(el('li', {}, t('email'), el('a', { href: 'mailto:' + s.email, dir: 'ltr', text: s.email })));
    if (s.webpage) contact.append(el('li', {}, t('website'), link(s.webpage, t('webpageLink'))));
    if (!contact.children.length) contact.append(el('li', { text: t('noContact') }));

    const stale = ageInDays(s.lastUpdated) > STALE_DAYS;
    const staff = mode() === 'staff';

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
      el('h4', { text: t('contact') }),
      contact,
      whereBlock(s),
      el('h4', { text: t('howIn') }),
      el('ul', { class: 'routes' }, (s.referralRoutes || []).map(routeNode)),
      el('details', { open: staff }, el('summary', { text: t('whoJoin') }),
        el('ul', {}, (s.eligibility || []).map((x) => el('li', { ...EN, text: x }))),
        s.exclusions && s.exclusions.length ? el('h4', { text: t('whoNot') }) : null,
        s.exclusions && s.exclusions.length ? el('ul', {}, s.exclusions.map((x) => el('li', { ...EN, text: x }))) : null
      ),
      el('details', {}, el('summary', { text: t('whatWhere') }),
        el('ul', {}, (s.activities || []).map((a) => el('li', { ...EN, text: a.name + ': ' + a.summary + (a.duration ? ' (' + a.duration + ')' : '') }))),
        el('h4', { text: t('where') }),
        el('ul', {}, (s.locations || []).map((x) => el('li', { ...EN, text: x }))),
        s.cost ? el('h4', { text: t('cost') }) : null,
        s.cost ? el('ul', {}, el('li', { ...EN, text: s.cost })) : null,
        s.languages ? el('h4', { text: t('languages') }) : null,
        s.languages ? el('ul', {}, el('li', { ...EN, text: s.languages })) : null
      ),
      el('p', { class: 'meta', text: t('lastChecked', { date: fmtDate(s.lastUpdated) }) }),
      stale ? el('p', { class: 'stale', text: t('stale') }) : null,
      el('div', { class: 'tools' },
        el('button', { type: 'button', class: 'btn secondary small', text: t('copy'), onclick: (e) => copyDetails(s, e.currentTarget) }),
        window.ACCESS ? window.ACCESS.listenButton(() => spokenText(s), 'en-GB', t('listenTo', { name: s.name })) : null),
      // "Report a problem with this listing" (feedback.js). Only there when feedback is switched on.
      window.FEEDBACK ? window.FEEDBACK.cardControl(s) : null
    );
    return node;
  }

  // What the Listen button on a card reads out. Scheme details are in English, so they are read in English.
  function spokenText(s) {
    const parts = [s.name + '. ' + s.organisation + '.'];
    if (s.whoFor) parts.push(s.whoFor);
    if (s.phone) parts.push('Phone: ' + s.phone + '.');
    if (s.email) parts.push('Email: ' + s.email + '.');
    if (s.referralRoutes && s.referralRoutes.length) parts.push('How to get in: ' + s.referralRoutes.join('. ') + '.');
    return parts.join(' ');
  }

  function copyText(s) {
    const lines = [s.name + ' - ' + s.organisation, s.whoFor];
    if (s.phone) lines.push(t('phone') + s.phone);
    if (s.email) lines.push(t('email') + s.email);
    if (s.webpage) lines.push(t('website') + s.webpage);
    if (s.referralRoutes && s.referralRoutes.length) lines.push(t('howIn') + ': ' + s.referralRoutes.join('; '));
    lines.push(t('lastChecked', { date: fmtDate(s.lastUpdated) }) + ' ' + t('copyConfirm'));
    return lines.join('\n');
  }

  async function copyDetails(s, btn) {
    const old = btn.textContent;
    try {
      await navigator.clipboard.writeText(copyText(s));
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

  // Support details shown for the kinds of urgent support below. Each one is written as a whole sentence, for example
  // 'For domestic abuse support, call <name> on <number>.' Leave a value as '' until the programme team has checked it
  // from an official source. Do not fill these in from a general web search. While a value is empty, the panel shows
  // only 999 and NHS 111.
  const URGENT_CONTACTS = {
    domestic_abuse: '',
    child_safeguarding: '',
    adult_safeguarding: '',
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
      for (const k of others) if (URGENT_CONTACTS[k]) lines.push(phoneNodes(URGENT_CONTACTS[k]));
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
    chipsEl.hidden = false;
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

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    if (needMode()) return;
    setBusy(true);
    chipsEl.hidden = true;
    // Only the latest reply offers "other options".
    for (const n of logEl.querySelectorAll('.more-options')) n.remove();
    document.body.classList.add('chatting');
    updatePlaceholder();
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
        headers: { 'content-type': 'application/json' },
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

      const b = bubble('assistant', data.message);
      if (data.safety_concern) b.append(crisisPanel(data.urgent_types));
      // Follow-up questions. The AI is asked to put them in its message too, but it sometimes only says it has
      // questions, so any question that isn't already in the message is listed under it.
      const questions = Array.isArray(data.follow_up_questions) ? data.follow_up_questions.filter((q) => typeof q === 'string' && q.trim()) : [];
      const squash = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      const missing = questions.filter((q) => !squash(data.message).includes(squash(q)));
      if (missing.length) b.append(el('ol', { class: 'questions', dir: 'auto' }, missing.map((q) => el('li', { text: q.trim() }))));
      const needs = Array.isArray(data.understood_needs) ? data.understood_needs : [];
      if (needs.length && !data.safety_concern) b.append(el('p', { class: 'understood', dir: 'auto', text: t('understood') + needs.join(t('listSep')) + t('end') }));
      if (data.pii_detected) b.append(el('p', { class: 'pii-note', text: t('pii') }));
      // Listen button: reads the whole reply, including any urgent support panel, in the page's language.
      if (window.ACCESS) {
        const reply = b;
        b.append(el('div', { class: 'bubble-tools' }, window.ACCESS.listenButton(() => [...reply.querySelectorAll('p, li')].map((p) => p.textContent).join(' '), window.I18N.locale)));
      }
      // The chat message comes first, with the scheme cards underneath it.
      const recs = (data.recommendations || []).map(card).filter(Boolean);
      if (recs.length) {
        // A heading screen reader users can jump to; hidden on screen, where the cards speak for themselves.
        logEl.append(el('h2', { class: 'visually-hidden', text: t('resultsHeading') }));
        const cardsEl = el('div', { class: 'cards' }, recs);
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
      const replyText = [...b.querySelectorAll('p, li')].filter((n) => !n.closest('.bubble-tools, .crisis')).map((n) => n.textContent.trim()).join(' ');
      announce(replyText + (recs.length ? ' ' + (recs.length === 1 ? t('servicesOne') : t('servicesMany', { n: recs.length })) : ''));
      // Keep the reader at the start of the reply, with the cards below it, rather than at the end of the cards.
      b.scrollIntoView({ block: 'start', behavior: 'smooth' });

      // Remember which services were shown so follow-up questions make sense.
      const shown = (data.recommendations || []).map((x) => x.id).join(', ');
      // The Worker counts the "(Follow-up questions asked: N)" marker to keep to its limit on questions.
      const asked = questions.length;
      history.push({ role: 'assistant', content: data.message + (missing.length ? '\n\n' + missing.join('\n') : '') + (shown ? '\n\n(Services shown: ' + shown + ')' : '') + (asked ? '\n\n(Follow-up questions asked: ' + asked + ')' : '') });
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

  function reset() {
    if (window.ACCESS) window.ACCESS.stop();
    history = [];
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
  // Example questions alternate between someone looking for support for themselves and someone helping another
  // person. Picking one also sets "Who is this for?" to match, so the reply is worded for the right person.
  function showChips() {
    const self = t('chipsSelf');
    const staff = t('chipsStaff');
    const items = [];
    for (let i = 0; i < Math.max(self.length, staff.length); i++) {
      if (self[i]) items.push(['public', self[i]]);
      if (staff[i]) items.push(['staff', staff[i]]);
    }
    chipsEl.replaceChildren(...items.map(([m, q]) => el('button', { type: 'button', class: 'chip', text: q, onclick: () => { setMode(m); send(q); } })));
  }
  function setMode(m) {
    const radio = document.querySelector('input[name=mode][value=' + m + ']');
    if (radio) radio.checked = true;
    clearModeError();
  }
  showChips();
  // Switching language changes the fixed text (i18n.js does that) and the example questions. Messages and
  // cards already on screen stay as they are; new replies come back in the new language.
  window.I18N.onChange(() => {
    showChips();
    updatePlaceholder();
    if (!busy) sendLabel.textContent = t('send');
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
  });
  $('#reset').addEventListener('click', reset);

  // Feedback links (feedback.js). They appear once the Worker's /health says feedback is on.
  if (window.FEEDBACK) window.FEEDBACK.init({ el, announce, api: API, mode: () => mode() || 'public', services: () => services });

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
    .then((d) => { services = new Map(d.services.map((s) => [s.id, s])); })
    .catch(() => bubble('error', t('loadFailed')));

  // MVP team links: only present when the deploy switched the MVP tools on.
  if (window.FINDER_CONFIG && window.FINDER_CONFIG.mvpTools) {
    document.body.prepend(el('nav', { class: 'teambar', 'aria-label': 'MVP team' },
      el('div', { class: 'wrap' }, el('strong', { text: 'MVP team only' }), el('a', { href: 'mvp/help.html', text: 'Help' }), el('a', { href: 'mvp/services.html', text: 'All services' }), el('a', { href: 'mvp/log.html', text: 'Issues and actions log' }), el('a', { href: 'mvp/feedback.html', text: 'Feedback and usage' }))));
  }

  welcome();
})();
