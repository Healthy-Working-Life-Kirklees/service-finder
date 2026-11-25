// The service form for someone from a service we don't list yet (suggest.html, from "Suggest a service" on the
// main page when they say they are from the service). It is the same form organisations use to check a listing
// (listing-form.js, one part at a time), starting empty. What they send goes to the team as a suggested service,
// with the whole listing, so it can be added in Admin without retyping. Nothing goes on the Support Finder until
// the team has checked it.
//
// The answers are kept in this browser as a draft until they are sent (never sent anywhere before that).
// English only for now, like the other forms for organisations.
(() => {
  'use strict';
  const cfg = window.FINDER_CONFIG || {};
  const API = String(cfg.apiBase || '').replace(/\/$/, '');
  const $ = (s) => document.querySelector(s);
  const q = new URLSearchParams(location.search);
  const DRAFT_KEY = 'hwl-suggest-draft';

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }
  const date = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const draftGet = () => { try { const d = JSON.parse(localStorage.getItem(DRAFT_KEY)); return d && d.values ? d : null; } catch { return null; } };
  const draftSet = (d) => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* private browsing: no draft */ } };
  const draftDrop = () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } };

  let data = null;
  let lf = null;
  let form = null;
  let timer = null;

  // A brand new service: only what the form needs to start (one empty activity is added by the form).
  const blank = (org) => ({ organisation: org || '', name: '', whoFor: '', projects: [] });

  function build(values, restored) {
    lf = LISTING_FORM.build({ values, original: {}, mode: 'partner', choices: data.choices, organisations: data.organisations.map((o) => o.name), venues: data.venues, prefix: 'sg', headingLevel: 2, stepped: true, showLabels: false, onChange: changed });
    form = el('form', { class: 'pc-form lf', novalidate: true });
    const msg = el('p', { class: 'pc-msg', role: 'alert', hidden: true });
    const left = el('div', { class: 'pc-left', role: 'status', hidden: true });
    const sendBtn = el('button', { type: 'submit', class: 'btn primary', text: 'Send to the Healthy Working Life team' });
    const sendBox = el('section', { class: 'lf-section pc-send' },
      el('h2', { text: 'Send to the Healthy Working Life team' }),
      el('div', { class: 'lf-field' }, el('label', { for: 'sg-yourname', text: 'Your name' }), el('p', { class: 'hint', text: 'So we know who to ask if we have a question. We use the service\'s own email address or phone number from part 2 to get in touch.' }), el('input', { id: 'sg-yourname', type: 'text', autocomplete: 'name', maxlength: '100' })),
      el('div', { class: 'lf-field' }, el('label', { for: 'sg-note', text: 'Anything else you would like to tell us' }), el('textarea', { id: 'sg-note', rows: '3', maxlength: '2000' })),
      el('div', { class: 'pc-buttons' }, sendBtn), msg, left);
    const last = lf.parts[lf.parts.length - 1];
    last.insertBefore(sendBox, last.querySelector('.lf-partnav'));
    const draftNote = el('p', { class: 'pc-draft', role: 'status' },
      el('strong', { text: 'Your answers are saved on this device as you go' }), ', so you can close the page and carry on later. ',
      el('button', { type: 'button', class: 'linklike', text: 'Clear my answers', onclick: () => {
        if (!confirm("Clear everything you've typed? It can't be got back.")) return;
        draftDrop(); start(blank(q.get('org'))); window.scrollTo(0, 0);
      } }), ' (on a shared computer).',
      restored ? el('span', { text: " We've filled in the answers you saved on " + date(restored) + '.' }) : null);
    form.append(draftNote, lf.node);
    form._ui = { msg, left, sendBtn };
    form.addEventListener('submit', (e) => { e.preventDefault(); send(false); });
    return form;
  }

  function changed() {
    clearTimeout(timer);
    timer = setTimeout(() => draftSet({ t: new Date().toISOString(), values: lf.read() }), 400);
  }

  async function send(anyway) {
    const ui = form._ui;
    const say = (t) => { ui.msg.textContent = t; ui.msg.hidden = false; };
    ui.msg.hidden = true;
    ui.left.hidden = true;
    const p = lf.check();
    if (p) { say(p.message); if (p.el && p.el.focus) p.el.focus(); return; }
    const left = anyway ? [] : lf.unanswered();
    if (left.length) {
      ui.left.replaceChildren(
        el('p', { class: 'mt0' }, el('strong', { text: `You've left ${left.length} ${left.length === 1 ? 'question' : 'questions'} unanswered.` }), " The more coaches know, the better they can match people to your service, but it's fine to leave something out if it doesn't apply or you're not sure."),
        el('ul', {}, left.map((x) => el('li', {}, el('button', { type: 'button', class: 'linklike', text: x.label, onclick: x.go })))),
        el('p', {}, el('button', { type: 'button', class: 'btn primary', text: 'Send anyway', onclick: () => send(true) })));
      ui.left.hidden = false;
      ui.left.scrollIntoView({ block: 'nearest' });
      return;
    }
    // Check your answers, then send from there.
    const who = form.querySelector('#sg-yourname').value.trim();
    const note = form.querySelector('#sg-note').value.trim();
    lf.review({
      title: 'Check your answers before sending',
      intro: 'This is everything you have told us. Use "Change" to go back to a question. Nothing is sent until you press the button at the end.',
      extra: [who || note ? el('dl', { class: 'lf-review-list' }, el('div', { class: 'lf-review-part' }, el('h3', { text: 'From you' })),
        who ? el('div', { class: 'lf-review-row' }, el('dt', { text: 'Your name' }), el('dd', { text: who })) : null,
        note ? el('div', { class: 'lf-review-row' }, el('dt', { text: 'Anything else you told us' }), el('dd', { text: note })) : null) : null].filter(Boolean),
      sendText: 'Send to the Healthy Working Life team',
      onSend: post,
    });
  }

  async function post() {
    const listing = lf.read();
    const website = /^https?:\/\/[^\s/?#]+\.[^\s/?#]+\S*$/i.test(listing.webpage || '') ? listing.webpage : '';
    const ms = { role: 'provider', name: listing.name, organisation: listing.organisation, website, listing };
    const who = form.querySelector('#sg-yourname').value.trim();
    if (who) ms.contactName = who;
    const res = await fetch(API + '/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, referrerPolicy: 'no-referrer',
      body: JSON.stringify({ kind: 'gap', reasons: ['missing-service'], text: form.querySelector('#sg-note').value.trim(), missedService: ms, mode: 'staff', lang: 'en' }) })
      .catch(() => { throw new Error('Could not connect. Please check your internet connection and try again.'); });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 404 ? 'Sending isn\'t switched on at the moment. Please try again later, or email the Healthy Working Life team.' : d.error || 'Something went wrong. Please try again.');
    clearTimeout(timer);
    draftDrop();
    thanks(listing);
  }

  function thanks(listing) {
    const panel = el('div', { class: 'pc-thanks', tabindex: '-1' },
      el('h2', { text: 'Thank you' }),
      el('p', { text: `We've sent ${listing.name} to the Healthy Working Life team. They'll check it before it appears on the Support Finder, and may get in touch if they have a question.` }),
      el('p', { text: "If you run another service, you can tell us about that too. Your organisation's name and description will be filled in for you." }),
      el('p', {}, el('button', { type: 'button', class: 'btn primary', text: 'Tell us about another service', onclick: () => { start({ ...blank(listing.organisation), organisationOverview: listing.organisationOverview || '' }); window.scrollTo(0, 0); } })),
      el('p', {}, el('a', { href: './', text: 'Back to the Support Finder' })));
    $('#pc-app').replaceChildren(panel);
    panel.focus();
    window.scrollTo(0, 0);
  }

  function start(values, restored) {
    const intro = el('div', { id: 'pc-intro' },
      el('p', { text: 'Work and health coaches in Kirklees use the Healthy Working Life Support Finder to find the right support for the people they work with. Tell us about your service and the team will check it before it goes on.' }),
      el('ul', {},
        el('li', { text: 'The form has three parts: the service and who can join, contact and how people get in, then activities and timetable. You can move between them at any time.' }),
        el('li', { text: "Answer as much as you can: the more coaches know, the better they can match people to your service. It's fine to leave something out if it doesn't apply or you're not sure." }),
        el('li', { text: 'If your organisation runs more than one service (with different people it is for, a different way in or a different contact), send one form for each. Different activities, places and groups of the same service go in part 3.' })));
    $('#pc-app').replaceChildren(intro, build(values, restored));
  }

  (async () => {
    try {
      if (!API && !location.hostname.endsWith('workers.dev')) throw new Error('This page has not been connected yet. Please contact the Healthy Working Life team.');
      const res = await fetch('services.json');
      if (!res.ok) throw new Error('The form could not be loaded. Please try again later.');
      data = await res.json();
      const d = draftGet();
      start(d ? d.values : blank(q.get('org')), d ? d.t : null);
      $('#pc-loading').hidden = true;
      $('#pc-app').hidden = false;
    } catch (err) {
      $('#pc-loading').hidden = true;
      const p = $('#pc-problem');
      p.replaceChildren(el('h2', { text: "Sorry, this form isn't working" }), el('p', { text: err.message }));
      p.hidden = false;
    }
  })();
})();
