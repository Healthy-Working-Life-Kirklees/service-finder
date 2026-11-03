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
  // A group of tick boxes (or, with type 'radio', a choice of one). items: [{ value, label, lang }]. Each one
  // sits inside its own label.
  function ticks(legend, items, name, type = 'checkbox') {
    return el('fieldset', { class: 'fb-ticks' },
      el('legend', {}, ...legend),
      el('div', { class: name === 'category' || name === 'svccat' ? 'fb-grid' : 'fb-list' },
        items.map((x) => el('div', { class: 'fb-tick' },
          el('label', {}, el('input', { type, name, value: x.value }), el('span', x.lang ? { lang: x.lang, dir: 'auto', text: x.label } : { text: x.label })),
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

  function textarea(id, label, max, rows = 3) {
    return el('div', { class: 'fb-field' },
      el('label', { for: id, text: label }),
      el('textarea', { id, rows: String(rows), maxlength: String(max), dir: 'auto' }));
  }

  // A drop-down of fixed choices: [[value, labelKey], ...].
  function choice(id, label, options) {
    return el('div', { class: 'fb-field' },
      el('label', { for: id, text: label }),
      el('select', { id }, el('option', { value: '', text: t('fbChooseOne') }), options.map(([v, key]) => el('option', { value: v, text: t(key) }))));
  }

  function checkbox(id, label) {
    return el('div', { class: 'fb-tick' }, el('label', { for: id }, el('input', { id, type: 'checkbox' }), el('span', { text: label })));
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
    // Warn as people type if the comment looks like it has personal details. (A suggested service's own phone,
    // email and address are about the service, so they are kept and not warned about.)
    form.addEventListener('input', () => {
      const found = [...form.querySelectorAll('textarea[name=text]')].some((x) => hasPersonal(x.value));
      if (warnEl && found !== !warnEl.hidden) {
        warnEl.hidden = !found;
        warnEl.textContent = found ? t('fbRedactWarn') : '';
      }
    });
    form.fail = (msg, focusEl) => {
      errorEl.textContent = msg;
      errorEl.hidden = false;
      // Jump back to the question that needs answering.
      if (focusEl) {
        focusEl.focus({ preventScroll: true });
        focusEl.scrollIntoView({ block: 'center' });
      }
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

  // ---------- 3. "Tell us what's missing" / "Suggest a service" ----------
  // One gap form, used under replies, from the "Suggest a service" button in the header, and after
  // "It missed a service I know about". For a service, people first say whether they are from it or suggesting it
  // (needed), and nothing else shows until they do. Then:
  //  - suggesting it: the name and organisation (needed), website, phone and area, with the other listing
  //    questions folded under "Know more about it?" (closed until they open it);
  //  - from the service: a prompt to fill in as much as they can, then the full questionnaire in sections, in
  //    the order of a listing.
  // The same boxes are moved between the two layouts, so nothing typed is lost if they change their answer.
  function serviceQuestions() {
    const areas = fromData('areas');
    const categories = fromData('categories');
    const ids = {};
    const id = (k) => (ids[k] = ids[k] || uid('svc-' + k));
    const roleName = uid('role');
    const eligHintId = uid('elig-hint');
    const conditions = input(id('conditions'), t('fbConditions'), 300);
    conditions.hidden = true;
    const health = choice(id('healthNeed'), t('fbHealth'), [['none', 'fbHealthNone'], ['any', 'fbHealthAny'], ['specific', 'fbHealthSpecific']]);
    // "Yes, a specific condition" opens a box to say which.
    health.querySelector('select').addEventListener('change', (e) => { conditions.hidden = e.target.value !== 'specific'; });
    const elig = textarea(id('eligibility'), t('fbElig'), 800);
    elig.querySelector('textarea').setAttribute('aria-describedby', eligHintId);
    elig.insertBefore(el('p', { id: eligHintId, class: 'fb-hint', text: t('fbEligHint') }), elig.querySelector('textarea'));
    const F = {
      name: input(id('name'), t('fbServiceName'), 100),
      organisation: input(id('organisation'), t('fbOrg'), 150),
      website: input(id('website'), t('fbServiceWebsite'), 200, 'url'),
      phone: input(id('phone'), t('fbPhone'), 80, 'tel'),
      area: select(id('area'), t('fbServiceArea'), areas),
      description: textarea(id('description'), t('fbDescription'), 800),
      activities: textarea(id('activities'), t('fbActivities'), 1200, 4),
      running: choice(id('running'), t('fbRunning'), [['now', 'fbRunNow'], ['paused', 'fbRunPaused'], ['soon', 'fbRunSoon'], ['ended', 'fbRunEnded']]),
      dates: input(id('dates'), t('fbDates'), 150),
      audience: ticks([t('fbAudience')], [['individual', 'fbAudInd'], ['employer', 'fbAudEmp'], ['organisation', 'fbAudOrg'], ['student', 'fbAudStu']].map(([value, key]) => ({ value, label: t(key) })), 'audience'),
      age: input(id('age'), t('fbAge'), 60),
      eligibility: elig,
      exclusions: textarea(id('exclusions'), t('fbExcl'), 500, 2),
      healthNeed: health,
      conditions,
      categories: ticks([t('fbCats')], categories.map((c) => ({ value: c, label: c, lang: 'en' })), 'svccat'),
      level: choice(id('level'), t('fbLevel'), [['local', 'fbLevelLocal'], ['regional', 'fbLevelRegional'], ['national', 'fbLevelNational']]),
      addresses: textarea(id('addresses'), t('fbAddresses'), 500, 2),
      noMap: checkbox(id('noMap'), t('fbNoMap')),
      email: input(id('email'), t('fbEmail'), 150, 'email'),
      social: input(id('social'), t('fbSocial'), 300),
      referral: textarea(id('referral'), t('fbReferral'), 600),
      selfReferral: choice(id('selfReferral'), t('fbSelf'), [['yes', 'fbSelfYes'], ['partly', 'fbSelfPartly'], ['no', 'fbSelfNo']]),
      cost: input(id('cost'), t('fbCost'), 200),
      languages: input(id('languages'), t('fbLanguages'), 200),
      workExperience: input(id('workExperience'), t('fbWorkExp'), 300),
      logoOk: checkbox(id('logoOk'), t('fbLogo')),
      contactName: input(id('contactName'), t('fbContactName'), 100),
    };
    const heading = (key) => el('h3', { class: 'fb-section', text: t(key) });
    const note = () => el('p', { class: 'fb-note', text: t('fbDetailsNote') });
    // From the service: everything, in sections.
    const PROVIDER = [
      el('p', { class: 'fb-prompt', text: t('fbProviderPrompt') }),
      heading('fbSecAbout'), 'name', 'organisation', 'website', 'description', 'activities', 'running', 'dates',
      heading('fbSecWho'), 'audience', 'age', 'eligibility', 'exclusions', 'healthNeed', 'conditions', 'categories',
      heading('fbSecWhere'), 'area', 'level', 'addresses', 'noMap',
      heading('fbSecContact'), note(), 'phone', 'email', 'social', 'referral', 'selfReferral', 'cost', 'languages', 'workExperience',
      heading('fbSecLast'), 'logoOk', 'contactName',
    ];
    // Suggesting it: five boxes, then the rest folded away.
    const more = el('details', { class: 'fb-more' }, el('summary', { text: t('fbMoreDetails') }));
    const SUGGESTER_TOP = ['name', 'organisation', 'website', 'phone', 'area'];
    const SUGGESTER_MORE = [note(), 'description', 'activities', 'running', 'dates', 'audience', 'age', 'eligibility', 'exclusions', 'healthNeed', 'conditions', 'categories', 'level', 'addresses', 'noMap', 'email', 'social', 'referral', 'selfReferral', 'cost', 'languages', 'workExperience'];
    const nodes = (list) => list.map((x) => (typeof x === 'string' ? F[x] : x));
    const roleSet = el('fieldset', { class: 'fb-ticks' },
      el('legend', { text: t('fbRoleLegend') }),
      el('div', { class: 'fb-list' }, [['provider', 'fbRoleProvider'], ['suggester', 'fbRoleSuggester']].map(([v, key]) =>
        el('div', { class: 'fb-tick' }, el('label', {}, el('input', { type: 'radio', name: roleName, value: v }), el('span', { text: t(key) }))))));
    const rest = el('div', { class: 'fb-rest', hidden: true });
    const node = el('div', { class: 'fb-sub', hidden: true }, roleSet, rest);
    let role = '';
    roleSet.addEventListener('change', (e) => {
      role = e.target.value;
      if (role === 'provider') {
        more.replaceChildren(more.firstChild);
        rest.replaceChildren(...nodes(PROVIDER));
      } else {
        more.replaceChildren(more.firstChild, ...nodes(SUGGESTER_MORE));
        more.open = false;
        rest.replaceChildren(...nodes(SUGGESTER_TOP), more);
      }
      rest.hidden = false;
    });
    const box = (k) => F[k].querySelector('input, textarea, select');
    // The service and organisation names are mandatory: if either is missing, it gets a red box and a message.
    function mark(k, on) {
      const b = box(k);
      F[k].classList.toggle('fb-invalid', on);
      let msg = F[k].querySelector('.fb-field-error');
      if (on && !msg) {
        msg = el('p', { id: b.id + '-err', class: 'fb-field-error', text: t('fbMandatory') });
        b.before(msg);
      }
      if (msg) msg.hidden = !on;
      if (on) {
        b.setAttribute('aria-invalid', 'true');
        b.setAttribute('aria-describedby', msg.id);
      } else {
        b.removeAttribute('aria-invalid');
        b.removeAttribute('aria-describedby');
      }
    }
    for (const k of ['name', 'organisation']) box(k).addEventListener('input', () => { if (box(k).value.trim()) mark(k, false); });
    const val = (k) => box(k).value.trim();
    const showing = (k) => node.contains(F[k]);
    // Reads the answers. Returns { ms } or { error, focus }.
    function read(f) {
      if (!role) return { error: t('fbNeedRole'), focus: roleSet.querySelector('input') };
      const name = redact(val('name'));
      const missing = [!name && 'name', !val('organisation') && 'organisation'].filter(Boolean);
      mark('name', missing.includes('name'));
      mark('organisation', missing.includes('organisation'));
      if (missing.length) return { error: t(missing.length === 2 ? 'fbNeedBoth' : missing[0] === 'name' ? 'fbNeedName' : 'fbNeedOrg'), focus: box(missing[0]) };
      let website = val('website');
      // "www.example.org" is fine: add the https:// for the person.
      if (website && !/^https?:\/\//i.test(website) && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(website)) website = 'https://' + website;
      if (website && !/^https?:\/\/[^\s/?#]+\.[^\s/?#]+\S*$/i.test(website)) return { error: t('fbBadWebsite'), focus: box('website') };
      if (val('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val('email'))) { more.open = true; return { error: t('fbBadEmail'), focus: box('email') }; }
      const ms = { name, website, area: val('area'), role };
      for (const k of ['organisation', 'description', 'activities', 'running', 'dates', 'age', 'eligibility', 'exclusions', 'healthNeed', 'addresses', 'level', 'phone', 'email', 'social', 'referral', 'selfReferral', 'cost', 'languages', 'workExperience']) if (val(k)) ms[k] = val(k);
      if (ms.healthNeed === 'specific' && val('conditions')) ms.conditions = val('conditions');
      const aud = ticked(f, 'audience');
      if (aud.length) ms.audience = aud;
      const cats = ticked(f, 'svccat');
      if (cats.length) ms.categories = cats;
      if (box('noMap').checked) ms.noMap = true;
      // Logo permission and a contact name only come from someone at the service.
      if (showing('logoOk') && box('logoOk').checked) ms.logoOk = true;
      if (showing('contactName') && val('contactName')) ms.contactName = val('contactName');
      return { ms };
    }
    return { node, read, focusFirst: () => roleSet.querySelector('input').focus() };
  }

  function gapForm(getMode, onSent, onCancel) {
    const areas = fromData('areas');
    const categories = fromData('categories');
    const supportAreaId = uid('sarea');
    const service = serviceQuestions();
    const supportSub = el('div', { class: 'fb-sub', hidden: true },
      ticks([t('fbSupportLegend')], [...categories.map((c) => ({ value: c, label: c, lang: 'en' })), { value: SOMETHING_ELSE, label: t('fbSomethingElse') }], 'category'),
      select(supportAreaId, t('fbSupportArea'), areas));
    const form = shell('fb-gap-form', submit, onCancel,
      ticks([t('fbGapLegend')], [
        { value: 'missing-service', label: t('fbGapService'), extra: service.node },
        { value: 'missing-support', label: t('fbGapSupport'), extra: supportSub },
        { value: 'missing-other', label: t('fbGapOther') },
      ], 'gap', 'radio'),
      comment());
    // One kind of gap at a time: show the extra questions for the one chosen.
    form.addEventListener('change', (e) => {
      if (e.target.name !== 'gap') return;
      for (const r of form.querySelectorAll('input[name=gap]')) {
        const sub = r.closest('.fb-tick').querySelector('.fb-sub');
        if (sub) sub.hidden = !r.checked;
      }
    });
    form.focusFirst = () => form.querySelector('input[name=gap]').focus();
    async function submit(f) {
      const reasons = ticked(f, 'gap');
      if (!reasons.length) return f.fail(t('fbNeedOne'), f.querySelector('input[name=gap]'));
      const payload = { kind: 'gap', reasons, text: textOf(f), mode: getMode(), lang: window.I18N.lang };
      if (reasons.includes('missing-service')) {
        const r = service.read(f);
        if (r.error) return f.fail(r.error, r.focus);
        payload.missedService = r.ms;
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
        if (enabled) suggestButton();
        return enabled;
      })
      .catch(() => false);
  }

  // "Suggest a service" in the header: opens the form in a panel at the top of the page, at any time.
  function suggestButton() {
    const btn = document.getElementById('suggest-btn');
    const panel = document.getElementById('suggest-panel');
    if (!btn || !panel) return;
    btn.hidden = false;
    const close = () => {
      panel.hidden = true;
      panel.replaceChildren();
      btn.setAttribute('aria-expanded', 'false');
      btn.focus();
    };
    btn.addEventListener('click', () => {
      if (!panel.hidden) return close();
      const form = gapForm(currentMode, (f) => {
        thank(f, 'fbThanksGap');
        panel.append(el('div', { class: 'fb-actions' }, el('button', { type: 'button', class: 'btn secondary small', text: t('fbClose'), onclick: close })));
      }, close);
      panel.replaceChildren(
        el('h2', { id: 'suggest-title', class: 'suggest-title', text: t('suggestTitle') }),
        el('p', { class: 'fb-note', text: t('suggestIntro') }),
        form);
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
      form.focusFirst();
    });
  }

  window.FEEDBACK = { init, cardControl, replyControls, redact, get enabled() { return enabled; } };
})();
