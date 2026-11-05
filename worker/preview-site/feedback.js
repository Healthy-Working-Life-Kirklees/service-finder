// User feedback: "Report a problem with this listing" on each card, "Was this helpful?" under each reply with
// cards, and "Tell us what's missing" under each reply and in the footer. The Worker stores it (worker/src/feedback.js).
//
// What is sent: the scheme id (and the date the listing was last checked), or the ids of the schemes shown in a
// reply, the boxes ticked, an optional short comment, and the page's mode and language. Never any of the
// conversation. Email addresses, phone numbers, postcodes and National Insurance numbers are taken out of the
// comment here before it is sent, and again by the Worker.
//
// During the pilot there is also a fuller "Give pilot feedback" form near the top of the page (section 4). It
// sends a choice, a comment, two optional questions, the ids of the schemes in the latest reply (never what was
// typed) and, only if the tester ticks the box, their own name and work email. It only appears when /health
// says pilot is on (PILOT_FEEDBACK in the Worker). Like the MVP tools it is English only.
//
// The links only appear when the Worker's /health says feedback is on. Like the rest of the page, this stores
// nothing in the browser.
(() => {
  'use strict';

  const t = (key, vars) => window.I18N.t(key, vars);
  const MAX_TEXT = 300;
  const DONT_KNOW = "Don't know";
  const SOMETHING_ELSE = 'Something else';

  // A copy of REDACT_PATTERNS in worker/src/feedback.js. Keep the two in step: worker/test/logic.mjs checks they match.
  const REDACT_PATTERNS = [
    /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi,
    /\b[A-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/gi,
    /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/gi,
    /(?:(?:\+|\b00)44[ -]?(?:\(0\)[ -]?)?|\(?\b0)\d{2,4}\)?(?:[ -]?\d){5,8}\b/g,
  ];
  function redact(text) {
    let out = String(text || '');
    for (const re of REDACT_PATTERNS) out = out.replace(re, '[removed]');
    return out;
  }
  const hasPersonal = (text) => redact(text) !== String(text || '');

  // Set by init() from app.js.
  let el = null;
  let announce = () => {};
  let api = '';
  let currentMode = () => 'public';
  let services = () => new Map();
  let enabled = false;
  let pilot = false;
  let lastIds = []; // the schemes shown in the most recent reply, for the pilot form
  let n = 0;
  const uid = (p) => 'fb-' + p + '-' + ++n;

  // Areas and categories come from the data, so the choices always match what the Worker accepts.
  const fromData = (field) => [...new Set([...services().values()].flatMap((s) => s[field] || []))].sort();

  async function post(payload) {
    try {
      const r = await fetch(api + '/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return { ok: r.ok, status: r.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  // ---------- form pieces ----------
  // A group of tick boxes. items: [{ value, label, lang }]. Each tick box sits inside its own label.
  function ticks(legend, items, name) {
    return el('fieldset', { class: 'fb-ticks' },
      el('legend', {}, ...legend),
      el('div', { class: name === 'category' ? 'fb-grid' : 'fb-list' },
        items.map((x) => el('div', { class: 'fb-tick' },
          el('label', {}, el('input', { type: 'checkbox', name, value: x.value }), el('span', x.lang ? { lang: x.lang, dir: 'auto', text: x.label } : { text: x.label })),
          x.extra || null))));
  }

  function select(id, label, choices) {
    return el('div', { class: 'fb-field' },
      el('label', { for: id, text: label }),
      el('select', { id },
        el('option', { value: '', text: t('fbChoose') }),
        choices.map((a) => el('option', { value: a, lang: 'en', text: a })),
        el('option', { value: DONT_KNOW, text: t('fbDontKnow') })));
  }

  function input(id, label, max, type = 'text') {
    return el('div', { class: 'fb-field' },
      el('label', { for: id, text: label }),
      el('input', { id, type, maxlength: String(max), dir: type === 'url' ? 'ltr' : 'auto', autocomplete: 'off', spellcheck: type === 'url' ? 'false' : null }));
  }

  // The comment box, the privacy note under its label, and the warning shown when it looks like it has
  // personal details in it.
  function comment() {
    const id = uid('text');
    return el('div', { class: 'fb-field' },
      el('label', { for: id, text: t('fbTextLabel') }),
      el('p', { id: id + '-note', class: 'fb-note', text: t('fbTextNote') }),
      el('textarea', { id, name: 'text', rows: '3', maxlength: String(MAX_TEXT), dir: 'auto', 'aria-describedby': id + '-note ' + id + '-warn' }),
      el('p', { id: id + '-warn', class: 'fb-warn', 'aria-live': 'polite', hidden: true }));
  }

  // The pilot form is English only, so its buttons are too.
  const PILOT_EN = { fbSend: 'Send feedback', fbSending: 'Sending…', fbCancel: 'Cancel' };
  function shell(className, onSubmit, onCancel, ...fields) {
    const L = (key) => (className.includes('fb-pilot-form') ? PILOT_EN[key] : t(key));
    const errorEl = el('p', { class: 'fb-error', role: 'alert', hidden: true });
    const sendBtn = el('button', { type: 'submit', class: 'btn primary small', text: L('fbSend') });
    const form = el('form', { class: 'fb-form ' + className, novalidate: true },
      ...fields,
      errorEl,
      el('div', { class: 'fb-actions' }, sendBtn, el('button', { type: 'button', class: 'btn secondary small', text: L('fbCancel'), onclick: onCancel })));
    const warnEl = form.querySelector('.fb-warn');
    // Warn as people type if the comment (or a service name or website) looks like it has personal details.
    form.addEventListener('input', () => {
      const found = [...form.querySelectorAll('textarea, input[type=text], input[type=url]')].some((x) => hasPersonal(x.value));
      if (warnEl && found !== !warnEl.hidden) {
        warnEl.hidden = !found;
        warnEl.textContent = found ? t('fbRedactWarn') : '';
      }
    });
    form.fail = (msg, focusEl) => {
      errorEl.textContent = msg;
      errorEl.hidden = false;
      if (focusEl) focusEl.focus();
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (sendBtn.disabled) return;
      errorEl.hidden = true;
      sendBtn.disabled = true;
      sendBtn.textContent = L('fbSending');
      try {
        await onSubmit(form);
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = L('fbSend');
      }
    });
    return form;
  }

  const ticked = (form, name) => [...form.querySelectorAll('input[name="' + name + '"]:checked')].map((x) => x.value);
  const textOf = (form) => redact((form.querySelector('textarea[name=text]').value || '').trim()).slice(0, MAX_TEXT);

  async function send(form, payload) {
    const r = await post(payload);
    if (!r.ok) form.fail(r.status === 429 ? t('fbRateLimited') : t('fbError'));
    return r.ok;
  }

  // Swap something for a short thank-you, move focus to it and announce it.
  function thank(target, key) {
    const p = el('p', { class: 'fb-thanks', tabindex: '-1', text: t(key) });
    target.replaceWith(p);
    p.focus();
    announce(t(key));
    return p;
  }

  // ---------- 1. "Report a problem with this listing" on a card ----------
  const CARD_REASONS = [['closed', 'fbReasonClosed'], ['contact-wrong', 'fbReasonContact'], ['eligibility-wrong', 'fbReasonEligibility'], ['no-reply', 'fbReasonNoReply'], ['not-in-area', 'fbReasonArea'], ['missing-details', 'fbReasonMissing'], ['other', 'fbReasonOther']];

  function cardControl(s) {
    if (!enabled) return null;
    const mode = currentMode();
    const lang = window.I18N.lang;
    const box = el('div', { class: 'fb-card' });
    const formId = uid('card');
    let form = null;
    const btn = el('button', { type: 'button', class: 'linkish', 'aria-expanded': 'false', text: t('fbCardLink'), onclick: () => (form ? close() : open()) });
    function close() {
      form.remove();
      form = null;
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('aria-controls');
      btn.focus();
    }
    function open() {
      form = shell('fb-card-form', submit, close,
        ticks([t('fbCardLegend'), el('span', { class: 'fb-name', lang: 'en', dir: 'auto', text: s.name })], CARD_REASONS.map(([value, key]) => ({ value, label: t(key) })), 'reason'),
        comment());
      form.id = formId;
      box.append(form);
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-controls', formId);
    }
    async function submit(f) {
      const reasons = ticked(f, 'reason');
      if (!reasons.length) return f.fail(t('fbNeedReason'), f.querySelector('input[name=reason]'));
      if (await send(f, { kind: 'card', schemeIds: [s.id], recordLastUpdated: s.lastUpdated, reasons, text: textOf(f), mode, lang })) thank(box, 'fbThanksCard');
    }
    box.append(btn);
    return box;
  }

  // ---------- 3. "Tell us what's missing" ----------
  // One gap form, used under replies, in the footer, and after "It missed a service I know about".
  function gapForm(getMode, onSent, onCancel) {
    const areas = fromData('areas');
    const categories = fromData('categories');
    const nameId = uid('name');
    const siteId = uid('site');
    const areaId = uid('area');
    const supportAreaId = uid('sarea');
    const serviceSub = el('div', { class: 'fb-sub', hidden: true },
      input(nameId, t('fbServiceName'), 100),
      input(siteId, t('fbServiceWebsite'), 200, 'url'),
      select(areaId, t('fbServiceArea'), areas));
    const supportSub = el('div', { class: 'fb-sub', hidden: true },
      ticks([t('fbSupportLegend')], [...categories.map((c) => ({ value: c, label: c, lang: 'en' })), { value: SOMETHING_ELSE, label: t('fbSomethingElse') }], 'category'),
      select(supportAreaId, t('fbSupportArea'), areas));
    const form = shell('fb-gap-form', submit, onCancel,
      ticks([t('fbGapLegend')], [
        { value: 'missing-service', label: t('fbGapService'), extra: serviceSub },
        { value: 'missing-support', label: t('fbGapSupport'), extra: supportSub },
        { value: 'missing-other', label: t('fbGapOther') },
      ], 'gap'),
      comment());
    // Show the extra questions for a kind of gap only when it is ticked.
    form.addEventListener('change', (e) => {
      if (e.target.name !== 'gap') return;
      const sub = e.target.closest('.fb-tick').querySelector('.fb-sub');
      if (sub) sub.hidden = !e.target.checked;
    });
    async function submit(f) {
      const reasons = ticked(f, 'gap');
      if (!reasons.length) return f.fail(t('fbNeedReason'), f.querySelector('input[name=gap]'));
      const payload = { kind: 'gap', reasons, text: textOf(f), mode: getMode(), lang: window.I18N.lang };
      if (reasons.includes('missing-service')) {
        const siteEl = f.querySelector('#' + siteId);
        let website = siteEl.value.trim();
        // "www.example.org" is fine: add the https:// for the person.
        if (website && !/^https?:\/\//i.test(website) && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(website)) website = 'https://' + website;
        if (website && !/^https?:\/\/[^\s/?#]+\.[^\s/?#]+\S*$/i.test(website)) return f.fail(t('fbBadWebsite'), siteEl);
        const ms = { name: redact(f.querySelector('#' + nameId).value.trim()), website: redact(website), area: f.querySelector('#' + areaId).value };
        if (ms.name || ms.website || ms.area) payload.missedService = ms;
      }
      if (reasons.includes('missing-support')) {
        payload.gapCategories = ticked(f, 'category');
        const a = f.querySelector('#' + supportAreaId).value;
        if (a) payload.gapArea = a;
      }
      if (await send(f, payload)) onSent(f);
    }
    return form;
  }

  // The "Know a service that should be here? Tell us" link, with the gap form opening underneath it.
  function gapLink(getMode, wording) {
    const box = el('div', { class: 'fb-gap' });
    const slot = el('div', { class: 'fb-gap-slot' });
    let form = null;
    const btn = el('button', { type: 'button', class: 'linkish fb-gap-link', 'aria-expanded': 'false', onclick: () => (form ? close(true) : open()) });
    const label = () => { btn.textContent = t(wording() === 'staff' ? 'fbGapLinkStaff' : 'fbGapLinkSelf'); };
    label();
    function close(focus) {
      if (form) form.remove();
      form = null;
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('aria-controls');
      if (focus) btn.focus();
    }
    function open() {
      const id = uid('gap');
      form = gapForm(getMode, (f) => { form = null; btn.setAttribute('aria-expanded', 'false'); btn.removeAttribute('aria-controls'); thank(f, 'fbThanksGap'); }, () => close(true));
      form.id = id;
      slot.replaceChildren(form);
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-controls', id);
    }
    box.append(el('p', { class: 'fb-gap-line' }, btn), slot);
    return { node: box, open: () => { if (!form) open(); }, isOpen: () => Boolean(form), relabel: label };
  }

  // ---------- 2. "Was this helpful?" under a reply ----------
  const NO_REASONS = [['none-fit', 'fbNoNone'], ['info-wrong', 'fbNoWrong'], ['hard-to-understand', 'fbNoHard'], ['missed-service', 'fbNoMissed']];

  // Under a reply. ids: the schemes shown (none for a "nothing fits" reply). The helpful buttons only appear
  // when at least one card was shown; the "Tell us what's missing" link appears under every result reply.
  function replyControls(ids) {
    lastIds = ids.slice(0, 5);
    if (!enabled) return null;
    const mode = currentMode();
    const lang = window.I18N.lang;
    const box = el('div', { class: 'fb-reply' });
    const gap = gapLink(() => mode, () => mode);

    if (ids.length) {
      const qId = uid('q');
      const noBtn = el('button', { type: 'button', class: 'btn secondary small', text: t('fbNo'), onclick: () => openNo() });
      const group = el('div', { class: 'fb-helpful', role: 'group', 'aria-labelledby': qId },
        el('span', { id: qId, class: 'fb-q', text: t('fbHelpful') }),
        el('button', { type: 'button', class: 'btn secondary small', text: t('fbYes'), onclick: (e) => yes(e.currentTarget) }),
        noBtn);
      const yes = async (btn) => {
        btn.disabled = true;
        const r = await post({ kind: 'reply', schemeIds: ids, helpful: true, mode, lang });
        btn.disabled = false;
        if (r.ok) thank(group, 'fbThanksHelpful');
        else announce(r.status === 429 ? t('fbRateLimited') : t('fbError'));
      };
      const openNo = () => {
        const form = shell('fb-no-form', submit, () => { form.replaceWith(group); noBtn.focus(); },
          ticks([t('fbNoLegend')], NO_REASONS.map(([value, key]) => ({ value, label: t(key) })), 'reason'),
          comment());
        // "It missed a service I know about" opens the gap form underneath.
        form.addEventListener('change', (e) => {
          if (e.target.value === 'missed-service' && e.target.checked && !gap.isOpen()) {
            gap.open();
            announce(t('fbGapOpened'));
          }
        });
        group.replaceWith(form);
        form.querySelector('input[name=reason]').focus();
      };
      async function submit(f) {
        if (await send(f, { kind: 'reply', schemeIds: ids, helpful: false, reasons: ticked(f, 'reason'), text: textOf(f), mode, lang })) thank(f, 'fbThanksNo');
      }
      box.append(group);
    }
    box.append(gap.node);
    return box;
  }

  // ---------- 4. "Give pilot feedback" (pilot testers, English only) ----------
  const PILOT_TOPICS = [
    ['found-useful', 'It found something useful'],
    ['missed-service', 'It missed a service I know about'],
    ['unsuitable', 'It suggested something that wasn\'t suitable'],
    ['hard-to-use', 'It was confusing, slow or hard to use'],
    ['broken', 'Something is broken or wrong'],
    ['idea', 'An idea or suggestion'],
    ['other', 'Something else'],
  ];
  const CONTACTED = [['yes', 'Yes'], ['no', 'No'], ['not-yet', 'Not yet'], ['not-applicable', 'Not applicable']];
  const EASE = [[1, '1 Very hard'], [2, '2'], [3, '3'], [4, '4'], [5, '5 Very easy']];
  const MAX_PILOT_TEXT = 1500;

  function radios(legend, name, items, { row = false, hint = '' } = {}) {
    const hintId = hint ? uid('hint') : null;
    return el('fieldset', { class: 'fb-ticks', 'aria-describedby': hintId },
      el('legend', { text: legend }),
      hint ? el('p', { id: hintId, class: 'fb-note', text: hint }) : null,
      el('div', { class: row ? 'fb-row' : 'fb-list' },
        items.map(([value, label]) => el('div', { class: 'fb-tick' },
          el('label', {}, el('input', { type: 'radio', name, value: String(value) }), el('span', { text: label }))))));
  }

  function pilotForm(onSent, onCancel) {
    const textId = uid('ptext');
    const nameId = uid('pname');
    const emailId = uid('pemail');
    const contactSub = el('div', { class: 'fb-sub', hidden: true },
      input(nameId, 'Your name', 100),
      el('div', { class: 'fb-field' },
        el('label', { for: emailId, text: 'Your work email' }),
        el('input', { id: emailId, type: 'email', maxlength: '200', dir: 'ltr', autocomplete: 'email', spellcheck: 'false' })));
    const shown = lastIds.length;
    const form = shell('fb-pilot-form', submit, onCancel,
      radios('Which best describes this feedback?', 'topic', PILOT_TOPICS),
      el('div', { class: 'fb-field' },
        el('label', { for: textId, text: 'What happened?' }),
        el('p', { id: textId + '-note', class: 'fb-note', text: 'Describe the situation in general terms. Please don\'t include names, addresses, dates of birth or anything else that could identify the person you were helping.' }),
        el('textarea', { id: textId, name: 'text', rows: '5', maxlength: String(MAX_PILOT_TEXT), dir: 'auto', 'aria-describedby': textId + '-note ' + textId + '-warn' }),
        el('p', { id: textId + '-warn', class: 'fb-warn', 'aria-live': 'polite', hidden: true })),
      radios('Did you or the person you were helping go on to contact a suggested service?', 'contacted', CONTACTED, { row: true, hint: 'Optional' }),
      radios('How easy was the tool to use this time?', 'ease', EASE, { row: true, hint: 'Optional. 1 is very hard, 5 is very easy.' }),
      el('fieldset', { class: 'fb-ticks' },
        el('legend', { text: 'Can we contact you about this?' }),
        el('div', { class: 'fb-list' },
          el('div', { class: 'fb-tick' },
            el('label', {}, el('input', { type: 'checkbox', name: 'contact-ok', value: 'yes' }), el('span', { text: 'Yes, you can contact me' })),
            contactSub))),
      el('p', { class: 'fb-note fb-pilot-sends', text: shown
        ? 'We\'ll also send the names of the ' + (shown === 1 ? 'service' : shown + ' services') + ' in your latest results, so we know what you were shown. We don\'t send what you typed.'
        : 'We don\'t send anything you typed into the finder.' }));
    form.addEventListener('change', (e) => {
      if (e.target.name === 'contact-ok') {
        contactSub.hidden = !e.target.checked;
        if (e.target.checked) form.querySelector('#' + nameId).focus();
      }
    });
    const ids = lastIds.slice();
    async function submit(f) {
      const topic = f.querySelector('input[name=topic]:checked');
      if (!topic) return f.fail('Please choose what best describes your feedback.', f.querySelector('input[name=topic]'));
      const textEl = f.querySelector('#' + textId);
      const text = redact(textEl.value.trim()).slice(0, MAX_PILOT_TEXT);
      if (!text) return f.fail('Please tell us what happened.', textEl);
      const payload = { kind: 'pilot', reasons: [topic.value], text, lang: window.I18N.lang, mode: currentMode() };
      if (ids.length) payload.schemeIds = ids;
      const contacted = f.querySelector('input[name=contacted]:checked');
      if (contacted) payload.contacted = contacted.value;
      const ease = f.querySelector('input[name=ease]:checked');
      if (ease) payload.ease = Number(ease.value);
      if (f.querySelector('input[name=contact-ok]').checked) {
        const emailEl = f.querySelector('#' + emailId);
        const email = emailEl.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return f.fail('Please give an email address we can contact you on, or untick "Yes, you can contact me".', emailEl);
        payload.contact = { name: f.querySelector('#' + nameId).value.trim(), email };
      }
      if (await send(f, payload)) onSent(f);
    }
    return form;
  }

  // The pilot band near the top of the page: a line of text and a button that opens the form underneath.
  function pilotBand() {
    const spot = document.getElementById('fb-pilot');
    if (!spot) return;
    const slot = el('div', { class: 'fb-pilot-slot' });
    let form = null;
    const btn = el('button', { type: 'button', class: 'btn primary small', 'aria-expanded': 'false', text: 'Give pilot feedback', onclick: () => (form ? close(true) : open()) });
    function close(focus) {
      if (form) form.remove();
      form = null;
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('aria-controls');
      if (focus) btn.focus();
    }
    function open() {
      const id = uid('pilot');
      form = pilotForm((f) => {
        form = null;
        btn.setAttribute('aria-expanded', 'false');
        btn.removeAttribute('aria-controls');
        const p = el('p', { class: 'fb-thanks', tabindex: '-1', text: 'Thanks, we\'ve got that. Send more whenever something comes up.' });
        f.replaceWith(p);
        p.focus();
        announce(p.textContent);
        setTimeout(() => p.remove(), 8000);
      }, () => close(true));
      form.id = id;
      slot.replaceChildren(form);
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-controls', id);
      form.querySelector('input[name=topic]').focus();
    }
    spot.replaceChildren(
      el('div', { class: 'fb-pilot-row' },
        el('p', { class: 'fb-pilot-text' }, el('strong', { text: 'Thanks for helping us test the finder. ' }), 'Tell us how it went, as often as you like.'),
        btn),
      slot);
    spot.hidden = false;
    // "Start again" clears the results, so the form no longer refers to them.
    const reset = document.getElementById('reset');
    if (reset) reset.addEventListener('click', () => { lastIds = []; });
  }

  // ---------- setup ----------
  function init(o) {
    el = o.el;
    announce = o.announce;
    api = o.api;
    currentMode = o.mode;
    services = o.services;
    if (!api) return Promise.resolve(false);
    // Feedback is shown only when the Worker says it is on.
    return fetch(api + '/health')
      .then((r) => r.json())
      .then((h) => {
        enabled = h && h.feedback === true;
        pilot = enabled && h.pilot === true;
        if (enabled) footer();
        if (pilot) pilotBand();
        return enabled;
      })
      .catch(() => false);
  }

  // The footer link, so people can tell us at any time, even without a chat.
  function footer() {
    const spot = document.getElementById('fb-footer');
    if (!spot) return;
    const gap = gapLink(currentMode, currentMode);
    spot.replaceChildren(gap.node);
    spot.hidden = false;
    for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', gap.relabel);
    window.I18N.onChange(gap.relabel);
  }

  window.FEEDBACK = { init, cardControl, replyControls, redact, get enabled() { return enabled; }, get pilot() { return pilot; } };
})();
