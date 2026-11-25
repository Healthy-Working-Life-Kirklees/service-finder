// The listing form: every question about a service, in one place, used by
//   - the provider review page (site/provider-check.js), where an organisation checks and corrects its listing, and
//   - All services in Admin (admin/services.js), where the team edits a service or adds a new one.
// Both show the same questions with the same wording, in the same order, so a partner and the team are always
// looking at the same thing. Team-only questions are shown only in "team" mode.
//
// Three parts (November 2026 redesign):
//   1. The service and who can join: the organisation (and any partners), the service, who can use it (where they
//      live, health, work situation, age, any other eligibility, who it isn't for), priority groups and the kind of
//      support. These are asked once, for the whole service.
//   2. Contact and how people get in: contact details, whether a referral is needed and who can make it, and how.
//   3. Activities and timetable: each activity (a project in the data), whether it has cohorts, and where and when
//      it meets. An activity or cohort can only narrow who the service is for, never widen it.
// On the partner page the parts are shown one at a time ("stepped"), with links between them; in Admin they are all
// on one page.
//
// Where each answer came from (LISTING.labelOf) is shown next to it: "Found on your website" or "Unknown: please
// answer". Partners must answer the unknown "who can use it" and referral questions before sending changes.
//
// Data shapes: a cohort is stored as the sessions of a project that share a group of their own (name, age,
// criteria, dates, places): one session per time and place. A time and place with no group is a plain session.
//
// Needs site/listing-logic.js. English only, like the team pages.
//
//   const f = LISTING_FORM.build({ values, original, mode, choices, organisations, venues, prefix, headingLevel, onChange, stepped, listingLabel, showLabels });
//   (showLabels: false for a brand new service, where every answer would otherwise say "Unknown")
//   f.node       the form's parts, to put inside your own <form>
//   f.parts      the three part elements (append your own send box to the last one)
//   f.read()     every answer, in the same shape as the data
//   f.changes()  only the answers that differ from "original"
//   f.check()    null, or { message, el } for the first problem (the part holding it is shown)
//   f.mark(ch)   marks the questions in ch as "Changed"
//   f.show(n)    shows part n (1 to 3) when stepped
//   f.addProject()  adds an empty activity and focuses it
(() => {
  'use strict';

  const L = globalThis.LISTING;
  const PLACEHOLDER = 'To be completed';

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
  // Compares answers whatever order an object's keys are in, treating empty as missing.
  const canon = (v) => {
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return null;
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]).filter(([, x]) => x !== null));
    return v;
  };
  const norm = (v) => JSON.stringify(canon(v));
  const linesOf = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const slug = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
  const tbc = (v) => JSON.stringify(v == null ? '' : v).includes(PLACEHOLDER);
  const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i;
  const andList = (a) => (a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0] || '');

  const HEALTH = {
    any: 'Any health condition or disability',
    'mental-health': 'Mental health',
    'severe-mental-illness': 'Severe mental illness',
    'musculoskeletal-pain': 'Muscle, joint or back pain (musculoskeletal)',
    'substance-use': 'Drug or alcohol use',
    'learning-disability-autism': 'Learning disability or autism',
    'unpaid-caring': 'Unpaid caring',
  };
  const AUDIENCE = { individual: 'People looking for support for themselves', employer: 'Employers', organisation: 'Organisations and professionals', student: 'Students' };
  const SELF = { yes: 'Yes', partly: 'Sometimes (some people can)', no: 'No, they need to be referred', tbc: 'Not decided yet' };
  const LEVEL = { local: 'Local (Kirklees)', regional: 'Regional (West Yorkshire or wider)', national: 'National' };
  const DATE_LABEL = { referralsFrom: 'Taking referrals from', referralsUntil: 'Taking referrals until', runsFrom: 'Runs from', runsTo: 'Runs until' };
  const DATE_ORDER = ['referralsFrom', 'referralsUntil', 'runsFrom', 'runsTo'];
  const DATES_HINT = "Leave blank if it's ongoing. After an end date, or the date referrals close, it stops showing in the Support Finder by itself. We'll check with you 30 days before.";
  const ESSENTIAL_HINT = 'Tick "Essential" only if you would have to turn someone away without it: the Support Finder won\'t suggest you to people who clearly don\'t meet it.';
  const PARTS = ['The service and who can join', 'Contact and how people get in', 'Activities and timetable'];
  const BENEFITS = ['Universal Credit, with a work coach (looking for work)', 'Universal Credit, any', "Jobseeker's Allowance (JSA)", 'Employment and Support Allowance (ESA)', 'Personal Independence Payment (PIP)'];
  const TOWNS = ['Batley', 'Colne Valley', 'Dewsbury', 'Holme Valley', 'Huddersfield', 'Kirkburton', 'Mirfield', 'Spen Valley'];

  // The answers whose label is shown (found online, or unknown), and the box they belong to.
  const LABELLED = ['organisationOverview', 'whoFor', 'residence', 'healthFocus', 'work', 'age', 'eligibility', 'exclusions', 'groups', 'audience', 'categories', 'webpage', 'email', 'phone', 'referral', 'referralRoutes', 'languages', 'workExperience', 'coachNotes', 'projects'];
  // The new questions, which stay "unknown" until they're answered. Partners can leave them (or anything else
  // optional) blank: before sending they are told what is still unanswered, and can send anyway.
  const NEW_QUESTIONS = { residence: 'Who can use it, by where they live', work: 'Work situation', referral: 'Does someone need a referral?' };
  // On the partner page, a required answer we already had that is left blank keeps what we had, rather than being
  // wiped (blank means "not changing it", not "none").
  const KEEP_IF_BLANK = ['workExperience', 'referralRoutes', 'audience', 'categories'];

  // "18+", "16-25", "16 to 25", "18 and over", "up to 25": the numbers, when the words are that simple.
  function ageNumbers(t) {
    const s = String(t || '').trim().toLowerCase();
    let m;
    if ((m = s.match(/^(\d{1,3}) ?\+$/)) || (m = s.match(/^(\d{1,3}) (and|or) (over|above|older)$/)) || (m = s.match(/^(over|aged) (\d{1,3})$/))) return { min: Number(m[2] && /\d/.test(m[2]) ? m[2] : m[1]) };
    if ((m = s.match(/^(\d{1,3}) ?(-|–|to) ?(\d{1,3})$/))) return { min: Number(m[1]), max: Number(m[3]) };
    if ((m = s.match(/^(up to|under) (\d{1,3})$/))) return { max: Number(m[2]) - (m[1] === 'under' ? 1 : 0) };
    return null;
  }

  // ---------- one form ----------
  function build(opts) {
    const mode = opts.mode === 'team' ? 'team' : 'partner';
    const team = mode === 'team';
    const values = opts.values || {};
    const original = opts.original || values;
    const choices = opts.choices || {};
    const venues = list(opts.venues);
    const venueById = new Map(venues.map((v) => [v.id, v]));
    const P = opts.prefix || 'lf';
    const HL = opts.headingLevel || 2;
    const H = 'h' + HL;
    const SUBH = 'h' + Math.min(6, HL + 1);
    const id = (k) => P + '-' + k;
    let seq = 0;
    const uid = (k) => P + '-' + k + '-' + ++seq;
    const boxes = {}; // key -> the element holding that question (for "Changed", labels and focusing)
    const readers = {}; // key -> () => value
    const root = el('div', { class: 'lf' + (opts.stepped ? ' lf-stepped' : '') });
    const changed = () => opts.onChange && opts.onChange();
    const venueListId = id('venue-list');
    const venueLabel = (v) => `${v.name} (${L.venueLine(v)})`;
    root.append(el('datalist', { id: venueListId }, venues.map((v) => el('option', { value: venueLabel(v) }))));
    const orgListId = id('orgs');
    root.append(el('datalist', { id: orgListId }, list(opts.organisations).map((n) => el('option', { value: n }))));
    // The listing's own label (for labelOf): the partner page is told it, as it isn't sent the provenance.
    const labelSource = opts.listingLabel ? { ...values, provenance: undefined, hwlFunded: opts.listingLabel === 'confirmed' } : values;
    const labelOf = (k) => L.labelOf(labelSource, k);

    // A character count under a text box, for the boxes with a limit.
    function counter(input, limit) {
      const c = el('p', { class: 'lf-count', id: input.id + '-count' });
      const upd = () => {
        const n = input.value.trim().length;
        c.textContent = n + ' of ' + limit + ' characters' + (n > limit ? ' (too long: please shorten it)' : '');
        c.classList.toggle('over', n > limit);
      };
      input.addEventListener('input', upd);
      upd();
      return c;
    }
    const described = (...ids) => ids.filter(Boolean).join(' ') || null;
    const changedTag = () => el('p', { class: 'changed-tag', text: 'Changed', hidden: true });
    const small = (t) => el('button', { type: 'button', class: 'btn secondary small', ...t });
    const hintP = (text, hid) => (text ? el('p', { class: 'hint', id: hid || null, text }) : null);

    function textQuestion(k, label, hint, o, val) {
      const hintId = hint ? id(k) + '-hint' : null;
      const input = o.area
        ? el('textarea', { id: id(k), rows: '3', 'aria-describedby': described(hintId, o.limit ? id(k) + '-count' : null) })
        : el('input', { id: id(k), type: o.type || 'text', autocomplete: 'off', list: o.list || null, placeholder: o.placeholder || null, 'aria-describedby': described(hintId), required: o.required ? true : null });
      input.value = val == null ? '' : String(val);
      const box = el('div', { class: 'lf-field' + (tbc(val) ? ' tbc' : ''), 'data-key': k },
        el('label', { for: id(k), text: label + (o.required ? ' (mandatory)' : '') }),
        hintP(hint, hintId), input, o.limit ? counter(input, o.limit) : null, changedTag());
      // A web address typed without https:// (www.example.org, example.org/page) gets it added, as browsers do.
      if (o.type === 'url') {
        const fix = () => { const t = input.value.trim(); if (t && !/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) input.value = 'https://' + t; };
        input.addEventListener('blur', fix);
        return { box, input, read: () => { fix(); return input.value.trim(); } };
      }
      return { box, input, read: () => input.value.trim() };
    }

    // A list of lines, one box each, with "Remove" and "Add another".
    function linesQuestion(k, label, hint, val, o = {}) {
      const holder = el('div', { class: 'lf-lines' });
      const add = (v) => {
        const i = el('input', { type: 'text', id: uid(k), value: v || '', list: o.list || null, 'aria-label': (o.aria || label) + ' ' + (holder.children.length + 1), placeholder: o.placeholder || null });
        const r = el('div', { class: 'lf-line' }, i, small({ text: 'Remove', 'aria-label': 'Remove this line', onclick: () => { r.remove(); changed(); } }));
        r._input = i;
        holder.append(r);
        return i;
      };
      for (const v of list(val)) add(v);
      if (!holder.children.length && !o.empty) add('');
      const box = el(o.inner ? 'div' : 'div', { class: 'lf-field' + (tbc(val) ? ' tbc' : ''), 'data-key': k },
        el('p', { class: 'lf-lab', text: label }), hintP(hint), holder,
        small({ text: o.addText || 'Add another', onclick: () => { add('').focus(); changed(); } }), o.inner ? null : changedTag());
      return { box, read: () => [...holder.children].map((r) => r._input.value.trim()).filter(Boolean), first: () => holder.querySelector('input') };
    }

    function checksQuestion(k, label, hint, opts2, labels, val, o = {}) {
      const have = new Set(list(val));
      const hintId = hint ? id(k) + '-hint' : null;
      const box = el('fieldset', { class: 'lf-field lf-checks' + (o.columns ? ' lf-cols' : ''), 'data-key': k, id: id(k), 'aria-describedby': hintId },
        el('legend', { text: label }), hintP(hint, hintId),
        el('div', { class: 'choices' }, opts2.map((v) => el('label', {}, el('input', { type: 'checkbox', value: v, checked: have.has(v) }), (labels && labels[v]) || v))),
        o.inner ? null : changedTag());
      // Keep the order the service already has (the main kind of support first); newly ticked ones go last.
      const read = () => {
        const ticked = [...box.querySelectorAll(':scope > .choices input:checked')].map((i) => i.value);
        const had = list(val).filter((v) => ticked.includes(v));
        return [...had, ...ticked.filter((v) => !had.includes(v))];
      };
      return { box, read };
    }

    // Radio buttons. Returns the box, the chosen value, and a way to listen for changes.
    function radios(k, label, options, val, hint) {
      const name = uid(k);
      const hintId = hint ? name + '-hint' : null;
      const box = el('fieldset', { class: 'lf-field lf-radios', 'data-key': k, id: id(k), 'aria-describedby': hintId },
        el('legend', { text: label }), hintP(hint, hintId),
        el('div', { class: 'choices lf-stack' }, options.map(([v, t]) => el('label', {}, el('input', { type: 'radio', name, value: v, checked: val === v }), t))));
      const get = () => { const c = box.querySelector(':scope > .choices input:checked'); return c ? c.value : ''; };
      return { box, get, on: (fn) => box.querySelector(':scope > .choices').addEventListener('change', fn), first: () => box.querySelector('input') };
    }
    // A box that opens under an answer.
    const opens = (...kids) => el('div', { class: 'lf-opens' }, ...kids);

    // Eligibility lines, each with an "Essential" tick. Reads back as { eligibility, gate }. A line that was only in
    // "gate" before (essential, not written as eligibility) stays that way unless it is changed or unticked.
    function eligList(lab, hint, elig, gate, compact, before) {
      const holder = el('div', { class: 'lf-elig-rows' });
      function row(text, essential, gateOnly) {
        const t = el('input', { type: 'text', id: uid('el'), 'aria-label': lab + ': one point' });
        t.value = text || '';
        const tick = el('input', { type: 'checkbox', id: uid('ess'), checked: essential });
        const r = el('div', { class: 'lf-elig' }, t, el('label', { class: 'lf-ess', for: tick.id }, tick, ' Essential'),
          small({ text: 'Remove', 'aria-label': 'Remove this point', onclick: () => { r.remove(); changed(); } }));
        r._read = () => ({ text: t.value.trim(), essential: tick.checked, gateOnly: gateOnly && tick.checked && t.value.trim() === text });
        r._input = t;
        holder.append(r);
        return r;
      }
      const g = new Set(list(gate));
      for (const e of list(elig)) row(e, g.has(e), false);
      for (const x of list(gate)) if (!list(elig).includes(x)) row(x, true, true);
      if (!holder.children.length && !compact) row('', false, false);
      const box = el('div', { class: 'lf-field lf-elig-box' },
        el('p', { class: 'lf-lab', text: lab }), hintP(hint), before || null, holder,
        small({ text: compact ? 'Add a point' : 'Add another line', onclick: () => { row('', false, false)._input.focus(); changed(); } }));
      const read = () => {
        const rows = [...holder.children].map((r) => r._read()).filter((x) => x.text);
        return { eligibility: rows.filter((x) => !x.gateOnly).map((x) => x.text), gate: rows.filter((x) => x.essential).map((x) => x.text) };
      };
      return { box, read };
    }

    function datesGroup(prefix, src, legend, refWord) {
      const ins = {};
      const box = el('fieldset', { class: 'lf-dates' }, el('legend', { text: legend }), el('p', { class: 'hint', text: DATES_HINT }),
        el('div', { class: 'lf-grid' }, DATE_ORDER.map((k) => {
          const i = el('input', { type: 'date', id: uid(prefix + k) });
          i.value = (src && src[k]) || '';
          ins[k] = i;
          const lab = refWord ? DATE_LABEL[k].replace('Taking referrals', refWord) : DATE_LABEL[k];
          return el('div', { class: 'lf-field' }, el('label', { for: i.id, text: lab }), i);
        })));
      return { box, read: () => Object.fromEntries(L.DATE_KEYS.filter((k) => ins[k].value).map((k) => [k, ins[k].value])) };
    }

    // ----- a venue: pick one we know as you type, or write out a new one -----
    function venuePicker(lab, value) {
      const pick = el('input', { type: 'text', id: uid('venue'), list: venueListId, autocomplete: 'off' });
      const known = typeof value === 'string' ? venueById.get(value) : null;
      if (known) pick.value = venueLabel(known);
      else if (value && typeof value === 'object') pick.value = value.name || '';
      else if (typeof value === 'string') pick.value = value;
      const nName = el('input', { type: 'text', id: uid('vn') });
      const nAddr = el('input', { type: 'text', id: uid('va') });
      const nPc = el('input', { type: 'text', id: uid('vp'), autocomplete: 'off', size: '10' });
      if (value && typeof value === 'object') { nName.value = value.name || ''; nAddr.value = value.address || ''; nPc.value = value.postcode || ''; }
      nPc.addEventListener('input', () => { const c = nPc.value.replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().slice(0, 8); if (c !== nPc.value) nPc.value = c; });
      const hintId = uid('vh');
      const status = el('p', { class: 'hint lf-match', id: hintId });
      const fresh = el('div', { class: 'lf-newvenue', hidden: true },
        el('p', { class: 'hint', text: "A place we don't list yet. Please give its name, address and full postcode, so it can go on the map and the timetable." }),
        el('div', { class: 'lf-grid' },
          el('div', { class: 'lf-field' }, el('label', { for: nName.id, text: 'Name of the place' }), nName),
          el('div', { class: 'lf-field' }, el('label', { for: nAddr.id, text: 'Address' }), nAddr),
          el('div', { class: 'lf-field' }, el('label', { for: nPc.id, text: 'Full postcode' }), nPc)));
      const match = () => venues.find((v) => venueLabel(v) === pick.value.trim());
      const upd = () => {
        const v = pick.value.trim();
        const m = match();
        fresh.hidden = !v || Boolean(m);
        if (!fresh.hidden && !nName.value) nName.value = v;
        status.textContent = !v ? 'Start typing to choose a place we already list.' : m ? (m.ward ? `A place we know, in ${m.ward} ward.` : 'A place we know.') : '';
      };
      pick.addEventListener('input', upd);
      pick.addEventListener('change', upd);
      pick.setAttribute('aria-describedby', hintId);
      upd();
      const node = el('div', { class: 'lf-field lf-venue' }, el('label', { for: pick.id, text: lab }), pick, status, fresh);
      return {
        node,
        input: pick,
        read() {
          const v = pick.value.trim();
          if (!v) return null;
          const m = match();
          if (m) return m.id;
          return { name: nName.value.trim(), address: nAddr.value.trim(), postcode: nPc.value.trim().toUpperCase() };
        },
        problem() {
          const r = this.read();
          if (!r || typeof r === 'string') return null;
          if (!r.name) return { message: 'Please give the new place a name.', el: nName };
          if (!r.address) return { message: `Please give the address of ${r.name}.`, el: nAddr };
          if (!POSTCODE_RE.test(r.postcode)) return { message: `Please give the full postcode of ${r.name}, such as WF17 5DR.`, el: nPc };
          return null;
        },
      };
    }

    const allPickers = [];
    const smallText = (lab, v, hintText, o = {}) => {
      const i = el(o.area ? 'textarea' : 'input', { type: o.area ? null : 'text', id: uid('p'), rows: o.area ? '3' : null, placeholder: o.placeholder || null });
      i.value = v || '';
      return { node: el('div', { class: 'lf-field' }, el('label', { for: i.id, text: lab }), hintP(hintText), i, o.limit ? counter(i, o.limit) : null), get: () => i.value.trim(), input: i };
    };
    const smallLines = (lab, v, hintText) => {
      const i = el('textarea', { id: uid('p'), rows: String(Math.max(2, list(v).length + 1)) });
      i.value = list(v).join('\n');
      return { node: el('div', { class: 'lf-field' }, el('label', { for: i.id, text: lab }), hintP(hintText), i), get: () => linesOf(i.value) };
    };

    // ----- a time and place: a venue, days, times, how often -----
    function placeRow(holder, s = {}, o = {}) {
      const picker = venuePicker('Place', s.venue);
      allPickers.push(picker);
      const dayBoxes = L.DAYS.map((d) => el('label', {}, el('input', { type: 'checkbox', value: d, checked: list(s.days).includes(d) }), ' ' + L.DAY_NAMES[d].slice(0, 3)));
      const start = el('input', { type: 'time', id: uid('st'), step: '300' });
      start.value = s.start || '';
      const end = el('input', { type: 'time', id: uid('en'), step: '300' });
      end.value = s.end || '';
      const freq = el('select', { id: uid('fr') }, Object.entries(L.FREQUENCY).map(([k, w]) => el('option', { value: k, text: w[0].toUpperCase() + w.slice(1) })));
      freq.value = s.frequency || 'weekly';
      const freqWas = s.frequency || '';
      const note = smallText('Anything else about when, in words', s.note, 'For example "first Tuesday of the month" or "term time only".');
      // Two things most people won't need, each folded away next to what it is about:
      // a place with no postcode (under the place), and dates that differ from the activity's (at the end).
      // An online session (a group on Zoom on Tuesdays, say) has no place: "This one is online" takes the place's
      // spot. It only shows when the activity runs online or by phone. Other places in words (from older listings)
      // stay in a box of their own, and only show if there are some.
      const isOnline = (x) => /^online\b/i.test(String(x).trim());
      const wasOnline = list(s.where).some(isOnline);
      const onlineTick = el('input', { type: 'checkbox', checked: wasOnline });
      const onlineBox = el('div', { class: 'lf-field lf-online' }, el('label', {}, onlineTick, ' This one is online, so there is no place'));
      const otherWhere = list(s.where).filter((x) => !isOnline(x));
      const where = smallLines('Other places, in words', otherWhere, 'Only for places without a postcode.');
      const whereMore = otherWhere.length ? where.node : null;
      const syncOnline = () => {
        const proj = onlineBox.closest('.lf-proj');
        const on = proj ? Boolean(proj.querySelector(':scope > .lf-runs input[value=online]:checked')) : true;
        onlineBox.hidden = !on && !onlineTick.checked;
        picker.node.hidden = onlineTick.checked;
      };
      onlineTick.addEventListener('change', syncOnline);
      // A plain time and place (no cohort) can have its own dates, for example an earlier run that has ended.
      const dates = o.ownDates ? datesGroup('s', s, 'Dates for this time and place') : null;
      const datesMore = dates ? el('details', { class: 'lf-more' }, el('summary', { text: 'Does this time and place have different dates from the rest of the activity?' }),
        el('p', { class: 'hint', text: 'Only if it starts or ends at a different time, for example an earlier run. Otherwise leave this empty: it uses the activity\'s dates.' }), dates.box) : null;
      if (dates && L.DATE_KEYS.some((k) => s[k])) datesMore.open = true;
      const fs = el('fieldset', { class: 'lf-session', 'data-id': s.id || '' }, el('legend', { text: 'Time and place' }),
        onlineBox, picker.node, whereMore,
        el('fieldset', { class: 'lf-days' }, el('legend', { text: 'Days' }), el('div', { class: 'choices' }, dayBoxes)),
        el('div', { class: 'lf-grid' },
          el('div', { class: 'lf-field' }, el('label', { for: start.id, text: 'From' }), start),
          el('div', { class: 'lf-field' }, el('label', { for: end.id, text: 'Until' }), end),
          el('div', { class: 'lf-field' }, el('label', { for: freq.id, text: 'How often' }), freq)),
        note.node, datesMore,
        small({ text: 'Remove this time and place', onclick: () => { fs.remove(); allPickers.splice(allPickers.indexOf(picker), 1); changed(); } }));
      fs._read = () => {
        const out = { id: fs.dataset.id };
        const v = picker.read();
        if (v) out.venue = v;
        const w = [...(onlineTick.checked ? ['Online'] : []), ...where.get()];
        if (w.length) out.where = w;
        if (onlineTick.checked) delete out.venue;
        const days = dayBoxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
        if (days.length) out.days = days;
        if (start.value) out.start = start.value;
        if (end.value) out.end = end.value;
        // "Every week" is the default: only stored when it was there before, or another choice is made for a day or time.
        if (freqWas) out.frequency = freq.value;
        else if ((days.length || start.value) && freq.value !== 'weekly') out.frequency = freq.value;
        const n = note.get();
        if (n) out.note = n;
        if (s.when && !days.length) out.when = s.when; // "when" in words from before November 2026, kept until there are days
        if (dates) Object.assign(out, dates.read());
        return out;
      };
      fs._first = picker.input;
      fs._picker = picker;
      fs._syncOnline = syncOnline;
      holder.append(fs);
      syncOnline();
      return fs;
    }
    function timetable(rows, o) {
      const holder = el('div', { class: 'lf-sessions' });
      for (const s of rows) placeRow(holder, s, o);
      const box = el('div', { class: 'lf-sessions-box' },
        el(SUBH, { class: 'lf-sub', text: o.title }),
        hintP('Add one for each place and day, with the times.'),
        holder,
        small({ text: 'Add a time and place', onclick: () => { placeRow(holder, {}, o)._first.focus(); changed(); } }));
      return { box, holder, read: () => [...holder.children].map((c) => c._read()).filter((x) => Object.keys(x).length > 1) };
    }

    // Who an activity or cohort is for, when it is narrower than the level above: an age, and criteria.
    function narrower(src, what) {
      const age = smallText('Age for this ' + what, src.age, 'For example 18 to 24, or 50+. Leave empty if the age is the same.');
      const elig = eligList('Anything else only this ' + what + ' needs', 'It can only narrow who the service is for. ' + ESSENTIAL_HINT, src.eligibility, src.gate, true);
      return { node: opens(el('div', { class: 'lf-grid' }, age.node), elig.box), age, elig };
    }

    // ----- a cohort: one run, or one group, made of the sessions that share it -----
    const GROUP_KEYS = ['name', 'age', 'eligibility', 'gate', 'places', ...L.DATE_KEYS];
    const groupKey = (s) => JSON.stringify(GROUP_KEYS.map((k) => canon(s[k])));
    function cohortBox(holder, sessions, act) {
      const first = sessions[0] || {};
      const name = smallText('Name of the cohort (mandatory)', first.name, 'For example "Cohort 1: ages 18 to 24". This is how coaches and the AI tell them apart.');
      const isNarrow = Boolean(first.age || list(first.eligibility).length || list(first.gate).length);
      const open = radios('cohort-open', 'Is this cohort open to everyone the activity is for?', [['yes', 'Yes'], ['no', "No, it's for a particular group"]], sessions.length ? (isNarrow ? 'no' : 'yes') : '');
      const nar = narrower(first, 'cohort');
      const showNar = () => { nar.node.hidden = open.get() !== 'no'; };
      open.on(showNar);
      const dates = datesGroup('c', first, 'Dates for this cohort', act.refWord());
      const places = smallText('Number of places', first.places, 'Leave empty if not limited.');
      places.input.addEventListener('input', () => { const c = places.input.value.replace(/\D/g, ''); if (c !== places.input.value && !/\D/.test(first.places || '')) places.input.value = c; });
      const tt = timetable(sessions.filter((x) => x.venue || list(x.days).length || x.start || x.note || list(x.where).length || x.when), { title: 'Where and when this cohort meets', ownDates: false });
      // Session ids are kept: the rows read back in order and take the cohort's existing ids first.
      const ids = sessions.map((x) => x.id).filter(Boolean);
      const legend = el('legend', {});
      const title = () => { legend.textContent = 'Cohort' + (name.get() ? ': ' + name.get() : ''); };
      name.input.addEventListener('input', title);
      title();
      const fs = el('fieldset', { class: 'lf-session lf-group lf-cohort' }, legend, name.node, open.box, nar.node, dates.box, el('div', { class: 'lf-grid' }, places.node), tt.box,
        small({ text: 'Remove this cohort', onclick: () => { fs.remove(); changed(); } }));
      showNar();
      fs._read = () => {
        const g = {};
        if (name.get()) g.name = name.get();
        if (open.get() === 'no') {
          if (nar.age.get()) g.age = nar.age.get();
          const e = nar.elig.read();
          if (e.eligibility.length) g.eligibility = e.eligibility;
          if (e.gate.length) g.gate = e.gate;
        }
        if (places.get()) g.places = places.get();
        Object.assign(g, dates.read());
        const rows = tt.read();
        const out = (rows.length ? rows : [{ id: '' }]).map((r, i) => ({ ...r, ...g, id: r.id || ids[i] || '' }));
        return out;
      };
      fs._name = name.input;
      fs._open = open;
      fs._age = nar.age;
      holder.append(fs);
      return fs;
    }

    // ----- activities (projects in the data) -----
    function projectsQuestion(val) {
      const wrap = el('div', { class: 'lf-projects' });
      const multi = radios('multi', 'Does this service run more than one separate activity?', [['no', 'No, one activity'], ['yes', 'Yes']], list(val).length > 1 ? 'yes' : list(val).length ? 'no' : '', 'For example a weekly drop-in and a six-week course. Two groups doing the same thing at different times, or for different people, are cohorts, not separate activities.');
      const addBtn = small({ text: 'Add another activity', onclick: () => addNew() });
      const box = el('div', { class: 'lf-field lf-projects-box', 'data-key': 'projects' }, multi.box, wrap, addBtn, changedTag());
      const showMulti = () => {
        const n = wrap.children.length;
        if (n > 1) { multi.box.querySelector('input[value=yes]').checked = true; }
        multi.box.querySelector('input[value=no]').disabled = n > 1;
        addBtn.hidden = multi.get() !== 'yes';
        for (const fs of wrap.children) fs._remove.hidden = n < 2;
        renumber();
      };
      multi.on(showMulti);

      function addProject(p = {}) {
        const f = {
          name: smallText('Name of the activity', p.name, 'Leave empty if it\'s the same as the service.'),
          duration: smallText('How long someone takes part', p.duration, 'Not the dates or times, which go below. For example: 6 weekly sessions, up to 12 weeks of one-to-one support, or drop in as often as you like.'),
          area: smallText('Where appointments happen, or the area covered', p.area, 'For example "Home visits across Kirklees" or "At GP surgeries in Dewsbury".'),
          when: smallText('When, in words', p.when, 'For example opening hours, or "Flexible, arranged with you".'),
          where: smallLines('Other places, in words', p.where, 'Places without a postcode, for example "Online" or "Community venues across Kirklees".'),
          places: smallText('Number of places', p.places, 'Leave empty if not limited.'),
          cost: smallText('Cost', p.cost !== undefined ? p.cost : values.cost, 'Leave empty if you\'re not sure.', { placeholder: 'For example: Free, or £3 a session' }),
        };
        const ovId = uid('ov');
        const ov = el('textarea', { id: ovId, rows: '3', 'aria-describedby': ovId + '-count' });
        ov.value = p.overview || '';
        const ovBox = el('div', { class: 'lf-field' }, el('label', { for: ovId, text: 'What happens (mandatory)' }),
          hintP('What someone does or gets, in a few sentences.'), ov, counter(ov, L.LIMITS.projectOverview));
        // How it runs. "Set times and places" shows the timetable; by appointment or online asks where and when in words.
        const runs = new Set(list(p.runs));
        if (!runs.size && list(p.sessions).some((x) => x.venue || list(x.days).length)) runs.add('set');
        const runBoxes = Object.entries(L.RUNS).map(([k, w]) => el('label', {}, el('input', { type: 'checkbox', value: k, checked: runs.has(k) }), ' ' + w));
        const runSet = el('fieldset', { class: 'lf-field lf-checks lf-runs' }, el('legend', { text: 'How does it run? Tick all that apply.' }), el('div', { class: 'choices lf-stack' }, runBoxes));
        const ticked = () => new Set(runBoxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value));
        const isNarrow = Boolean(p.age || list(p.eligibility).length || list(p.gate).length || list(p.audience).length);
        const open = radios('act-open', 'Is this activity open to everyone the service is for?', [['yes', 'Yes'], ['no', "No, it's narrower"]], p.name || p.overview ? (isNarrow ? 'no' : 'yes') : '');
        const nar = narrower(p, 'activity');
        const aud = new Set(list(p.audience));
        const audBox = team ? el('fieldset', { class: 'lf-field lf-checks' }, el('legend', { text: 'Who this activity works with, if different from the service' }),
          el('div', { class: 'choices' }, list(choices.audience).map((v) => el('label', {}, el('input', { type: 'checkbox', value: v, checked: aud.has(v) }), AUDIENCE[v] || v)))) : null;
        if (audBox) nar.node.append(audBox);
        // Cohorts: the sessions with a group of their own (or their own dates), grouped.
        const sess = list(p.sessions);
        const isGroup = (s) => L.forGroup(s) || Boolean(s.name && L.DATE_KEYS.some((k) => s[k]));
        const groups = new Map();
        for (const s of sess.filter(isGroup)) { const k = groupKey(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
        const plain = sess.filter((s) => !isGroup(s));
        const cohorts = radios('cohorts', 'Are there different cohorts?', [['yes', 'Yes'], ['no', 'No']], groups.size ? 'yes' : p.name || p.overview ? 'no' : '',
          'Yes if it runs more than once with different dates (one after another), or for different groups at the same time (side by side).');
        const act = { refWord: () => (referralNeeded() === 'no' ? 'Open for people to join' : null) };
        const actDates = datesGroup('p', p, 'Dates', act.refWord());
        const cohortHolder = el('div', { class: 'lf-cohorts' });
        const fs = el('fieldset', { class: 'lf-proj' + (tbc(p) ? ' tbc' : ''), 'data-id': p.id || '' }, el('legend', { class: 'lf-proj-legend' }));
        for (const g of groups.values()) cohortBox(cohortHolder, g, act);
        const cohortBlock = el('div', { class: 'lf-cohort-block' }, cohortHolder,
          small({ text: 'Add another cohort', onclick: () => { cohortBox(cohortHolder, [], act)._name.focus(); changed(); } }));
        const plainTt = timetable(plain, { title: 'Where and when it meets', ownDates: true });
        const plainBlock = el('div', { class: 'lf-plain-block' }, actDates.box, el('div', { class: 'lf-grid' }, f.places.node), plainTt.box);
        const words = el('div', { class: 'lf-words' }, f.area.node, f.when.node);
        fs._remove = small({ text: 'Remove this activity', onclick: () => { fs.remove(); showMulti(); changed(); } });
        fs.append(f.name.node, ovBox, f.duration.node, f.cost.node, runSet, words, open.box, nar.node, cohorts.box, cohortBlock, plainBlock,
          list(p.where).length ? f.where.node : null,
          el('div', { class: 'lf-row' }, fs._remove));
        const showParts = () => {
          const t = ticked();
          for (const r of fs.querySelectorAll('.lf-session')) if (r._syncOnline) r._syncOnline();
          plainTt.box.hidden = !t.has('set') && !plainTt.holder.children.length;
          words.hidden = !(t.has('appointment') || t.has('online')) && !f.area.get() && !f.when.get();
          nar.node.hidden = open.get() !== 'no';
          cohortBlock.hidden = cohorts.get() !== 'yes';
          plainBlock.hidden = cohorts.get() !== 'no';
          for (const c of cohortHolder.children) c.querySelector('.lf-sessions-box').hidden = !t.has('set') && !c.querySelector('.lf-sessions').children.length;
        };
        runSet.addEventListener('change', () => {
          showParts();
          if (ticked().has('set') && cohorts.get() === 'no' && !plainTt.holder.children.length) placeRow(plainTt.holder, {}, { ownDates: true });
        });
        open.on(showParts);
        cohorts.on(() => {
          if (cohorts.get() === 'yes' && !cohortHolder.children.length) cohortBox(cohortHolder, [], act);
          showParts();
        });
        fs._showParts = showParts;
        showParts();
        fs._read = () => {
          const out = { id: fs.dataset.id, name: f.name.get() || p.name || '', overview: ov.value.trim() };
          const r = [...ticked()];
          if (r.length) out.runs = Object.keys(L.RUNS).filter((k) => r.includes(k));
          for (const k of ['area', 'when', 'duration', 'cost']) { const v = f[k].get(); if (v) out[k] = v; }
          const where = f.where.get();
          if (where.length) out.where = where;
          if (open.get() === 'no') {
            if (nar.age.get()) out.age = nar.age.get();
            const e = nar.elig.read();
            if (e.eligibility.length) out.eligibility = e.eligibility;
            if (e.gate.length) out.gate = e.gate;
            if (audBox) { const a = [...audBox.querySelectorAll('input:checked')].map((i) => i.value); if (a.length) out.audience = a; }
          } else if (!open.get()) {
            // Not answered yet: keep what was there.
            for (const k of ['age', 'eligibility', 'gate', 'audience']) if (p[k] !== undefined) out[k] = p[k];
          }
          if (cohorts.get() === 'yes') {
            const ss = [...cohortHolder.children].flatMap((c) => c._read());
            if (ss.length) out.sessions = ss;
            // The activity's own dates and places (each cohort has its own) are kept as they were.
            for (const k of [...L.DATE_KEYS, 'places']) if (p[k]) out[k] = p[k];
          } else {
            Object.assign(out, actDates.read());
            const pl = f.places.get();
            if (pl) out.places = pl;
            const ss = plainTt.read();
            if (ss.length) out.sessions = ss;
          }
          return out;
        };
        fs._name = f.name.input;
        fs._ov = ov;
        fs._runs = runSet;
        fs._open = open;
        fs._cohorts = cohorts;
        fs._cohortHolder = cohortHolder;
        fs._name.addEventListener('input', renumber);
        wrap.append(fs);
        return fs;
      }
      function renumber() {
        const n = wrap.children.length;
        [...wrap.children].forEach((fs, i) => { fs.querySelector('.lf-proj-legend').textContent = 'Activity' + (n > 1 ? ' ' + (i + 1) : '') + (fs._name.value.trim() ? ': ' + fs._name.value.trim() : ''); });
      }
      function addNew() {
        if (multi.get() !== 'yes') multi.box.querySelector('input[value=yes]').checked = true;
        const fs = addProject();
        showMulti();
        fs._name.focus();
        changed();
        return fs;
      }
      for (const p of list(val)) addProject(p);
      if (!wrap.children.length) addProject();
      showMulti();

      // New activities and sessions get an id made from their name (or venue and day), unique in the service.
      // Existing ones keep theirs.
      const read = () => {
        const ps = [...wrap.children].map((fs) => fs._read());
        const used = new Set();
        for (const p of ps) { if (p.id) used.add(p.id); for (const c of list(p.sessions)) if (c.id) used.add(c.id); }
        const fresh = (name, fallback) => {
          const base = slug(name) || fallback;
          let x = base;
          for (let n = 2; used.has(x); n++) x = base.slice(0, 46) + '-' + n;
          used.add(x);
          return x;
        };
        for (const p of ps) {
          if (!p.name) p.name = (readers.name && readers.name()) || 'Activity';
          if (!p.id) p.id = fresh(p.name, 'project');
          for (const c of list(p.sessions)) {
            if (c.id) continue;
            const v = typeof c.venue === 'string' ? venueById.get(c.venue) : c.venue;
            c.id = fresh([c.name, v && v.name, ...list(c.days)].filter(Boolean).join(' '), 'session');
          }
        }
        return ps;
      };
      return { box, read, rows: () => [...wrap.children], addNew, multi };
    }

    // ---------- the parts ----------
    const parts = PARTS.map((t, i) => el('div', { class: 'lf-part', 'data-part': String(i + 1) }));
    const section = (n, title, ...kids) => { const s = el('section', { class: 'lf-section' }, el(H, { text: title }), ...kids); parts[n - 1].append(s); return s; };
    const reg = (k, q) => { boxes[k] = q.box; if (q.read) readers[k] = q.read; return q.box; };

    // ===== Part 1: the service and who can join =====
    reg('organisation', textQuestion('organisation', 'Name of organisation', 'Start typing to choose from the organisations we already list. If yours isn\'t there, type its full name. If the service is run in partnership, put the lead organisation here: the one people contact.', { required: true, list: orgListId }, values.organisation));
    const orgMatch = el('p', { class: 'hint lf-match' });
    const orgIn = boxes.organisation.querySelector('input');
    const orgUpd = () => { const v = orgIn.value.trim(); orgMatch.textContent = !v ? '' : list(opts.organisations).includes(v) ? 'This is an organisation we already list.' : 'This will be added as a new organisation.'; };
    orgIn.addEventListener('input', orgUpd);
    orgUpd();
    boxes.organisation.insertBefore(orgMatch, boxes.organisation.querySelector('.changed-tag'));
    reg('organisationOverview', textQuestion('organisationOverview', 'What does your organisation do?', "A general overview that is included on every one of your services. Please don't mention funders here. Up to about 50 words.", { area: true, limit: L.LIMITS.orgOverview }, values.organisationOverview));
    const partners = linesQuestion('partners', 'Is this service run in partnership with other organisations?', 'List the partner organisations, one per line. Leave empty if none. They are shown on the service as "In partnership with".', values.partners, { list: orgListId, empty: true, addText: 'Add a partner', aria: 'Partner organisation' });
    reg('partners', { box: partners.box, read: () => partners.read() });
    section(1, 'About your organisation', boxes.organisation, boxes.organisationOverview, boxes.partners);

    reg('name', textQuestion('name', 'Name of the service', "Please add if it's different from the organisation's name.", { required: true }, values.name));
    reg('whoFor', textQuestion('whoFor', "Who it's for, in a sentence or two", 'Shown on the service card under its name. For example "Women in Kirklees with a health condition who want to get back into work."', { required: true, area: true, limit: L.LIMITS.whoFor }, values.whoFor));
    section(1, 'About the service',
      el('p', { class: 'lf-rule' }, el('strong', { text: 'Tell us about the service as a whole here.' }), ' Session details, places, days, times, and cohorts are added in part 3.'),
      boxes.name, boxes.whoFor);

    // Who can use it, by where they live.
    const res = values.residence || null;
    const where = radios('residence', 'Who can use it, by where they live?', [['anyone', 'Anyone, wherever they live'], ['west-yorkshire', 'People living in West Yorkshire'], ['kirklees', 'People living in Kirklees'], ['parts', 'Only people living in certain parts of Kirklees (opens a box to say which)']], res ? res.scope : '',
      "This is about where people live, not where you meet. Where you meet goes in part 3.");
    const towns = checksQuestion('residence-areas', 'Which parts of Kirklees? Tick all that apply.', '', TOWNS, null, res && res.areas, { inner: true });
    const townWarn = el('p', { class: 'lf-warn', role: 'status' });
    const townBox = opens(towns.box, townWarn);
    where.box.append(townBox, changedTag());
    const showTowns = () => {
      townBox.hidden = where.get() !== 'parts';
      const t = towns.read();
      const out = TOWNS.filter((x) => !t.includes(x));
      townWarn.hidden = !t.length || !out.length;
      townWarn.textContent = `People living in ${andList(out)} won't be shown this service. If you only mean where you meet, choose "People living in Kirklees" and add the place in part 3.`;
    };
    where.on(showTowns);
    towns.box.addEventListener('change', showTowns);
    reg('residence', { box: where.box, read: () => {
      const v = where.get();
      if (!v) return res;
      return v === 'parts' ? { scope: 'parts', areas: TOWNS.filter((x) => towns.read().includes(x)) } : { scope: v };
    } });

    // Health.
    const hf = values.healthFocus;
    const hfStart = !Array.isArray(hf) ? '' : !hf.length ? 'no' : hf.length === 1 && hf[0] === 'any' ? 'any' : 'specific';
    const health = radios('health', 'Does someone need a health condition or disability to use it?', [['no', 'No, anyone can use it'], ['any', 'Yes, any health condition or disability'], ['specific', 'Yes, a specific condition (opens a box to say which)']], hfStart);
    const healthTicks = checksQuestion('healthFocus-specific', 'Which? Tick all that apply.', 'Someone with any one of these can use it.', Object.keys(HEALTH).filter((k) => k !== 'any'), HEALTH, list(hf).filter((x) => x !== 'any'), { inner: true });
    const healthNote = textQuestion('healthNote', 'Other conditions, in your words', 'Only if the ticks above don\'t cover it, for example "Arthritis" or "Long COVID".', {}, values.healthNote);
    const healthBox = opens(healthTicks.box, healthNote.box);
    health.box.append(healthBox, changedTag());
    const showHealth = () => { healthBox.hidden = health.get() !== 'specific'; };
    health.on(showHealth);
    reg('healthFocus', { box: health.box, read: () => {
      const v = health.get();
      if (!v) return hf;
      if (v === 'no') return [];
      if (v === 'any') return ['any'];
      return healthTicks.read();
    } });
    readers.healthNote = () => (health.get() === 'specific' ? healthNote.read() : health.get() ? '' : healthNote.read());
    boxes.healthNote = healthNote.box;

    // Work situation.
    const wk = values.work || null;
    const work = radios('work', 'Does someone need to be in a particular work situation to use it?', [['no', "No, it doesn't matter whether they work"], ['yes', 'Yes (opens a box to say which)']], wk ? wk.needed : '');
    const WORK_OPEN = { benefits: ' (opens a box)', other: ' (opens a box)' };
    const workTicks = el('div', { class: 'choices lf-stack' });
    const benefitBox = checksQuestion('work-benefits', 'Which benefits? Tick all that apply.', '', [...BENEFITS, 'Other'], null, list(wk && wk.benefits).map((b) => (BENEFITS.includes(b) ? b : 'Other')), { inner: true });
    const benefitOther = textQuestion('work-benefit-other', 'Which other benefit?', '', { placeholder: '' }, list(wk && wk.benefits).filter((b) => !BENEFITS.includes(b)).join('; '));
    const benefitOpens = opens(benefitBox.box, benefitOther.box);
    const detail = textQuestion('work-detail', 'Anything more specific', 'For example an earnings limit ("earning under £20,000 a year") or another situation ("on a zero-hours contract").', {}, wk && wk.detail);
    const otherOpens = opens(detail.box);
    for (const [k, w] of Object.entries(L.WORK)) {
      workTicks.append(el('label', {}, el('input', { type: 'checkbox', value: k, checked: list(wk && wk.situations).includes(k) }), w + (WORK_OPEN[k] || '')));
      if (k === 'benefits') workTicks.append(benefitOpens);
      if (k === 'other') workTicks.append(otherOpens);
    }
    const workBox = opens(el('p', { class: 'lf-lab', text: 'Which work situations? Tick all that apply.' }), hintP('Someone in any one of the situations ticked can use it.'), workTicks);
    work.box.append(workBox, changedTag());
    const workTicked = () => [...workTicks.querySelectorAll(':scope > label > input:checked')].map((i) => i.value);
    const showWork = () => {
      workBox.hidden = work.get() !== 'yes';
      const t = workTicked();
      benefitOpens.hidden = !t.includes('benefits');
      otherOpens.hidden = !t.includes('other') && !detail.read();
      benefitOther.box.hidden = !benefitBox.read().includes('Other');
    };
    work.on(showWork);
    workTicks.addEventListener('change', showWork);
    reg('work', { box: work.box, read: () => {
      const v = work.get();
      if (!v) return wk;
      if (v === 'no') return { needed: 'no' };
      const out = { needed: 'yes', situations: workTicked() };
      if (out.situations.includes('benefits')) {
        const b = benefitBox.read().filter((x) => x !== 'Other');
        if (benefitBox.read().includes('Other') && benefitOther.read()) b.push(...benefitOther.read().split(/\s*;\s*/).filter(Boolean));
        if (b.length) out.benefits = b;
      }
      if (detail.read()) out.detail = detail.read();
      return out;
    } });

    // Age: numbers, "No age limit", and the words shown on the card.
    const nums = Number.isInteger(values.ageMin) || Number.isInteger(values.ageMax) ? { min: values.ageMin, max: values.ageMax } : ageNumbers(values.age);
    const noAgeWas = /^all ages$/i.test(String(values.age || ''));
    const noAge = el('input', { type: 'checkbox', id: id('noage'), checked: noAgeWas });
    const ageMin = el('input', { type: 'text', id: id('agemin'), inputmode: 'numeric', maxlength: '3', autocomplete: 'off', value: nums && nums.min != null ? String(nums.min) : '' });
    const ageMax = el('input', { type: 'text', id: id('agemax'), inputmode: 'numeric', maxlength: '3', autocomplete: 'off', value: nums && nums.max != null ? String(nums.max) : '' });
    const ageWordsBox = textQuestion('age', 'Age, as shown on the card', 'Filled in from the numbers. Add to it if there\'s more to say, for example "18+ (support can start before the 18th birthday)".', {}, values.age);
    const startMin = ageMin.value;
    const startMax = ageMax.value;
    let autoAge = values.age || '';
    const ageNum = (i) => (i.value === '' ? null : Number(i.value));
    const ageSync = () => {
      for (const i of [ageMin, ageMax]) { const c = i.value.replace(/\D/g, '').slice(0, 3); if (c !== i.value) i.value = c; }
      ageMin.disabled = ageMax.disabled = noAge.checked;
      const w = noAge.checked ? 'All ages' : L.ageWords({ ageMin: ageNum(ageMin) == null ? undefined : ageNum(ageMin), ageMax: ageNum(ageMax) == null ? undefined : ageNum(ageMax) });
      if (ageWordsBox.input.value.trim() === autoAge.trim() || !ageWordsBox.input.value.trim()) { ageWordsBox.input.value = w; autoAge = w; }
    };
    ageMin.addEventListener('input', ageSync);
    ageMax.addEventListener('input', ageSync);
    noAge.addEventListener('change', () => { if (noAge.checked) { ageMin.value = ''; ageMax.value = ''; } ageSync(); });
    ageMin.disabled = ageMax.disabled = noAgeWas;
    const ageBox = el('fieldset', { class: 'lf-field lf-age', 'data-key': 'ageMin' }, el('legend', { text: 'Age range' }),
      hintP('Leave "Up to age" empty if there is no upper age.'),
      el('label', { class: 'lf-inline', for: noAge.id }, noAge, ' No age limit'),
      el('div', { class: 'lf-grid lf-narrow' },
        el('div', { class: 'lf-field' }, el('label', { for: ageMin.id, text: 'From age' }), ageMin),
        el('div', { class: 'lf-field' }, el('label', { for: ageMax.id, text: 'Up to age' }), ageMax)),
      ageWordsBox.box, changedTag());
    boxes.ageMin = ageBox;
    boxes.ageMax = ageBox;
    boxes.age = ageBox;
    // Only stored once the numbers are changed, or were there before (so opening the form changes nothing).
    readers.ageMin = () => { const v = ageNum(ageMin); return Number.isInteger(values.ageMin) || ageMin.value !== startMin || ageMax.value !== startMax || noAge.checked !== noAgeWas ? (noAge.checked ? null : v) : values.ageMin; };
    readers.ageMax = () => { const v = ageNum(ageMax); return Number.isInteger(values.ageMax) || ageMin.value !== startMin || ageMax.value !== startMax || noAge.checked !== noAgeWas ? (noAge.checked ? null : v) : values.ageMax; };
    readers.age = () => ageWordsBox.read();

    // The written eligibility, with the answers from above shown first (not stored again).
    const fromAbove = el('div', { class: 'lf-fromabove', 'aria-live': 'polite' });
    const elig = eligList('Who can use it (eligibility)', 'Please add any additional eligibility, one point per line. ' + ESSENTIAL_HINT + ' Where they live, health, work situation and age from above are already here, so there\'s no need to write them again.', values.eligibility, values.gate, false, fromAbove);
    const eligBox = elig.box;
    eligBox.dataset.key = 'eligibility';
    eligBox.append(changedTag());
    boxes.eligibility = eligBox;
    boxes.gate = eligBox;
    readers.eligibility = () => elig.read().eligibility;
    readers.gate = () => elig.read().gate;
    const showAbove = () => {
      const now = { residence: readers.residence(), work: readers.work(), healthFocus: readers.healthFocus() };
      const lines = [];
      const r = L.residenceWords(now.residence);
      if (r && now.residence.scope !== 'anyone') lines.push(r);
      if (list(now.healthFocus).length) lines.push(now.healthFocus.includes('any') ? 'Has a health condition or disability' : 'Has ' + now.healthFocus.map((h) => HEALTH[h].toLowerCase()).join(', or '));
      const w = now.work && now.work.needed === 'yes' ? L.workWords(now.work) : '';
      if (w) lines.push('Work situation: ' + w);
      const a = ageWordsBox.read();
      if (a && !/^all ages$/i.test(a)) lines.push('Age: ' + a);
      fromAbove.replaceChildren(...lines.map((t) => el('p', { class: 'lf-above' }, el('span', { text: t }), el('span', { class: 'lf-above-tag', text: 'From above' }))));
    };
    const exclusions = linesQuestion('exclusions', "Who it isn't for", 'For example "People with work-search commitments as part of a benefits claim" or "Men (the service is for women)". Leave empty if none.', values.exclusions, { empty: true, aria: "Who it isn't for" });
    reg('exclusions', exclusions);
    section(1, 'Who can use it', where.box, health.box, work.box, ageBox, eligBox, boxes.exclusions);
    parts[0].addEventListener('input', showAbove);
    parts[0].addEventListener('change', showAbove);

    // Priority groups, who uses it and what kind of support.
    const gr = values.groups;
    const priority = radios('priority', 'Does the service have priority groups?', [['no', "No, it's open equally to everyone who can use it"], ['yes', 'Yes (tick which)']], !Array.isArray(gr) || !gr.length ? '' : gr.length === 1 && gr[0] === 'everyone' ? 'no' : 'yes');
    const groupTicks = checksQuestion('groups-ticks', 'Which groups?', 'Tick the groups the service particularly targets or prioritises.', list(choices.groups).filter((g) => g !== 'everyone'), L.GROUPS, list(gr).filter((g) => g !== 'everyone'), { inner: true });
    const groupBox = opens(groupTicks.box);
    priority.box.append(groupBox, changedTag());
    priority.box.dataset.key = 'groups';
    const showGroups = () => { groupBox.hidden = priority.get() !== 'yes'; };
    priority.on(showGroups);
    reg('groups', { box: priority.box, read: () => { const v = priority.get(); return !v ? gr : v === 'no' ? ['everyone'] : groupTicks.read(); } });
    reg('audience', checksQuestion('audience', 'Who uses it? Tick all that apply.', '', list(choices.audience), AUDIENCE, values.audience));
    // The kinds of support, then (when two or more are ticked) which one is the main one. The main one goes first in
    // the list; nothing else in the data changes.
    {
      const cat = checksQuestion('categories', 'What kind of support is it? Tick all that apply.', null, list(choices.categories), null, values.categories, { columns: true });
      const mainName = uid('main');
      let main = list(values.categories).length > 1 ? list(values.categories)[0] : '';
      const mainChoices = el('div', { class: 'choices lf-stack' });
      const mainBox = el('fieldset', { class: 'lf-field lf-radios lf-main' }, el('legend', { text: 'Which one is the main kind of support?' }), mainChoices);
      const drawMain = () => {
        const ticked = cat.read();
        if (!ticked.includes(main)) main = '';
        mainBox.hidden = ticked.length < 2;
        mainChoices.replaceChildren(...ticked.map((v) => el('label', {}, el('input', { type: 'radio', name: mainName, value: v, checked: v === main }), v)));
      };
      mainChoices.addEventListener('change', (e) => { if (e.target.name === mainName) main = e.target.value; });
      cat.box.querySelector(':scope > .choices').addEventListener('change', drawMain);
      cat.box.insertBefore(mainBox, cat.box.querySelector(':scope > .changed-tag'));
      drawMain();
      reg('categories', { box: cat.box, read: () => { const t = cat.read(); return main && t.includes(main) ? [main, ...t.filter((v) => v !== main)] : t; } });
    }
    section(1, 'Priority groups, and what kind of support', priority.box, boxes.audience, boxes.categories);

    // ===== Part 2: contact and how people get in =====
    reg('webpage', textQuestion('webpage', 'Website', 'The best page for people to find out more, for example www.example.org/our-service', { type: 'url' }, values.webpage));
    reg('email', textQuestion('email', 'Email address for the service', '', { type: 'email' }, values.email));
    reg('phone', textQuestion('phone', 'Phone number', 'You can add opening hours or a second number after it, for example "01484 000000 (Mon to Fri, 9 to 5)".', { type: 'tel' }, values.phone));
    reg('social', linesQuestion('social', 'Social media links', 'One per line.', values.social, { empty: true, aria: 'Social media link' }));
    section(2, 'Contact details', hintP("Please only give the service's work contact details, not anyone's personal details."), boxes.webpage, boxes.email, boxes.phone, boxes.social);

    const rf = values.referral || null;
    const refNeeded = radios('referral', 'Does someone need a referral before they can take part?', [['no', 'No, people can just turn up or sign up'], ['yes', 'Yes, they must be referred before taking part']], rf ? rf.needed : '');
    const referralNeeded = () => refNeeded.get() || (rf ? rf.needed : '');
    const refWho = radios('referral-who', 'Who can make a referral?', [['anyone', 'Anyone, including the person themselves'], ['professional', 'Only a professional (opens a box)']], rf && rf.who ? rf.who : '',
      'If people can refer themselves, a professional can usually use the same route for them.');
    const profs = textQuestion('referral-professionals', 'Which professionals can refer?', '', { placeholder: 'For example: GP, work coach or social worker' }, rf && rf.professionals);
    profs.input.placeholder = 'For example: GP, work coach or social worker';
    const profBox = opens(profs.box);
    refWho.box.append(profBox);
    const whoBox = opens(refWho.box);
    refNeeded.box.append(whoBox, changedTag());
    const routes = linesQuestion('referralRoutes', 'How to make a referral', '', values.referralRoutes, { aria: 'Way in' });
    const routesHint = routes.box.querySelector('.hint') || el('p', { class: 'hint' });
    if (!routesHint.parentNode) routes.box.insertBefore(routesHint, routes.box.querySelector('.lf-lines'));
    const routesLab = routes.box.querySelector('.lf-lab');
    const showRef = () => {
      const n = referralNeeded();
      whoBox.hidden = n !== 'yes';
      profBox.hidden = refWho.get() !== 'professional';
      routesLab.textContent = n === 'no' ? 'How people sign up or book, if they need to' : 'How to make a referral';
      routesHint.textContent = n === 'no' ? 'One per line: a link, an email address or a phone number. Leave empty if people just turn up.'
        : 'One per line: a link to a form, an email address or a phone number. If professionals use a different one, put it on its own line and say so, for example "Professionals: refer at example.org/pro".';
      for (const p of parts[2].querySelectorAll('.lf-proj')) if (p._showParts) p._showParts();
    };
    refNeeded.on(showRef);
    refWho.on(showRef);
    reg('referral', { box: refNeeded.box, read: () => {
      const n = refNeeded.get();
      if (!n) return rf;
      if (n === 'no') return { needed: 'no' };
      const w = refWho.get();
      if (!w) return { needed: 'yes', who: rf && rf.who ? rf.who : undefined };
      const out = { needed: 'yes', who: w };
      if (w === 'professional' && profs.read()) out.professionals = profs.read();
      return out;
    } });
    reg('referralRoutes', routes);
    // The older self-referral answer, kept in step with the referral answer (the card's badge falls back to it).
    const sr0 = values.selfReferral || { allowed: 'tbc', note: PLACEHOLDER };
    readers.selfReferral = () => {
      const r = readers.referral();
      if (!r || !refNeeded.get()) return sr0;
      const keep = sr0.url ? { url: sr0.url } : {};
      if (r.needed === 'no') return { allowed: 'yes', note: 'No referral needed: people can just turn up or sign up.', ...keep };
      if (r.who === 'anyone') return { allowed: 'yes', note: 'People can refer themselves.', ...keep };
      if (r.who === 'professional') return { allowed: 'no', note: 'Referral from a professional' + (r.professionals ? ': ' + r.professionals : '') + '.', ...keep };
      return sr0;
    };
    const paused = el('input', { type: 'checkbox', id: id('paused'), checked: values.open === false });
    const pausedBox = el('div', { class: 'lf-field lf-bool', 'data-key': 'open' }, el('label', { for: paused.id }, paused, ' Not taking referrals at the moment (paused)'),
      hintP("Only tick this if you've stopped for now with no end date. Planned dates go in part 3."), changedTag());
    reg('open', { box: pausedBox, read: () => !paused.checked });
    section(2, 'How people get in', refNeeded.box, boxes.referralRoutes, pausedBox);

    reg('languages', textQuestion('languages', 'Languages and formats offered besides English', 'For example "Interpreters available" or "Easy read leaflets".', {}, values.languages));
    reg('workExperience', textQuestion('workExperience', 'Does it include volunteering or work experience?', 'For example "No" or "Yes, a six-week placement".', { required: true }, values.workExperience));
    reg('coachNotes', textQuestion('coachNotes', 'Anything coaches should know', 'Shown on the service card. For example waiting times, or what to bring.', { area: true, limit: L.LIMITS.coachNotes }, values.coachNotes));
    section(2, 'Anything else', boxes.languages, boxes.workExperience, boxes.coachNotes);

    // ===== Part 3: activities and timetable =====
    const projects = projectsQuestion(values.projects);
    reg('projects', projects);
    const p3 = section(3, 'What happens, where and when', boxes.projects);
    if (team) {
      // Places used by every activity, and other places in words (mostly from before November 2026).
      const vHolder = el('div', { class: 'lf-venue-rows' });
      const vPickers = [];
      const addV = (v) => {
        const p = venuePicker('Place', v);
        vPickers.push(p);
        allPickers.push(p);
        const r = el('div', { class: 'lf-venue-row' }, p.node, small({ text: 'Remove', 'aria-label': 'Remove this place', onclick: () => { r.remove(); vPickers.splice(vPickers.indexOf(p), 1); allPickers.splice(allPickers.indexOf(p), 1); changed(); } }));
        vHolder.append(r);
        return p;
      };
      for (const v of list(values.venues)) addV(v);
      reg('venues', { box: el('div', { class: 'lf-field', 'data-key': 'venues' }, el('p', { class: 'lf-lab', text: 'Places used by every activity' }), hintP('Only if every activity uses the same places. Places for one activity go with it.'), vHolder,
        small({ text: 'Add a place', onclick: () => { addV(null).input.focus(); changed(); } }), changedTag()), read: () => vPickers.map((p) => p.read()).filter(Boolean) });
      reg('locations', linesQuestion('locations', 'Other places, in words', 'Places without a postcode, one per line, for example "Online" or "Community venues across Kirklees".', values.locations, { empty: true, aria: 'Place' }));
      p3.append(boxes.venues, boxes.locations);
    }

    // ===== Team only =====
    if (team) {
      reg('areas', checksQuestion('areas', 'Where it runs', 'The towns where it has a base or runs sessions. Tick "Kirklees-wide" if anyone in Kirklees can use it, and "Online" if it can be done online or by phone. This is not where people must live (that is "Who can use it, by where they live").', list(choices.areas), null, values.areas));
      reg('level', (() => { const sel = el('select', { id: id('level') }, list(choices.level).map((c) => el('option', { value: c, text: LEVEL[c] || c }))); sel.value = values.level || list(choices.level)[0] || ''; return { box: el('div', { class: 'lf-field', 'data-key': 'level' }, el('label', { for: sel.id, text: 'Level' }), sel, changedTag()), read: () => sel.value }; })());
      reg('reviewCycle', (() => { const sel = el('select', { id: id('reviewCycle') }, list(choices.reviewCycle).map((c) => el('option', { value: c, text: c }))); sel.value = values.reviewCycle || list(choices.reviewCycle)[0] || ''; return { box: el('div', { class: 'lf-field', 'data-key': 'reviewCycle' }, el('label', { for: sel.id, text: 'Review cycle' }), sel, changedTag()), read: () => sel.value }; })());
      const bool = (k, label, hint, def) => { const cb = el('input', { type: 'checkbox', id: id(k), checked: values[k] === undefined ? def : values[k] === true }); return { box: el('div', { class: 'lf-field lf-bool', 'data-key': k }, el('label', { for: id(k) }, cb, ' ' + label), hintP(hint), changedTag()), read: () => cb.checked }; };
      reg('hwlFunded', bool('hwlFunded', 'Healthy Working Life funded (this service only; never the organisation)', '', false));
      reg('mapLinks', bool('mapLinks', 'Show map and directions buttons on the card', 'Untick for a confidential venue.', true));
      reg('logo', textQuestion('logo', 'Logo file', 'A file name in site/img/logos/, such as example.webp. Leave empty for none.', {}, values.logo));
      reg('requiresMention', linesQuestion('requiresMention', 'Only shown when the person mentions', 'Words or patterns, one per line. Leave empty for most services.', values.requiresMention, { empty: true, aria: 'Word or pattern' }));
      reg('notes', textQuestion('notes', 'Team notes', 'For the team only. Never shown on the cards or sent to the AI.', { area: true }, values.notes));
      const t = el('section', { class: 'lf-section lf-team' }, el(H, { text: 'Team only' }), boxes.areas, boxes.level, boxes.reviewCycle, boxes.hwlFunded, boxes.mapLinks, boxes.logo, boxes.requiresMention, boxes.notes);
      parts[2].append(t);
    }

    // ---------- where each answer came from ----------
    const answers = values.answers || {};
    for (const k of opts.showLabels === false ? [] : LABELLED) {
      const box = boxes[k];
      if (!box) continue;
      const lab = labelOf(k === 'age' ? 'age' : k);
      if (lab !== 'found' && lab !== 'unknown') continue;
      if (lab === 'unknown' && !(k in NEW_QUESTIONS) && team) continue;
      const src = answers[k] && answers[k].source;
      const tag = el('p', { class: 'lf-label lf-label-' + lab },
        lab === 'found' ? 'Found on your website' : 'Unknown: please answer',
        lab === 'found' && src ? el('a', { href: src, target: '_blank', rel: 'noopener noreferrer', text: ' (where we found it)' }) : null,
        lab === 'found' && answers[k] && answers[k].quote ? el('span', { class: 'lf-quote', text: ' "' + answers[k].quote + '"' }) : null);
      const lead = box.querySelector(':scope > legend, :scope > label, :scope > .lf-lab');
      if (lead) lead.after(tag); else box.prepend(tag);
      box.classList.add('lf-is-' + lab);
    }

    // ---------- the parts, one at a time on the partner page ----------
    const steps = el('nav', { class: 'lf-steps', 'aria-label': 'Parts of the form' });
    let current = 1;
    function show(n) {
      current = Math.max(1, Math.min(3, n));
      if (!opts.stepped) return;
      parts.forEach((p, i) => { p.hidden = i + 1 !== current; });
      for (const b of steps.querySelectorAll('button')) b.setAttribute('aria-current', Number(b.dataset.part) === current ? 'step' : 'false');
    }
    // Moving between parts goes back to the top of the form. (The parts bar is sticky, so it is always "in view":
    // scroll to a mark just above it instead, then put the reader at the part's first heading.)
    const topMark = el('div', { class: 'lf-top' });
    function toTop() {
      topMark.scrollIntoView({ block: 'start' });
      const h = parts[current - 1].querySelector('h2, h3, h4');
      if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    }
    if (opts.stepped) {
      root.append(topMark);
      steps.append(...PARTS.map((t, i) => el('button', { type: 'button', class: 'lf-step', 'data-part': String(i + 1), text: i + 1 + '. ' + t, onclick: () => { show(i + 1); toTop(); } })),
        el('p', { class: 'hint lf-steps-note', text: 'Click any part to go back to it at any time. Nothing is sent until you press "Send" at the end.' }));
      root.append(steps);
      parts.forEach((p, i) => {
        const nav = el('div', { class: 'lf-partnav' },
          i > 0 ? small({ text: 'Back to part ' + i, onclick: () => { show(i); toTop(); } }) : el('span'),
          i < 2 ? el('button', { type: 'button', class: 'btn primary', text: 'Next: ' + PARTS[i + 1].toLowerCase(), onclick: () => { show(i + 2); toTop(); } }) : null);
        p.append(nav);
      });
    } else {
      parts.forEach((p, i) => p.prepend(el('p', { class: 'lf-part-title', text: 'Part ' + (i + 1) + ': ' + PARTS[i] })));
    }
    root.append(...parts);
    showTowns(); showHealth(); showWork(); showGroups(); showRef(); showAbove();
    show(1);
    if (opts.onChange) { root.addEventListener('input', opts.onChange); root.addEventListener('change', opts.onChange); }

    // Every answer, in the same shape as the data. Empty optional details are null.
    const NULLABLE = ['age', 'phone', 'webpage', 'email', 'cost', 'languages', 'coachNotes', 'notes', 'organisationOverview', 'logo', 'healthNote', 'partners', 'ageMin', 'ageMax', 'residence', 'work', 'referral'];
    function read() {
      const out = {};
      for (const [k, r] of Object.entries(readers)) out[k] = r();
      // Cost is asked for each activity. When they are all the same (or there is one activity) it is the service's
      // cost; when they differ, each activity keeps its own.
      if (Array.isArray(out.projects) && out.projects.length) {
        const costs = [...new Set(out.projects.map((p) => p.cost || ''))];
        if (costs.length === 1) { out.cost = costs[0] || null; for (const p of out.projects) delete p.cost; }
        else out.cost = null;
      }
      for (const k of NULLABLE) if (k in out && (out[k] === '' || out[k] === undefined || (Array.isArray(out[k]) && !out[k].length))) out[k] = null;
      if ('requiresMention' in out && !out.requiresMention.length) out.requiresMention = null;
      if ('venues' in out && !out.venues.length) out.venues = null;
      if (out.referral && out.referral.who === undefined) delete out.referral.who;
      if (!team) for (const k of KEEP_IF_BLANK) if (k in out && (!out[k] || (Array.isArray(out[k]) && !out[k].length)) && original[k] != null) out[k] = original[k];
      return out;
    }
    function changes() {
      const now = read();
      const ch = {};
      for (const [k, v] of Object.entries(now)) {
        const was = original[k] === undefined && k === 'mapLinks' ? true : original[k];
        // The essential lines are a set: the same lines in a different order is not a change.
        if (k === 'gate' && Array.isArray(was) && Array.isArray(v) && norm([...was].sort()) === norm([...v].sort())) continue;
        if (norm(was) !== norm(v)) ch[k] = v;
      }
      return ch;
    }
    function mark(ch) {
      const seen = new Set();
      for (const [k, box] of Object.entries(boxes)) {
        if (seen.has(box)) continue;
        seen.add(box);
        const keys = Object.entries(boxes).filter(([, b]) => b === box).map(([x]) => x);
        const on = keys.some((x) => x in ch);
        box.classList.toggle('changed', on);
        const tag = box.querySelector(':scope > .changed-tag');
        if (tag) tag.hidden = !on;
      }
    }
    // Shows the part holding an element (for a problem to go back to).
    function reveal(node) {
      const p = node && node.closest && node.closest('.lf-part');
      if (p) show(Number(p.dataset.part));
      let d = node && node.closest && node.closest('details');
      while (d) { d.open = true; d = d.parentElement && d.parentElement.closest('details'); }
    }

    // The first problem, in plain words, with the box to go back to. Character limits only apply to text that has
    // changed: longer text already in the data is kept as it is.
    function check() {
      const p = firstProblem();
      if (p && p.el) reveal(p.el);
      return p;
    }
    function firstProblem() {
      const now = read();
      const q = (k) => boxes[k] && boxes[k].querySelector('input, textarea, select');
      const need = (k, what) => ({ message: what, el: q(k) });
      if (!now.organisation) return need('organisation', 'Please give the name of the organisation.');
      if (!now.name) return need('name', 'Please give the name of the service.');
      if (!now.whoFor) return need('whoFor', "Please say who it's for, in a sentence or two.");
      for (const [k, limit, what] of [['whoFor', L.LIMITS.whoFor, "Who it's for"], ['organisationOverview', L.LIMITS.orgOverview, 'What your organisation does'], ['coachNotes', L.LIMITS.coachNotes, '"Anything coaches should know"']]) {
        if (now[k] && now[k].length > limit && now[k] !== original[k]) return need(k, `${what} is too long: please keep it to ${limit} characters.`);
      }
      if (now.organisationOverview && now.organisationOverview !== original.organisationOverview && /healthy\s+working\s+life|\bhwl\b/i.test(now.organisationOverview)) return need('organisationOverview', "The organisation overview describes the whole organisation, so please don't mention Healthy Working Life there. It is shown on each service that is part of it.");
      if (list(now.partners).includes(now.organisation)) return { message: 'The lead organisation is already given above. Please only list the other organisations as partners.', el: partners.first() };
      if (where.get() === 'parts' && !towns.read().length) return { message: 'Please tick which parts of Kirklees.', el: towns.box.querySelector('input') };
      if (health.get() === 'specific' && !healthTicks.read().length && !healthNote.read()) return { message: 'Please tick which health conditions, or write them in.', el: healthTicks.box.querySelector('input') };
      if (work.get() === 'yes' && !workTicked().length) return { message: 'Please tick at least one work situation.', el: workTicks.querySelector('input') };
      if (!noAge.checked && now.ageMin != null && now.ageMax != null && now.ageMax < now.ageMin) return { message: 'The "up to" age is lower than the "from" age.', el: ageMax };
      if (priority.get() === 'yes' && !groupTicks.read().length) return { message: 'Please tick the priority groups, or choose "No".', el: groupTicks.box.querySelector('input') };
      if (team && !list(now.audience).length) return need('audience', 'Please tick at least one box under "Who uses it?".');
      if (now.webpage && !/^https?:\/\/\S+$/.test(now.webpage)) return need('webpage', "That doesn't look like a web address. Please copy it from your browser's address bar.");
      if (now.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(now.email)) return need('email', "The email address doesn't look right.");
      if (refNeeded.get() === 'yes' && !refWho.get()) return { message: 'Please say who can make a referral.', el: refWho.first() };
      if (refNeeded.get() === 'yes' && refWho.get() === 'professional' && !profs.read()) return { message: 'Please say which professionals can refer.', el: profs.input };
      if (team && !now.referralRoutes.length && referralNeeded() !== 'no') return { message: 'Please give at least one way to make a referral: a link, an email address or a phone number.', el: routes.first() };
      if (team && !now.workExperience) return need('workExperience', 'Please say whether it includes volunteering or work experience (for example "No").');
      const rows = projects.rows();
      const was = new Map(list(original.projects).map((p) => [p.id, p]));
      for (const [i, p] of now.projects.entries()) {
        const fs = rows[i];
        const label = p.name || 'activity ' + (i + 1);
        if (!p.overview) return { message: `Please say what happens in "${label}".`, el: fs._ov };
        const old = was.get(p.id);
        if (p.overview.length > L.LIMITS.projectOverview && !(old && old.overview === p.overview)) return { message: `"What happens" for "${label}" is too long: please keep it to ${L.LIMITS.projectOverview} characters.`, el: fs._ov };
        for (const c of fs._cohortHolder.children) {
          if (fs._cohorts.get() !== 'yes') break;
          if (!c._name.value.trim()) return { message: 'Please give each cohort a name, such as "Cohort 1: ages 18 to 24".', el: c._name };
          const a = ageNumbers(c._age.get());
          if (a && c._open.get() === 'no' && !noAge.checked) {
            if (now.ageMin != null && a.min != null && a.min < now.ageMin) return { message: `"${c._name.value.trim()}" starts at a younger age than the service (${now.ageMin}). A cohort can only narrow who it's for.`, el: c._age.input };
            if (now.ageMax != null && a.max != null && a.max > now.ageMax) return { message: `"${c._name.value.trim()}" goes above the service's age (${now.ageMax}). A cohort can only narrow who it's for.`, el: c._age.input };
          }
        }
      }
      for (const pk of allPickers) {
        if (pk.node.closest('[hidden]')) continue;
        const pr = pk.problem();
        if (pr) return pr;
      }
      const order = L.checkParts(now.projects);
      if (order.length) return { message: order[0].replace(/^(Project|Session) id .*used twice.*$/, 'Two activities or cohorts have the same name. Please make them different.').replace(/stops taking referrals before it starts/, 'stops taking referrals before it starts taking them') + '.', el: boxes.projects.querySelector('input, textarea') };
      if (team) {
        if (!list(now.areas).length) return need('areas', 'Please tick at least one box under "Where it runs".');
        if (!list(now.categories).length) return need('categories', 'Please tick at least one kind of support.');
      }
      return null;
    }

    // What is still unanswered (the new questions, and anything we have nothing for), for "send anyway?".
    function unanswered() {
      const now = read();
      const out = [];
      const add = (label, node) => out.push({ label, el: node, go: () => { reveal(node); node.scrollIntoView({ block: 'center' }); const i = node.querySelector('input, textarea, select'); if (i) i.focus(); } });
      for (const [k, label] of Object.entries(NEW_QUESTIONS)) if (!now[k]) add(label, boxes[k]);
      if (!Array.isArray(now.healthFocus)) add('Health condition or disability', boxes.healthFocus);
      if (!noAge.checked && now.ageMin == null && now.ageMax == null && !String(now.age || '').trim()) add('Age range', ageBox);
      if (!Array.isArray(now.groups) || !now.groups.length) add('Priority groups', boxes.groups);
      for (const [k, label] of [['webpage', 'Website'], ['email', 'Email address'], ['phone', 'Phone number']]) if (!now[k]) add(label, boxes[k]);
      if (!list(now.referralRoutes).length && referralNeeded() !== 'no') add('How to make a referral', boxes.referralRoutes);
      for (const [i, fs] of projects.rows().entries()) {
        const n = projects.rows().length > 1 ? ' (activity ' + (i + 1) + ')' : '';
        if (!fs._runs.querySelector('input:checked')) add('How it runs' + n, fs._runs);
        if (!fs._cohorts.get()) add('Whether it has cohorts' + n, fs._cohorts.box);
      }
      return out;
    }

    // ---------- "Check your answers" before sending ----------
    // One line per question, grouped by part, in the order they appear, each with a "Change" link back to it.
    // only: a list of answer names (the partner page shows just what they changed). Empty answers are left out,
    // unless "only" names them (then they show as "Left empty").
    const lead = (box) => { const l = box.querySelector(':scope > legend, :scope > label, :scope > .lf-lab'); return l ? l.textContent.replace(/\s*\(mandatory\)\s*$/, '').trim() : ''; };
    const RUN_WORDS = L.RUNS;
    function referralText(r) {
      if (!r) return '';
      if (r.needed === 'no') return 'No referral needed';
      if (r.who === 'professional') return 'A referral is needed, from a professional' + (r.professionals ? ' (' + r.professionals + ')' : '');
      return 'A referral is needed, and anyone can make it, including the person themselves';
    }
    function sessionText(x) {
      const v = x.venue && (typeof x.venue === 'object' ? x.venue.name : (venueById.get(x.venue) || {}).name || x.venue);
      const days = list(x.days).map((d) => L.DAY_NAMES[d] || d).join(', ');
      const time = [x.start, x.end].filter(Boolean).join(' to ');
      return [x.name, [v, ...list(x.where)].filter(Boolean).join(', '), days, time, x.note].filter(Boolean).join(' · ');
    }
    function projectText(p, cost) {
      const bits = [String(p.overview || '').replace(/[.\s]+$/, ''), p.duration ? 'How long: ' + p.duration : '', p.cost || cost ? 'Cost: ' + (p.cost || cost) : '',
        list(p.runs).length ? 'Runs: ' + list(p.runs).map((k) => RUN_WORDS[k] || k).join('; ') : '',
        p.area, p.when, p.places ? 'Places: ' + p.places : '', p.age ? 'Age: ' + p.age : '',
        ...list(p.sessions).map(sessionText)].filter(Boolean);
      return [p.name ? '[' + p.name + ']' : '', ...bits].filter(Boolean).join('\n');
    }
    function answerText(keys, now) {
      const k = keys[0];
      if (keys.includes('ageMin')) return noAge.checked ? 'No age limit' : L.ageWords(now);
      if (keys.includes('eligibility') || keys.includes('gate')) {
        const g = list(now.gate);
        return [...g.map((x) => x + ' (essential)'), ...list(now.eligibility).filter((x) => !g.includes(x))].join('\n');
      }
      const v = now[k];
      if (k === 'open') return v === false ? 'Yes: paused for now' : '';
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
      if (k === 'residence') return L.residenceWords(v);
      if (k === 'work') return L.workWords(v);
      if (k === 'referral') return referralText(v);
      if (k === 'categories') return v.map((x, i) => (i === 0 && v.length > 1 ? x + ' (the main one)' : x)).join('\n');
      if (k === 'healthFocus') return v.map((x) => HEALTH[x] || x).join('\n') || 'No';
      if (k === 'groups') return L.groupNames(v).join('\n');
      if (k === 'audience') return v.map((x) => AUDIENCE[x] || x).join('\n');
      if (k === 'selfReferral') return [SELF[v.allowed] || '', v.url || '', v.note || ''].filter(Boolean).join('. ');
      if (k === 'projects') return v.map((p) => projectText(p, now.cost)).join('\n\n');
      if (typeof v === 'boolean') return v ? 'Yes' : 'No';
      if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? Object.values(x).join(', ') : x)).join('\n');
      if (typeof v === 'object') return Object.values(v).filter((x) => typeof x !== 'object').join(', ');
      return String(v);
    }
    function summary(only) {
      const now = read();
      const seen = new Set();
      const rows = [];
      for (const [k, box] of Object.entries(boxes)) {
        if (seen.has(box) || !root.contains(box)) continue;
        seen.add(box);
        const keys = Object.entries(boxes).filter(([, b]) => b === box).map(([x]) => x);
        if (only && !keys.some((x) => only.includes(x))) continue;
        const text = answerText(keys, now);
        if (!text && !only) continue;
        const part = parts.findIndex((p) => p.contains(box));
        rows.push({ part, box, label: k === 'projects' ? (list(now.projects).length > 1 ? 'Activities' : 'Activity') : lead(box) || k, text: text || 'Left empty', go: () => { reveal(box); box.scrollIntoView({ block: 'center' }); const i = box.querySelector('input, textarea, select'); if (i) i.focus({ preventScroll: true }); } });
      }
      rows.sort((a, b) => a.part - b.part || (a.box.compareDocumentPosition(b.box) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      return rows;
    }
    // The panel: every answer, "Change" links, and the page's own send button. back() shows the form again.
    function review({ title, intro, only, sendText, onSend, extra }) {
      const rows = summary(only);
      const panel = el('section', { class: 'lf-review', tabindex: '-1', 'aria-labelledby': uid('rv') });
      const hid = panel.getAttribute('aria-labelledby');
      const back = (row) => { panel.remove(); root.hidden = false; root.dispatchEvent(new CustomEvent('lf-review-closed', { bubbles: true })); if (row) row.go(); };
      const dl = el('dl', { class: 'lf-review-list' });
      let part = -1;
      for (const r of rows) {
        if (r.part !== part) { part = r.part; dl.append(el('div', { class: 'lf-review-part' }, el('h3', { text: 'Part ' + (part + 1) + ': ' + PARTS[part] }))); }
        dl.append(el('div', { class: 'lf-review-row' }, el('dt', { text: r.label }), el('dd', {}, ...r.text.split('\n').flatMap((t, i) => {
          const bit = /^\[.*\]$/.test(t) ? el('strong', { text: t.slice(1, -1) }) : t === '' ? el('span', { class: 'lf-review-gap' }) : t;
          return i ? [el('br'), bit] : [bit];
        })),
          el('dd', { class: 'lf-review-change' }, el('button', { type: 'button', class: 'btn secondary small', text: 'Change', 'aria-label': 'Change: ' + r.label, onclick: () => back(r) }))));
      }
      const sendBtn = el('button', { type: 'button', class: 'btn primary', text: sendText });
      const msg = el('p', { class: 'pc-msg', role: 'alert', hidden: true });
      sendBtn.addEventListener('click', async () => {
        sendBtn.disabled = true;
        msg.hidden = true;
        try { await onSend(); panel.remove(); root.hidden = false; } catch (err) { msg.textContent = err.message; msg.hidden = false; sendBtn.disabled = false; }
      });
      panel.append(el('h2', { id: hid, text: title }), intro ? el('p', { text: intro }) : null,
        rows.length ? dl : el('p', { text: 'You have not filled in any answers yet.' }), ...(extra || []),
        el('div', { class: 'pc-buttons' }, sendBtn, el('button', { type: 'button', class: 'btn secondary', text: 'Go back to the form', onclick: () => back(null) })), msg);
      root.hidden = true;
      root.after(panel);
      panel.focus();
      panel.scrollIntoView({ block: 'start' });
      return panel;
    }

    return { node: root, parts, read, changes, check, mark, show, unanswered, summary, review, boxes, addProject: () => projects.addNew() };
  }

  globalThis.LISTING_FORM = { build, HEALTH, AUDIENCE, SELF, DATE_LABEL, PARTS, ageNumbers };
})();
