// User feedback: "Report a problem with this listing" on each card, "Was this helpful?" under each reply with
// cards, and "Tell us what's missing" under each reply and in the footer. The Worker stores it (worker/src/feedback.js).
//
// What is sent: the scheme id (and the date the listing was last checked), or the ids of the schemes shown in a
// reply, the boxes ticked, an optional short comment, and the page's mode and language. Never any of the
// conversation. Email addresses, phone numbers, postcodes and National Insurance numbers are taken out of the
// comment here before it is sent, and again by the Worker.
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

  function shell(className, onSubmit, onCancel, ...fields) {
    const errorEl = el('p', { class: 'fb-error', role: 'alert', hidden: true });
    const sendBtn = el('button', { type: 'submit', class: 'btn primary small', text: t('fbSend') });
    const form = el('form', { class: 'fb-form ' + className, novalidate: true },
      ...fields,
      errorEl,
      el('div', { class: 'fb-actions' }, sendBtn, el('button', { type: 'button', class: 'btn secondary small', text: t('fbCancel'), onclick: onCancel })));
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
      sendBtn.textContent = t('fbSending');
      try {
        await onSubmit(form);
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = t('fbSend');
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
        if (enabled) footer();
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

  window.FEEDBACK = { init, cardControl, replyControls, redact, get enabled() { return enabled; } };
})();
