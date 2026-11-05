// Provider check page (provider-check.html#<code>): the named contact at one scheme checks everything the Support
// Finder holds about it, and either says it's all correct or sends changes. The link's code comes after the #, so
// it isn't sent to GitHub Pages. The Worker (worker/src/providerlink.js) only answers for a link that the team made
// on the All services page and hasn't cancelled, and that hasn't expired. Nothing sent here changes the finder by
// itself: the team checks it first. English only, like the other team and admin pages.
(() => {
  'use strict';
  const cfg = window.FINDER_CONFIG || {};
  const API = String(cfg.apiBase || '').replace(/\/$/, '');
  const $ = (s) => document.querySelector(s);
  const token = decodeURIComponent(location.hash.slice(1)).trim();

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = Boolean(v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }
  const list = (v) => (Array.isArray(v) ? v : []);
  const date = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const norm = (v) => JSON.stringify(v === undefined || v === '' ? null : v);

  const HEALTH = {
    any: 'Any health condition or disability',
    'mental-health': 'Mental health',
    'severe-mental-illness': 'Severe mental illness',
    'musculoskeletal-pain': 'Muscle, joint or back pain (musculoskeletal)',
    'substance-use': 'Drug or alcohol use',
    'learning-disability-autism': 'Learning disability or autism',
    'unpaid-caring': 'Unpaid caring',
  };
  const AUDIENCE = { individual: 'Individuals', employer: 'Employers', organisation: 'Organisations', student: 'Students' };
  const SELF = { yes: 'Yes', partly: 'Partly (some people can)', no: 'No, they need to be referred', tbc: 'Not decided yet' };

  // What's on the page, in order. kind: text (one line), area (a few lines), lines (one item per line),
  // checks (tick boxes), open (yes/no), self (self-referral), acts (what it offers).
  const SECTIONS = [
    ['About your service', [
      ['name', 'Name of the service', 'text', '', true],
      ['organisation', 'Organisation that runs it', 'text', '', true],
      ['whoFor', "Who it's for", 'area', 'One or two sentences, in plain words. Coaches see this on the service card.', true],
      ['acts', 'What it offers', 'acts', 'Each thing the service offers, with a short summary and how long it lasts if you know.'],
      ['open', 'Are you taking people on now?', 'open', 'If not, the finder will never suggest your service.'],
      ['status', 'Current status', 'text', 'For example "Live - open to referrals" or "Next course starts in March".', true],
      ['age', 'Age', 'text', 'For example 18+ or 16-25. Leave empty if there is no age limit.'],
      ['cost', 'Cost', 'text', 'Leave empty if it is free.'],
      ['languages', 'Languages and formats', 'text', 'For example "Interpreters available" or "Easy read leaflets". Leave empty if English only.'],
      ['workExperience', 'Does it include volunteering or work experience?', 'text', 'For example "No" or "Yes - a six-week placement".', true],
    ]],
    ['Who can use it', [
      ['eligibility', 'Who can use it', 'lines', 'What someone needs to be or have. One per line.'],
      ['gate', 'People must already be…', 'lines', 'Only if people must already be in a particular group, for example "Is a Kirklees College student". One per line. Leave empty if not.'],
      ['exclusions', "Who you can't help", 'lines', 'One per line. Leave empty if none.'],
      ['healthFocus', 'Health needs it is for', 'checks', 'Leave all unticked if people don\'t need a health condition to use it.'],
      ['audience', 'Who it works with', 'checks', ''],
      ['areas', 'Areas it covers', 'checks', 'Tick "Kirklees-wide" if anyone in Kirklees can use it, and "Online" if it can be done online or by phone.'],
      ['categories', 'What it helps with', 'checks', 'These are how the finder groups services. Tick all that fit.'],
    ]],
    ['How people get in', [
      ['referralRoutes', 'How people are referred or apply', 'lines', 'One way per line, for example "Referral from a work coach" or "Apply online: https://…". At least one.'],
      ['self', 'Can people refer themselves?', 'self', ''],
    ]],
    ['Where and how to get in touch', [
      ['locations', 'Where and when it runs', 'lines', 'Venues, days and times, or how it is delivered (for example "Phone and online"). One per line.'],
      ['phone', 'Phone number', 'text', ''],
      ['email', 'Email address', 'text', ''],
      ['webpage', 'Web page', 'text', 'The best page for people to find out more, starting https://'],
      ['social', 'Social media', 'lines', 'Links, one per line.'],
      ['notes', 'Anything else coaches should know', 'area', 'For example waiting times, or what to bring.'],
    ]],
  ];
  const REQUIRED_LINES = new Set(['referralRoutes']);
  const FIELD = {}; // key -> [label, kind]
  for (const [, fields] of SECTIONS) for (const [k, label, kind] of fields) FIELD[k] = [label, kind];

  let data = null;
  let form = null;

  function problem(text) {
    $('#pc-loading').hidden = true;
    $('#pc-app').hidden = true;
    const p = $('#pc-problem');
    p.replaceChildren(el('h2', { text: "Sorry, this link isn't working" }), el('p', { text }));
    p.hidden = false;
  }

  async function api(method, body) {
    let res;
    try {
      res = await fetch(API + '/provider/' + encodeURIComponent(token), { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, referrerPolicy: 'no-referrer' });
    } catch {
      throw Object.assign(new Error('Could not connect. Please check your internet connection and try again.'), { status: 0 });
    }
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(d.error || 'Something went wrong. Please try again.'), { status: res.status });
    return d;
  }

  // ---------- the form ----------
  const id = (k) => 'pc-' + k;

  function build() {
    const s = data.service;
    const ch = data.choices;
    form = el('form', { class: 'pc-form', novalidate: true });

    for (const [title, fields] of SECTIONS) {
      const sec = el('section', { class: 'pc-section' }, el('h2', { text: title }));
      for (const [k, label, kind, hint, required] of fields) {
        const hintEl = hint ? el('p', { class: 'hint', id: id(k) + '-hint', text: hint }) : null;
        const described = hint ? id(k) + '-hint' : null;
        let box;
        if (kind === 'text') {
          box = el('div', { class: 'field', 'data-key': k }, el('label', { for: id(k), text: label }), hintEl,
            el('input', { id: id(k), type: k === 'email' ? 'email' : k === 'webpage' ? 'url' : 'text', value: s[k] || '', 'aria-describedby': described, required: required ? true : null, autocomplete: 'off' }));
        } else if (kind === 'area') {
          box = el('div', { class: 'field', 'data-key': k }, el('label', { for: id(k), text: label }), hintEl,
            el('textarea', { id: id(k), rows: '3', value: s[k] || '', 'aria-describedby': described }));
        } else if (kind === 'lines') {
          box = el('div', { class: 'field', 'data-key': k }, el('label', { for: id(k), text: label }), hintEl,
            el('textarea', { id: id(k), rows: String(Math.max(2, list(s[k]).length + 1)), value: list(s[k]).join('\n'), 'aria-describedby': described }));
        } else if (kind === 'open') {
          const sel = el('select', { id: id(k), 'aria-describedby': described }, el('option', { value: 'yes', text: 'Yes' }), el('option', { value: 'no', text: 'No, not at the moment' }));
          sel.value = s.open === false ? 'no' : 'yes';
          box = el('div', { class: 'field', 'data-key': k }, el('label', { for: id(k), text: label }), hintEl, sel);
        } else if (kind === 'checks') {
          const have = new Set(list(s[k]));
          const name = (v) => (k === 'healthFocus' ? HEALTH[v] || v : k === 'audience' ? AUDIENCE[v] || v : v);
          box = el('fieldset', { class: 'field checks', 'data-key': k, id: id(k), 'aria-describedby': described }, el('legend', { text: label }), hintEl,
            el('div', { class: 'choices' }, list(ch[k]).map((v) => el('label', {}, el('input', { type: 'checkbox', value: v, checked: have.has(v) }), name(v)))));
        } else if (kind === 'self') {
          const sr = s.selfReferral || { allowed: 'tbc', note: '' };
          const sel = el('select', { id: id('sr-allowed') }, list(ch.selfReferral).map((v) => el('option', { value: v, text: SELF[v] || v })));
          sel.value = sr.allowed;
          box = el('fieldset', { class: 'field checks', 'data-key': 'selfReferral' }, el('legend', { text: label }),
            el('div', { class: 'field' }, el('label', { for: id('sr-allowed'), text: 'Can they?' }), sel),
            el('div', { class: 'field' }, el('label', { for: id('sr-note'), text: 'A few words about it' }), el('p', { class: 'hint', id: id('sr-note') + '-hint', text: 'For example "Fill in the form on our website" or "Through a work coach only".' }), el('input', { id: id('sr-note'), type: 'text', value: sr.note || '', 'aria-describedby': id('sr-note') + '-hint' })),
            el('div', { class: 'field' }, el('label', { for: id('sr-url'), text: 'Self-referral form link (if there is one)' }), el('input', { id: id('sr-url'), type: 'url', value: sr.url || '' })));
        } else if (kind === 'acts') {
          const acts = el('div', { class: 'acts' });
          const addAct = (a = { name: '', summary: '', duration: '' }) => {
            const n = acts.children.length + Math.floor(Math.random() * 1e6);
            const row = el('div', { class: 'act' },
              el('div', { class: 'field' }, el('label', { for: id('act-name-' + n), text: 'Name' }), el('input', { id: id('act-name-' + n), class: 'act-name', type: 'text', value: a.name })),
              el('div', { class: 'field' }, el('label', { for: id('act-summary-' + n), text: 'Short summary' }), el('textarea', { id: id('act-summary-' + n), class: 'act-summary', rows: '3', value: a.summary })),
              el('div', { class: 'field' }, el('label', { for: id('act-duration-' + n), text: 'How long it lasts (optional)' }), el('input', { id: id('act-duration-' + n), class: 'act-duration', type: 'text', value: a.duration || '' })),
              el('button', { type: 'button', class: 'btn secondary small', text: 'Remove this one', onclick: () => { row.remove(); refresh(); } }));
            acts.append(row);
          };
          list(s.activities).forEach((a) => addAct(a));
          box = el('fieldset', { class: 'field checks', 'data-key': 'activities' }, el('legend', { text: label }), hintEl, acts,
            el('button', { type: 'button', class: 'btn secondary small', text: 'Add another', onclick: () => { addAct(); refresh(); acts.lastChild.querySelector('input').focus(); } }));
        }
        box.append(el('p', { class: 'changed-tag', text: 'Changed', hidden: true }));
        sec.append(box);
      }
      form.append(sec);
    }

    const status = el('p', { class: 'pc-count', role: 'status', 'aria-live': 'polite' });
    const msg = el('p', { class: 'pc-msg', role: 'alert', hidden: true });
    const correct = el('button', { type: 'button', class: 'btn primary', text: 'Everything is correct', onclick: () => send(true) });
    const sendBtn = el('button', { type: 'submit', class: 'btn primary', text: 'Send my changes' });
    const undo = el('button', { type: 'button', class: 'btn secondary', text: 'Undo my changes', onclick: () => { if (confirm('Undo all your changes and go back to the details we hold?')) { form.replaceWith(build()); refresh(); window.scrollTo(0, 0); } } });
    form.append(el('section', { class: 'pc-section pc-send' },
      el('h2', { text: 'Send to the Healthy Working Life team' }),
      el('div', { class: 'field' }, el('label', { for: id('yourname'), text: 'Your name' }), el('input', { id: id('yourname'), type: 'text', value: data.contact, autocomplete: 'name', maxlength: '80' })),
      el('div', { class: 'field' }, el('label', { for: id('note'), text: 'Anything else you would like to tell us (optional)' }), el('p', { class: 'hint', id: id('note') + '-hint', text: "If something's wrong but you're not sure how to change it, tell us here." }), el('textarea', { id: id('note'), rows: '4', maxlength: '2000', 'aria-describedby': id('note') + '-hint' })),
      status,
      el('div', { class: 'pc-buttons' }, correct, sendBtn, undo),
      msg));
    form._ui = { status, msg, correct, sendBtn, undo };
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    form.addEventListener('submit', (e) => { e.preventDefault(); send(false); });
    return form;
  }

  // What the form says now, in the same shape as the data.
  function read() {
    const q = (k) => form.querySelector('#' + CSS.escape(id(k)));
    const out = {};
    const s = data.service;
    for (const [k, [, kind]] of Object.entries(FIELD)) {
      if (kind === 'text' || kind === 'area') out[k] = q(k).value.trim() || null;
      else if (kind === 'lines') out[k] = q(k).value.split('\n').map((l) => l.trim()).filter(Boolean);
      else if (kind === 'open') out.open = q(k).value === 'yes';
      else if (kind === 'checks') {
        const ticked = [...q(k).querySelectorAll('input:checked')].map((i) => i.value);
        const had = list(s[k]).filter((v) => ticked.includes(v));
        out[k] = [...had, ...ticked.filter((v) => !had.includes(v))]; // keep the existing order
      } else if (kind === 'self') {
        const sr = { allowed: q('sr-allowed').value, note: q('sr-note').value.trim() };
        if (q('sr-url').value.trim()) sr.url = q('sr-url').value.trim();
        out.selfReferral = sr;
      } else if (kind === 'acts') {
        out.activities = [...form.querySelectorAll('.act')].map((r) => ({ name: r.querySelector('.act-name').value.trim(), summary: r.querySelector('.act-summary').value.trim(), duration: r.querySelector('.act-duration').value.trim() }));
      }
    }
    return out;
  }

  function changes() {
    const s = data.service;
    const now = read();
    const ch = {};
    for (const [k, v] of Object.entries(now)) {
      const was = k === 'activities' ? list(s.activities).map((a) => ({ name: a.name, summary: a.summary, duration: a.duration || '' })) : s[k];
      if (norm(was) !== norm(v)) ch[k] = v;
    }
    return ch;
  }

  function refresh() {
    if (!form) return;
    const ch = changes();
    for (const box of form.querySelectorAll('[data-key]')) {
      const on = box.dataset.key in ch;
      box.classList.toggle('changed', on);
      const tag = box.querySelector(':scope > .changed-tag');
      if (tag) tag.hidden = !on;
    }
    const n = Object.keys(ch).length;
    const ui = form._ui;
    ui.status.textContent = n ? `You've changed ${n} ${n === 1 ? 'detail' : 'details'}. They are marked "Changed" above.` : "You haven't changed anything.";
    ui.correct.hidden = n > 0;
    ui.sendBtn.hidden = n === 0;
    ui.undo.hidden = n === 0;
  }

  async function send(allCorrect) {
    const ui = form._ui;
    const say = (t) => { ui.msg.textContent = t; ui.msg.hidden = false; };
    ui.msg.hidden = true;
    const ch = allCorrect ? {} : changes();
    const now = read();
    // The checks the Worker makes too, said here first in plain words.
    if (!allCorrect) {
      for (const k of ['name', 'organisation', 'whoFor', 'status', 'workExperience']) if (k in ch && !now[k]) return say(`"${FIELD[k][0]}" can't be empty.`);
      for (const k of REQUIRED_LINES) if (k in ch && !now[k].length) return say(`Please give at least one way in, under "${FIELD[k][0]}".`);
      for (const k of ['audience', 'areas', 'categories']) if (k in ch && !now[k].length) return say(`Please tick at least one box under "${FIELD[k][0]}".`);
      if ('activities' in ch && (!now.activities.length || now.activities.some((a) => !a.name || !a.summary))) return say('Each thing your service offers needs a name and a short summary.');
      if ('selfReferral' in ch && !now.selfReferral.note) return say('Please say a few words about whether people can refer themselves.');
      if ('webpage' in ch && now.webpage && !/^https?:\/\/\S+$/.test(now.webpage)) return say('The web page needs to start with https:// (copy it from your browser\'s address bar).');
      if (!Object.keys(ch).length && form.querySelector('#' + id('note')).value.trim().length < 3) return say("You haven't changed anything. Change the details above, or tell us what's wrong in the box above.");
    }
    const buttons = [ui.correct, ui.sendBtn, ui.undo];
    buttons.forEach((b) => (b.disabled = true));
    try {
      const d = await api('POST', { allCorrect, changes: ch, note: form.querySelector('#' + id('note')).value.trim(), name: form.querySelector('#' + id('yourname')).value.trim() });
      thanks(allCorrect, d.t);
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      say(err.message);
    }
  }

  function thanks(allCorrect, t) {
    const app = $('#pc-app');
    const back = el('button', { type: 'button', class: 'btn secondary', text: 'Go back to the details', onclick: () => { panel.remove(); form.hidden = false; intro.hidden = false; form.querySelector('input, textarea, select').focus(); } });
    const intro = $('#pc-intro');
    const panel = el('div', { class: 'pc-thanks', tabindex: '-1' },
      el('h2', { text: 'Thank you' }),
      el('p', { text: allCorrect
        ? "We've told the Healthy Working Life team that your service's details are correct."
        : "We've sent your changes to the Healthy Working Life team. They'll check them before they appear on the Support Finder, and may get in touch if they have a question." }),
      el('p', { text: 'Sent ' + new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }) + '. If you remember something else, you can go back and send again until ' + date(data.expires) + '.' }),
      back);
    form.hidden = true;
    intro.hidden = true;
    app.append(panel);
    panel.focus();
    window.scrollTo(0, 0);
  }

  function show() {
    const s = data.service;
    $('#pc-title').textContent = 'Check the details for ' + s.name;
    document.title = 'Check the details for ' + s.name + ' | Healthy Working Life Support Finder';
    const last = data.lastReply;
    const intro = el('div', { id: 'pc-intro' },
      el('p', {}, 'Hello ', el('strong', { text: data.contact }), '. This is everything the ', el('strong', { text: 'Healthy Working Life Support Finder' }), ' holds about ', el('strong', { text: s.name }), '.'),
      el('p', { text: 'Work and health coaches in Kirklees use the Support Finder to find the right support for the people they work with. Its AI uses these details to decide who to suggest your service to, so please check them carefully, especially who it\'s for, who can use it and how people get in.' }),
      el('ul', {},
        el('li', { text: 'If everything is right, press "Everything is correct" at the end.' }),
        el('li', { text: 'If something is wrong or missing, change it in the boxes below and press "Send my changes".' }),
        el('li', { text: 'Your changes go to the Healthy Working Life team, who check them before they appear on the Support Finder.' })),
      el('p', { class: 'notice', role: 'note', text: 'This link is just for you and works until ' + date(data.expires) + '. Please don\'t share it.' }),
      last ? el('p', { class: 'pc-last', text: 'You last replied on ' + date(last.t) + (last.allCorrect ? ', saying everything was correct.' : ', with changes.') + ' You can send again if something else needs changing.' }) : null);
    $('#pc-app').replaceChildren(intro, build());
    refresh();
    $('#pc-loading').hidden = true;
    $('#pc-app').hidden = false;
  }

  // ---------- start ----------
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) {
    problem('The link looks incomplete. Please copy the whole link from the email into your browser, or ask the Healthy Working Life team to send it again.');
  } else if (!API && !location.hostname.endsWith('workers.dev')) {
    problem('This page has not been connected yet. Please contact the Healthy Working Life team.');
  } else {
    api('GET')
      .then((d) => { data = d; show(); })
      .catch((err) => problem(err.message));
  }
})();
