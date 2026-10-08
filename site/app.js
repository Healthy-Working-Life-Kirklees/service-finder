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

  // Everything lives in memory only. Nothing is written to storage.
  let services = new Map();
  let history = [];
  let busy = false;

  const CHIPS = [
    "I've been off sick with back pain and want to get back to work",
    "I'm 20, not in work or education, and struggling with anxiety",
    "I support a client with a learning disability who wants a job",
    "I manage a small team and some of them are carers",
  ];

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
    return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  const ageInDays = (iso) => (Date.now() - Date.parse(iso)) / 86400000;

  // "Online self referral: https://..." -> link, otherwise plain text
  function routeNode(route) {
    const m = route.match(/^(.*?):?\s*(https?:\/\/\S+)$/);
    if (m) {
      const label = m[1].trim() || 'Online form';
      return el('li', {}, link(m[2], label));
    }
    return el('li', { text: route });
  }

  // ---------- cards ----------
  function card(rec) {
    const s = services.get(rec.id);
    if (!s) return null;

    const badges = el('div', { class: 'badges' },
      rec.fit === 'strong' ? el('span', { class: 'badge fit-strong', text: 'Strong match' }) : null,
      rec.fit === 'possible' ? el('span', { class: 'badge fit-possible', text: 'Worth checking' }) : null,
      s.open ? el('span', { class: 'badge live', text: 'Open to referrals' }) : el('span', { class: 'badge notopen', text: 'Not open yet' }),
      s.selfReferral && s.selfReferral.allowed === 'yes' ? el('span', { class: 'badge self', text: 'You can refer yourself' }) : null,
      s.selfReferral && s.selfReferral.allowed === 'partly' ? el('span', { class: 'badge self', text: 'Self-referral with a link from a professional' }) : null,
      s.selfReferral && s.selfReferral.allowed === 'tbc' ? el('span', { class: 'badge', text: 'Self-referral: to be confirmed' }) : null,
      s.age ? el('span', { class: 'badge', text: 'Age: ' + s.age }) : null
    );

    const contact = el('ul', { class: 'contact' });
    if (s.phone) contact.append(el('li', {}, 'Phone: ', ...phoneNodes(s.phone)));
    if (s.email) contact.append(el('li', {}, 'Email: ', el('a', { href: 'mailto:' + s.email, text: s.email })));
    if (s.webpage) contact.append(el('li', {}, 'Website: ', link(s.webpage, 'service web page')));
    if (!contact.children.length) contact.append(el('li', { text: 'No contact details are listed yet. Please check with the Healthy Working Life team.' }));

    const stale = ageInDays(s.lastUpdated) > STALE_DAYS;
    const staff = mode() === 'staff';

    const node = el('article', { class: 'card' },
      el('h3', { text: s.name }),
      el('p', { class: 'org', text: s.organisation }),
      badges,
      rec.why ? el('p', { class: 'why', text: rec.why }) : null,
      rec.check_first ? el('p', { class: 'check', text: 'Check first: ' + rec.check_first }) : null,
      el('p', { class: 'whofor', text: s.whoFor }),
      el('h4', { text: 'Contact' }),
      contact,
      el('h4', { text: 'How to get in' }),
      el('ul', {}, (s.referralRoutes || []).map(routeNode)),
      el('details', { open: staff }, el('summary', { text: 'Who can join' }),
        el('ul', {}, (s.eligibility || []).map((t) => el('li', { text: t }))),
        s.exclusions && s.exclusions.length ? el('h4', { text: 'Who it is not for' }) : null,
        s.exclusions && s.exclusions.length ? el('ul', {}, s.exclusions.map((t) => el('li', { text: t }))) : null
      ),
      el('details', {}, el('summary', { text: 'What happens and where' }),
        el('ul', {}, (s.activities || []).map((a) => el('li', { text: a.name + ': ' + a.summary + (a.duration ? ' (' + a.duration + ')' : '') }))),
        el('h4', { text: 'Where' }),
        el('ul', {}, (s.locations || []).map((t) => el('li', { text: t })))
      ),
      el('p', { class: 'meta', text: 'Information last checked: ' + fmtDate(s.lastUpdated) + '.' }),
      stale ? el('p', { class: 'stale', text: 'This entry is overdue a check, so please confirm the details with the service first.' }) : null,
      el('div', { class: 'tools' }, el('button', { type: 'button', class: 'btn secondary small', text: 'Copy details', onclick: (e) => copyDetails(s, e.currentTarget) }))
    );
    return node;
  }

  function copyText(s) {
    const lines = [s.name + ' - ' + s.organisation, s.whoFor];
    if (s.phone) lines.push('Phone: ' + s.phone);
    if (s.email) lines.push('Email: ' + s.email);
    if (s.webpage) lines.push('Website: ' + s.webpage);
    if (s.referralRoutes && s.referralRoutes.length) lines.push('How to get in: ' + s.referralRoutes.join('; '));
    lines.push('Information last checked: ' + fmtDate(s.lastUpdated) + '. Please confirm with the service before referring.');
    return lines.join('\n');
  }

  async function copyDetails(s, btn) {
    const old = btn.textContent;
    try {
      await navigator.clipboard.writeText(copyText(s));
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = "Couldn't copy";
    }
    setTimeout(() => (btn.textContent = old), 2000);
  }

  // ---------- conversation ----------
  function bubble(kind, text) {
    const b = el('div', { class: 'bubble ' + kind });
    for (const para of String(text).split(/\n{2,}/)) b.append(el('p', { text: para.trim() }));
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
    const t = Array.isArray(types) && types.length ? types : ['mental_health_crisis'];
    const lines = [];
    if (t.includes('mental_health_crisis')) {
      lines.push([
        'If you or someone else is in immediate danger, call 999. For urgent mental health support in Kirklees, call the 24-hour Single Point of Access team on ',
        el('a', { href: 'tel:01924316830', text: '01924 316830' }),
        ' or call NHS 111.',
      ]);
    }
    if (t.includes('medical')) lines.push(['If this is a medical emergency, call 999. If it is urgent but not an emergency, call NHS 111.']);
    const others = ['domestic_abuse', 'child_safeguarding', 'adult_safeguarding'].filter((k) => t.includes(k));
    if (others.length) {
      lines.push(['If someone is in immediate danger, call 999. If it is not an emergency, speak to your GP or call NHS 111 for help finding the right support.']);
      for (const k of others) if (URGENT_CONTACTS[k]) lines.push(phoneNodes(URGENT_CONTACTS[k]));
    }
    return el('div', { class: 'crisis', role: 'alert' }, lines.map((nodes) => el('p', {}, ...nodes)));
  }

  function welcome() {
    bubble('assistant',
      "Hi, I can help you find work and health support in Kirklees.\n\nTell me a bit about what you're looking for. It helps to know roughly how old the person is, whether they're working, the health issue getting in the way, and which part of Kirklees they're nearest to. You don't need to give any names or addresses.");
    chipsEl.hidden = false;
  }

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v;
    sendBtn.textContent = v ? 'Looking...' : 'Find services';
  }

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    setBusy(true);
    chipsEl.hidden = true;
    bubble('user', text);
    input.value = '';
    history.push({ role: 'user', content: text });
    const thinking = bubble('thinking', 'Looking through the services...');

    try {
      if (!API) {
        thinking.remove();
        history.pop();
        input.value = text;
        bubble('error', 'The AI service has not been connected to this page yet.');
        return;
      }
      const r = await fetch(API + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: mode(), messages: history }),
      });
      const data = await r.json().catch(() => ({}));
      thinking.remove();
      if (!r.ok) {
        history.pop();
        input.value = text;
        bubble('error', data.error || 'Something went wrong. Please try again.');
        return;
      }

      const b = bubble('assistant', data.message);
      if (data.safety_concern) b.append(crisisPanel(data.urgent_types));
      const needs = Array.isArray(data.understood_needs) ? data.understood_needs : [];
      if (needs.length && !data.safety_concern) b.append(el('p', { class: 'understood', text: 'What I have understood so far: ' + needs.join('; ') + '.' }));
      if (data.pii_detected) b.append(el('p', { class: 'pii-note', text: "Please don't type names, addresses, dates of birth or NHS numbers. You don't need to share them to get matches." }));
      const recs = (data.recommendations || []).map(card).filter(Boolean);
      if (recs.length) b.append(el('div', { class: 'cards' }, recs));

      // Remember which services were shown so follow-up questions make sense.
      const shown = (data.recommendations || []).map((x) => x.id).join(', ');
      // The Worker counts the "(Follow-up questions asked: N)" marker to keep to its limit on questions.
      const asked = Array.isArray(data.follow_up_questions) ? data.follow_up_questions.length : 0;
      history.push({ role: 'assistant', content: data.message + (shown ? '\n\n(Services shown: ' + shown + ')' : '') + (asked ? '\n\n(Follow-up questions asked: ' + asked + ')' : '') });
    } catch {
      thinking.remove();
      history.pop();
      input.value = text;
      bubble('error', 'Could not reach the service. Please check your connection and try again.');
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
  CHIPS.forEach((t) => chipsEl.append(el('button', { type: 'button', class: 'chip', text: t, onclick: () => send(t) })));
  form.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
  });
  $('#reset').addEventListener('click', reset);

  fetch('services.json')
    .then((r) => r.json())
    .then((d) => { services = new Map(d.services.map((s) => [s.id, s])); })
    .catch(() => bubble('error', 'Could not load the service information. Please refresh the page.'));

  // MVP team links: only present when the deploy switched the MVP tools on.
  if (window.FINDER_CONFIG && window.FINDER_CONFIG.mvpTools) {
    document.body.prepend(el('nav', { class: 'teambar', 'aria-label': 'MVP team' },
      el('div', { class: 'wrap' }, el('strong', { text: 'MVP team only' }), el('a', { href: 'mvp/help.html', text: 'Help' }), el('a', { href: 'mvp/log.html', text: 'Issues and actions log' }))));
  }

  welcome();
})();
