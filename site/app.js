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
  const mode = () => document.querySelector('input[name=mode]:checked').value;

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
      s.age ? el('span', { class: 'badge' }, t('age'), el('span', { ...EN, text: s.age })) : null
    );

    const contact = el('ul', { class: 'contact' });
    if (s.phone) contact.append(el('li', {}, t('phone'), el('span', EN, ...phoneNodes(s.phone))));
    if (s.email) contact.append(el('li', {}, t('email'), el('a', { href: 'mailto:' + s.email, dir: 'ltr', text: s.email })));
    if (s.webpage) contact.append(el('li', {}, t('website'), link(s.webpage, t('webpageLink'))));
    if (!contact.children.length) contact.append(el('li', { text: t('noContact') }));

    const stale = ageInDays(s.lastUpdated) > STALE_DAYS;
    const staff = mode() === 'staff';

    const node = el('article', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', { class: 'thumb thumb-' + thumbIndex(s.id), 'aria-hidden': 'true' }),
        el('div', { class: 'card-title' },
          el('h3', { ...EN, text: s.name }),
          el('p', { ...EN, class: 'org', text: s.organisation }),
          badges)),
      rec.why ? el('p', { class: 'why', dir: 'auto', text: rec.why }) : null,
      rec.check_first ? el('p', { class: 'check' }, t('checkFirst'), el('span', { dir: 'auto', text: rec.check_first })) : null,
      el('p', { ...EN, class: 'whofor', text: s.whoFor }),
      el('h4', { text: t('contact') }),
      contact,
      el('h4', { text: t('howIn') }),
      el('ul', {}, (s.referralRoutes || []).map(routeNode)),
      el('details', { open: staff }, el('summary', { text: t('whoJoin') }),
        el('ul', {}, (s.eligibility || []).map((x) => el('li', { ...EN, text: x }))),
        s.exclusions && s.exclusions.length ? el('h4', { text: t('whoNot') }) : null,
        s.exclusions && s.exclusions.length ? el('ul', {}, s.exclusions.map((x) => el('li', { ...EN, text: x }))) : null
      ),
      el('details', {}, el('summary', { text: t('whatWhere') }),
        el('ul', {}, (s.activities || []).map((a) => el('li', { ...EN, text: a.name + ': ' + a.summary + (a.duration ? ' (' + a.duration + ')' : '') }))),
        el('h4', { text: t('where') }),
        el('ul', {}, (s.locations || []).map((x) => el('li', { ...EN, text: x })))
      ),
      el('p', { class: 'meta', text: t('lastChecked', { date: fmtDate(s.lastUpdated) }) }),
      stale ? el('p', { class: 'stale', text: t('stale') }) : null,
      el('div', { class: 'tools' }, el('button', { type: 'button', class: 'btn secondary small', text: t('copy'), onclick: (e) => copyDetails(s, e.currentTarget) }))
    );
    return node;
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
    } catch {
      btn.textContent = t('copyFailed');
    }
    setTimeout(() => (btn.textContent = old), 2000);
  }

  // ---------- conversation ----------
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
  }

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v;
    sendLabel.textContent = v ? t('sending') : t('send');
  }

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    setBusy(true);
    chipsEl.hidden = true;
    document.body.classList.add('chatting');
    bubble('user', text);
    input.value = '';
    history.push({ role: 'user', content: text });
    const thinking = bubble('thinking', t('thinking'));

    try {
      if (!API) {
        thinking.remove();
        history.pop();
        input.value = text;
        bubble('error', t('notConnected'));
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
        bubble('error', window.I18N.lang === 'en' ? data.error || t('generic') : own);
        return;
      }

      const b = bubble('assistant', data.message);
      if (data.safety_concern) b.append(crisisPanel(data.urgent_types));
      const needs = Array.isArray(data.understood_needs) ? data.understood_needs : [];
      if (needs.length && !data.safety_concern) b.append(el('p', { class: 'understood', dir: 'auto', text: t('understood') + needs.join(t('listSep')) + t('end') }));
      if (data.pii_detected) b.append(el('p', { class: 'pii-note', text: t('pii') }));
      // The chat message comes first, with the scheme cards underneath it.
      const recs = (data.recommendations || []).map(card).filter(Boolean);
      if (recs.length) {
        const cardsEl = el('div', { class: 'cards' }, recs);
        logEl.append(cardsEl);
        cardsEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }

      // Remember which services were shown so follow-up questions make sense.
      const shown = (data.recommendations || []).map((x) => x.id).join(', ');
      // The Worker counts the "(Follow-up questions asked: N)" marker to keep to its limit on questions.
      const asked = Array.isArray(data.follow_up_questions) ? data.follow_up_questions.length : 0;
      history.push({ role: 'assistant', content: data.message + (shown ? '\n\n(Services shown: ' + shown + ')' : '') + (asked ? '\n\n(Follow-up questions asked: ' + asked + ')' : '') });
    } catch {
      thinking.remove();
      history.pop();
      input.value = text;
      bubble('error', t('network'));
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  function reset() {
    history = [];
    logEl.replaceChildren();
    input.value = '';
    welcome();
    input.focus();
  }

  // ---------- wiring ----------
  function showChips() {
    chipsEl.replaceChildren(...t('chips').map((q) => el('button', { type: 'button', class: 'chip', text: q, onclick: () => send(q) })));
  }
  showChips();
  // Switching language changes the fixed text (i18n.js does that) and the example questions. Messages and
  // cards already on screen stay as they are; new replies come back in the new language.
  window.I18N.onChange(() => {
    showChips();
    if (!busy) sendLabel.textContent = t('send');
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
  });
  $('#reset').addEventListener('click', reset);

  fetch('services.json')
    .then((r) => r.json())
    .then((d) => { services = new Map(d.services.map((s) => [s.id, s])); })
    .catch(() => bubble('error', t('loadFailed')));

  // MVP team links: only present when the deploy switched the MVP tools on.
  if (window.FINDER_CONFIG && window.FINDER_CONFIG.mvpTools) {
    document.body.prepend(el('nav', { class: 'teambar', 'aria-label': 'MVP team' },
      el('div', { class: 'wrap' }, el('strong', { text: 'MVP team only' }), el('a', { href: 'mvp/help.html', text: 'Help' }), el('a', { href: 'mvp/log.html', text: 'Issues and actions log' }))));
  }

  welcome();
})();
