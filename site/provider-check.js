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

  let data = null;
  let form = null;
  let lf = null; // the shared listing form (listing-form.js)

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
  // The questions themselves are the shared listing form (listing-form.js), the same as the team's form in Admin.
  const id = (k) => 'pc-' + k;

  function build() {
    lf = LISTING_FORM.build({ values: data.service, original: data.service, mode: 'partner', choices: data.choices, organisations: data.organisations, venues: data.venues, prefix: 'pc', headingLevel: 2, onChange: refresh });
    form = el('form', { class: 'pc-form', novalidate: true }, lf.node);
    const status = el('p', { class: 'pc-count', role: 'status', 'aria-live': 'polite' });
    const msg = el('p', { class: 'pc-msg', role: 'alert', hidden: true });
    const correct = el('button', { type: 'button', class: 'btn primary', text: 'Everything is correct', onclick: () => send(true) });
    const sendBtn = el('button', { type: 'submit', class: 'btn primary', text: 'Send my changes' });
    const undo = el('button', { type: 'button', class: 'btn secondary', text: 'Undo my changes', onclick: () => { if (confirm('Undo all your changes and go back to the details we hold?')) { form.replaceWith(build()); refresh(); window.scrollTo(0, 0); } } });
    form.append(el('section', { class: 'lf-section pc-send' },
      el('h2', { text: 'Send to the Healthy Working Life team' }),
      el('div', { class: 'lf-field' }, el('label', { for: id('yourname'), text: 'Your name' }), el('input', { id: id('yourname'), type: 'text', value: data.contact, autocomplete: 'name', maxlength: '80' })),
      el('div', { class: 'lf-field' }, el('label', { for: id('note'), text: 'Anything else you would like to tell us' }), el('p', { class: 'hint', id: id('note') + '-hint', text: "If something's wrong but you're not sure how to change it, tell us here." }), el('textarea', { id: id('note'), rows: '4', maxlength: '2000', 'aria-describedby': id('note') + '-hint' })),
      status,
      el('div', { class: 'pc-buttons' }, correct, sendBtn, undo),
      msg));
    form.classList.add('lf');
    form._ui = { status, msg, correct, sendBtn, undo };
    form.addEventListener('submit', (e) => { e.preventDefault(); send(false); });
    return form;
  }

  function refresh() {
    if (!form) return;
    const ch = lf.changes();
    lf.mark(ch);
    const n = Object.keys(ch).length;
    const ui = form._ui;
    ui.status.textContent = n ? `You've changed ${n} ${n === 1 ? 'question' : 'questions'}. They are marked "Changed" above.` : "You haven't changed anything.";
    ui.correct.hidden = n > 0;
    ui.sendBtn.hidden = n === 0;
    ui.undo.hidden = n === 0;
  }

  async function send(allCorrect) {
    const ui = form._ui;
    const say = (t) => { ui.msg.textContent = t; ui.msg.hidden = false; };
    ui.msg.hidden = true;
    const ch = allCorrect ? {} : lf.changes();
    // The checks the Worker makes too, said here first in plain words, with the box to go back to.
    if (!allCorrect) {
      const p = lf.check();
      if (p) { say(p.message); if (p.el && p.el.focus) p.el.focus(); return; }
      if (!Object.keys(ch).length && form.querySelector('#' + id('note')).value.trim().length < 3) return say("You haven't changed anything. Change the details above, or tell us what's wrong in the box above.");
    }
    const buttons = [ui.correct, ui.sendBtn, ui.undo];
    buttons.forEach((b) => (b.disabled = true));
    try {
      const d = await api('POST', { allCorrect, changes: ch, note: form.querySelector('#' + id('note')).value.trim(), name: form.querySelector('#' + id('yourname')).value.trim() });
      thanks(allCorrect, d.t, allCorrect ? data.service : { ...data.service, ...ch });
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      say(err.message);
    }
  }

  function thanks(allCorrect, t, listing) {
    const app = $('#pc-app');
    const intro = $('#pc-intro');
    const back = el('button', { type: 'button', class: 'btn secondary', text: 'Go back to the details', onclick: () => { panel.remove(); form.hidden = false; intro.hidden = false; form.querySelector('input, textarea, select').focus(); } });
    // Does anything have an end date, or a date referrals close? Then say we'll be in touch 30 days before.
    const dated = list(listing.projects).some((p) => p.runsTo || p.referralsUntil || list(p.sessions).some((c) => c.runsTo || c.referralsUntil));
    const panel = el('div', { class: 'pc-thanks', tabindex: '-1' },
      el('h2', { text: 'Thank you' }),
      el('p', { text: allCorrect
        ? "We've told the Healthy Working Life team that your service's details are correct."
        : "We've sent your changes to the Healthy Working Life team. They'll check them before they appear on the Support Finder, and may get in touch if they have a question." }),
      el('p', { text: 'Please keep us up to date. If anything changes, such as new projects, dates, funding or who your service is for, let the Healthy Working Life team know so coaches always have the right details.' }),
      dated ? el('p', { text: "As some of your projects have an end date or a date referrals close, we'll email you about 30 days before, to check whether anything has changed. Projects stop showing in the Support Finder after their end date." }) : null,
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
      el('p', { text: 'Work and health coaches in Kirklees use the Support Finder to find the right support for the people they work with. Its AI uses these details to decide who to suggest your service to, so please check them carefully, especially who it\'s for, where and when you run, and how people get in.' }),
      el('ul', {},
        el('li', { text: 'If everything is right, press "Everything is correct" at the end.' }),
        el('li', { text: 'If something is wrong or missing, change it in the boxes below and press "Send my changes". Please add as much as you can: the more coaches know, the better they can match people to your service.' }),
        el('li', { text: 'Under "What happens, where and when", tell us where and when each project runs: add a session for each venue and day, with the times. This builds a timetable of what runs across Kirklees. If the same project runs for different groups (for example two age groups), add a session for each.' }),
        el('li', { text: 'Your changes go to the Healthy Working Life team, who check them before they appear on the Support Finder.' })),
      el('p', { class: 'notice', role: 'note', text: 'This link is just for you and works until ' + date(data.expires) + '. Please don\'t share it.' }),
      last ? el('p', { class: 'pc-last', text: 'You last replied on ' + date(last.t) + (last.allCorrect ? ', saying everything was correct.' : ', with changes.') + ' You can send again if something else needs changing.' }) : null);
    // "Do you run anything else?": another project of this service (added to the form above), or another service,
    // which opens Suggest a service on the Support Finder with the organisation filled in.
    const others = data.otherServices || [];
    const more = el('section', { class: 'lf-section pc-more' },
      el('h2', { text: 'Do you run anything else?' }),
      el('p', { text: `This link is for ${s.name}. If ${s.organisation} runs something else that could help people in Kirklees stay in, return to or find work, tell us about it. It goes to the Healthy Working Life team to check.` }),
      el('div', { class: 'pc-buttons' },
        el('button', { type: 'button', class: 'btn secondary', text: 'Add another project to ' + s.name, onclick: () => lf.addProject() }),
        el('a', { class: 'btn secondary', href: './?suggest=service&org=' + encodeURIComponent(s.organisation), target: '_blank', rel: 'noopener', text: 'Add another service we run (opens in a new tab)' })),
      others.length ? el('p', { text: `We also list these services from ${s.organisation}: ${others.map((x) => x.name).join('; ')}. To check those too, ask the Healthy Working Life team for their links.` }) : null);
    $('#pc-app').replaceChildren(intro, build(), more);
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
