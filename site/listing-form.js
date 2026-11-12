// The listing form: every question about a service, in one place, used by
//   - the provider review page (site/provider-check.js), where an organisation checks and corrects its listing, and
//   - All services in Admin (admin/services.js), where the team edits a service or adds a new one.
// Both show the same questions with the same wording, in the same order, so a partner and the team are always
// looking at the same thing. Team-only questions are shown only in "team" mode.
//
// The order follows how an organisation thinks about its work: the organisation, the service, how to get in touch
// and refer, who it's for, then what happens, where and when: each project, how it runs, and its sessions (a time
// and place, or a group such as a cohort). "Who it's for" is asked once, for the service; a project or session only
// records what is different, so nothing is asked twice.
//
// Eligibility is one list: each line can be ticked "Essential" (we'd turn people away without it), which is what the
// data keeps as "gate". So there is no separate "turn away" question.
//
// Venues come from one shared list (data/venues.json): people pick one as they type, or write out a new one (name,
// address, postcode), which becomes a venue when the change is applied.
//
// Needs site/listing-logic.js (character limits, groups, days and date checks). English only, like the team pages.
//
//   const f = LISTING_FORM.build({ values, original, mode, choices, organisations, venues, prefix, headingLevel, onChange });
//   f.node       the form's sections, to put inside your own <form>
//   f.read()     every answer, in the same shape as the data
//   f.changes()  only the answers that differ from "original"
//   f.check()    null, or { message, el } for the first problem (the caller shows it and focuses el)
//   f.mark(ch)   marks the questions in ch as "Changed"
//   f.addProject()  adds an empty project and focuses it
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
  const DATE_LABEL = { runsFrom: 'Runs from', runsTo: 'Runs until', referralsFrom: 'Taking referrals from', referralsUntil: 'Taking referrals until' };
  const DATES_HINT = "Leave blank if it's ongoing. If you give an end date or a date referrals close, it stops showing in the Support Finder automatically after that date. We'll check with you 30 days before.";
  const ESSENTIAL_HINT = 'Tick "Essential" only if you would have to turn someone away without it: the Support Finder won\'t suggest you to people who clearly don\'t meet it.';

  // The questions, in order. [key, label, kind, hint, options]
  // kinds: text, area (with a character limit), lines, checks, yesno, self, projects, bool, select, org, elig, venues
  function sections(mode) {
    const team = mode === 'team';
    const out = [
      ['About your organisation', [
        ['organisation', 'Name of organisation', 'org', 'Start typing to choose from the organisations we already list. If yours isn\'t there, type its full name.', { required: true }],
        ['organisationOverview', 'Organisation overview', 'area', "About two sentences on your organisation's wider work. It is shown with all of your organisation's services, so describe the organisation here, not one project.", { limit: L.LIMITS.orgOverview }],
      ]],
      ['About the service', [
        ['name', 'Name of the service', 'text', '', { required: true }],
        ['whoFor', 'Who your service is for', 'area', 'One or two sentences, in plain words. Coaches see this on the service card.', { required: true, limit: L.LIMITS.whoFor }],
        ['open', 'Are you taking new referrals at the moment?', 'yesno', 'If not, the Support Finder won\'t suggest your service until you are.', {}],
      ]],
      ['Contact details and how people get in', [
        ['webpage', 'Website', 'text', 'The best page for people to find out more, starting https://', { type: 'url' }],
        ['email', 'Email address', 'text', '', { type: 'email' }],
        ['phone', 'Phone number', 'text', '', { type: 'tel' }],
        ['social', 'Social media', 'lines', 'Links, one per line.', {}],
        ['referralRoutes', 'How people are referred or apply', 'lines', 'One way per line: who to contact and how. For example "Referral from a work coach" or "Apply online: https://…". At least one.', { min: 1 }],
        ['selfReferral', 'Can people refer themselves?', 'self', '', {}],
        ['cost', 'Cost', 'text', 'Leave empty if it is free.', {}],
        ['languages', 'Languages and formats', 'text', 'For example "Interpreters available" or "Easy read leaflets". Leave empty if English only.', {}],
        ['workExperience', 'Does it include volunteering or work experience?', 'text', 'For example "No" or "Yes, a six-week placement".', { required: true }],
      ]],
      ["Who it's for", [
        ['groups', 'Who it\'s for: tick the groups it is specifically for', 'checks', 'These let us count what is available, for example "services for young people in Batley". Tick "Everyone (no restriction)" if anyone who meets your criteria can use it.', { choices: 'groups', labels: L.GROUPS }],
        ['age', 'Age', 'text', 'For example 18+ or 16 to 25. Leave empty if there is no age limit. If a project or session has a different age, give it there.', {}],
        ['eligibility', 'Who can use your service', 'elig', 'What someone needs to be or have, one point per line. For example "Lives in Kirklees" (essential) or "Has a health condition". ' + ESSENTIAL_HINT, {}],
        ['exclusions', "Is there anyone you can't support?", 'lines', 'One per line, for example "People with work-search commitments as part of a benefits claim" or "Men (the service is for women)". The Support Finder won\'t suggest your service to them. Leave empty if none.', {}],
        ['healthFocus', 'Do people need a health condition or disability to use your service?', 'checks', 'Leave all unticked if not. Tick "Any health condition or disability" if any will do, or only the specific ones your service is for.', { choices: 'healthFocus', labels: HEALTH }],
        ['audience', 'Who do you work with?', 'checks', 'Tick all that apply.', { choices: 'audience', labels: AUDIENCE, min: 1 }],
      ]],
      ['What happens, where and when', [
        ['projects', 'Projects', 'projects', 'Most services have one project. Add another if you run something different, or the same thing for a different group.', {}],
        ['venues', 'Venues used by every project', 'venues', 'Only if all your projects use the same places. Places for one project go with that project.', {}],
        ['locations', 'Other places, in words', 'lines', 'Places without a postcode, one per line, for example "Online" or "Community venues across Kirklees".', {}],
      ]],
      ['Anything else', [
        ['coachNotes', 'Anything coaches should know', 'area', 'Shown on the service card. For example waiting times, or what to bring.', { limit: L.LIMITS.coachNotes }],
      ]],
    ];
    if (team) {
      out.push(['Team only', [
        ['areas', 'Where it runs', 'checks', 'The towns where it has a base or runs sessions. Tick "Kirklees-wide" if anyone in Kirklees can use it, and "Online" if it can be done online or by phone. This is not where people must live (that goes under "Who can use your service").', { choices: 'areas', min: 1 }],
        ['categories', 'Categories', 'checks', 'How the finder groups services. Most important first: newly ticked ones go last.', { choices: 'categories', min: 1 }],
        ['level', 'Level', 'select', '', { choices: 'level', labels: LEVEL }],
        ['reviewCycle', 'Review cycle', 'select', '', { choices: 'reviewCycle' }],
        ['hwlFunded', 'Healthy Working Life funded (this service only; never the organisation)', 'bool', '', {}],
        ['mapLinks', 'Show map and directions buttons on the card', 'bool', 'Untick for a confidential venue.', { default: true }],
        ['logo', 'Logo file', 'text', 'A file name in site/img/logos/, such as example.webp. Leave empty for none.', {}],
        ['requiresMention', 'Only shown when the person mentions', 'lines', 'Words or patterns, one per line. Leave empty for most services.', {}],
        ['notes', 'Team notes', 'area', 'For the team only. Never shown on the cards or sent to the AI.', {}],
      ]]);
    }
    return out;
  }

  // ---------- one form ----------
  function build(opts) {
    const mode = opts.mode === 'team' ? 'team' : 'partner';
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
    const boxes = {}; // key -> the element holding that question (for "Changed" and focusing)
    const readers = {}; // key -> () => value
    const extra = {}; // key -> () => value, for answers read alongside another question (gate, with eligibility)
    const root = el('div', { class: 'lf' });
    const changed = () => opts.onChange && opts.onChange();
    const venueListId = id('venue-list');
    const venueLabel = (v) => `${v.name} (${L.venueLine(v)})`;
    root.append(el('datalist', { id: venueListId }, venues.map((v) => el('option', { value: venueLabel(v) }))));

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

    function textQuestion(k, label, hint, o, val) {
      const hintId = hint ? id(k) + '-hint' : null;
      const isArea = o.kindArea;
      const input = isArea
        ? el('textarea', { id: id(k), rows: '3', 'aria-describedby': described(hintId, o.limit ? id(k) + '-count' : null) })
        : el('input', { id: id(k), type: o.type || 'text', autocomplete: 'off', 'aria-describedby': described(hintId), required: o.required ? true : null });
      input.value = val == null ? '' : String(val);
      const box = el('div', { class: 'lf-field' + (tbc(val) ? ' tbc' : ''), 'data-key': k },
        el('label', { for: id(k), text: label + (o.required ? ' (mandatory)' : '') }),
        hint ? el('p', { class: 'hint', id: hintId, text: hint }) : null,
        input,
        o.limit ? counter(input, o.limit) : null,
        changedTag());
      return { box, read: () => input.value.trim() };
    }

    function linesQuestion(k, label, hint, val, rows) {
      const hintId = hint ? id(k) + '-hint' : null;
      const input = el('textarea', { id: id(k), rows: String(Math.max(rows || 2, list(val).length + 1)), 'aria-describedby': hintId });
      input.value = list(val).join('\n');
      const box = el('div', { class: 'lf-field' + (tbc(val) ? ' tbc' : ''), 'data-key': k },
        el('label', { for: id(k), text: label }), hint ? el('p', { class: 'hint', id: hintId, text: hint }) : null, input, changedTag());
      return { box, read: () => linesOf(input.value) };
    }

    function checksQuestion(k, label, hint, o, val) {
      const have = new Set(list(val));
      const hintId = hint ? id(k) + '-hint' : null;
      const opts2 = list(choices[o.choices]);
      const box = el('fieldset', { class: 'lf-field lf-checks' + (tbc(val) ? ' tbc' : ''), 'data-key': k, id: id(k), 'aria-describedby': hintId },
        el('legend', { text: label }),
        hint ? el('p', { class: 'hint', id: hintId, text: hint }) : null,
        el('div', { class: 'choices' }, opts2.map((v) => el('label', {}, el('input', { type: 'checkbox', value: v, checked: have.has(v) }), (o.labels && o.labels[v]) || v))),
        changedTag());
      // Keep the order the service already has (categories are most important first); newly ticked ones go last.
      const read = () => {
        const ticked = [...box.querySelectorAll('.choices input:checked')].map((i) => i.value);
        const had = list(val).filter((v) => ticked.includes(v));
        return [...had, ...ticked.filter((v) => !had.includes(v))];
      };
      return { box, read };
    }

    // Eligibility lines, each with an "Essential" tick. Reads back as { eligibility, gate }. A line that was only in
    // "gate" before (essential, not written as eligibility) stays that way unless it is changed or unticked.
    function eligList(lab, hint, elig, gate, compact) {
      const holder = el('div', { class: 'lf-elig-rows' });
      const hintId = hint ? uid('eh') : null;
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
        el('p', { class: 'lf-lab', text: lab }), hint ? el('p', { class: 'hint', id: hintId, text: hint }) : null, holder,
        small({ text: compact ? 'Add a point' : 'Add another point', onclick: () => { row('', false, false)._input.focus(); changed(); } }));
      const read = () => {
        const rows = [...holder.children].map((r) => r._read()).filter((x) => x.text);
        return { eligibility: rows.filter((x) => !x.gateOnly).map((x) => x.text), gate: rows.filter((x) => x.essential).map((x) => x.text) };
      };
      return { box, read };
    }

    function datesGroup(prefix, src, legend) {
      const ins = {};
      const box = el('fieldset', { class: 'lf-dates' }, el('legend', { text: legend }), el('p', { class: 'hint', text: DATES_HINT }),
        el('div', { class: 'lf-grid' }, L.DATE_KEYS.map((k) => {
          const i = el('input', { type: 'date', id: uid(prefix + k) });
          i.value = (src && src[k]) || '';
          ins[k] = i;
          return el('div', { class: 'lf-field' }, el('label', { for: i.id, text: DATE_LABEL[k] }), i);
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
      const hintId = uid('vh');
      const status = el('p', { class: 'hint lf-match', id: hintId });
      const fresh = el('div', { class: 'lf-newvenue', hidden: true },
        el('p', { class: 'hint', text: "A venue we don't list yet. Please give its name, address and full postcode, so it can go on the map and the timetable." }),
        el('div', { class: 'lf-grid' },
          el('div', { class: 'lf-field' }, el('label', { for: nName.id, text: 'Venue name' }), nName),
          el('div', { class: 'lf-field' }, el('label', { for: nAddr.id, text: 'Address' }), nAddr),
          el('div', { class: 'lf-field' }, el('label', { for: nPc.id, text: 'Postcode' }), nPc)));
      const match = () => venues.find((v) => venueLabel(v) === pick.value.trim());
      const upd = () => {
        const v = pick.value.trim();
        const m = match();
        fresh.hidden = !v || Boolean(m);
        if (!fresh.hidden && !nName.value) nName.value = v;
        status.textContent = !v ? '' : m ? (m.ward ? `Venue we know, in ${m.ward} ward.` : 'Venue we know.') : '';
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
          if (!r.name) return { message: 'Please give the new venue a name.', el: nName };
          if (!r.address) return { message: `Please give the address of ${r.name}.`, el: nAddr };
          if (!POSTCODE_RE.test(r.postcode)) return { message: `Please give the full postcode of ${r.name}, such as WF17 5DR.`, el: nPc };
          return null;
        },
      };
    }

    // ----- projects and their sessions -----
    const allPickers = [];
    function projectsQuestion(label, hint, val) {
      const wrap = el('div', { class: 'lf-projects' });
      const box = el('div', { class: 'lf-field lf-projects-box', 'data-key': 'projects' },
        el('p', { class: 'hint', text: hint }), wrap,
        small({ text: 'Add another project', onclick: () => addNew() }),
        changedTag());

      function smallText(lab, v, hintText, type) {
        const i = el('input', { type: type || 'text', id: uid('p') });
        i.value = v || '';
        return { node: el('div', { class: 'lf-field' }, el('label', { for: i.id, text: lab }), hintText ? el('p', { class: 'hint', text: hintText }) : null, i), get: () => i.value.trim(), input: i };
      }
      function smallLines(lab, v, hintText) {
        const i = el('textarea', { id: uid('p'), rows: String(Math.max(2, list(v).length + 1)) });
        i.value = list(v).join('\n');
        return { node: el('div', { class: 'lf-field' }, el('label', { for: i.id, text: lab }), hintText ? el('p', { class: 'hint', text: hintText }) : null, i), get: () => linesOf(i.value) };
      }

      // A session: a time and place, or a group of its own (such as a cohort), or both.
      function addSession(holder, s = {}) {
        const picker = venuePicker('Venue', s.venue);
        allPickers.push(picker);
        const dayBoxes = L.DAYS.map((d) => el('label', {}, el('input', { type: 'checkbox', value: d, checked: list(s.days).includes(d) }), ' ' + L.DAY_NAMES[d].slice(0, 3)));
        const start = el('input', { type: 'time', id: uid('st'), step: '300' });
        start.value = s.start || '';
        const end = el('input', { type: 'time', id: uid('en'), step: '300' });
        end.value = s.end || '';
        const freq = el('select', { id: uid('fr') }, el('option', { value: '', text: 'Choose' }), Object.entries(L.FREQUENCY).map(([k, w]) => el('option', { value: k, text: w[0].toUpperCase() + w.slice(1) })));
        freq.value = s.frequency || '';
        const f = {
          name: smallText('Name, if it has one', s.name, 'For example "elevate connect (drop-in)" or "Cohort 1: ages 18 to 24".'),
          note: smallText('Anything else about when or where, in words', s.note, 'For example "first Tuesday of the month" or "term time only".'),
          places: smallText('Number of places', s.places, 'Leave empty if not limited.'),
          age: smallText('Age, if this session is for a different age group', s.age, 'For example 50+.'),
          where: smallLines('Other places, in words', s.where, 'Only for places without a postcode, such as "Online".'),
        };
        const elig = eligList('Extra criteria for this session', 'Only what is different from the project, for example "Aged 18 to 24". ' + ESSENTIAL_HINT, s.eligibility, s.gate, true);
        const dates = datesGroup('s', s, 'Dates for this session, if different from the project');
        const more = el('details', { class: 'lf-more' }, el('summary', { text: 'Age group, extra criteria, places or dates for this session' }),
          el('div', { class: 'lf-grid' }, f.age.node, f.places.node), elig.box, dates.box, f.where.node);
        if (s.age || list(s.eligibility).length || list(s.gate).length || s.places || L.DATE_KEYS.some((k) => s[k]) || list(s.where).length) more.open = true;
        const fs = el('fieldset', { class: 'lf-session', 'data-id': s.id || '' }, el('legend', { text: 'Session' }),
          f.name.node, picker.node,
          el('fieldset', { class: 'lf-days' }, el('legend', { text: 'Days' }), el('div', { class: 'choices' }, dayBoxes)),
          el('div', { class: 'lf-grid' },
            el('div', { class: 'lf-field' }, el('label', { for: start.id, text: 'From' }), start),
            el('div', { class: 'lf-field' }, el('label', { for: end.id, text: 'Until' }), end),
            el('div', { class: 'lf-field' }, el('label', { for: freq.id, text: 'How often' }), freq)),
          f.note.node, more,
          small({ text: 'Remove this session', onclick: () => { fs.remove(); allPickers.splice(allPickers.indexOf(picker), 1); changed(); } }));
        fs._read = () => {
          const out = { id: fs.dataset.id };
          const name = f.name.get();
          if (name) out.name = name;
          const v = picker.read();
          if (v) out.venue = v;
          const where = f.where.get();
          if (where.length) out.where = where;
          const days = dayBoxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
          if (days.length) out.days = days;
          if (start.value) out.start = start.value;
          if (end.value) out.end = end.value;
          if (freq.value) out.frequency = freq.value;
          for (const k of ['note', 'age', 'places']) { const x = f[k].get(); if (x) out[k] = x; }
          // "when" in words from before November 2026 is kept until the session has days and times.
          if (s.when && !days.length) out.when = s.when;
          const e = elig.read();
          if (e.eligibility.length) out.eligibility = e.eligibility;
          if (e.gate.length) out.gate = e.gate;
          Object.assign(out, dates.read());
          return out;
        };
        fs._first = f.name.input;
        holder.append(fs);
        return fs;
      }

      function addProject(p = {}) {
        const f = {
          name: smallText('Project name (mandatory)', p.name, ''),
          when: smallText('Days and times, in words', p.when, 'Only if it doesn\'t fit the sessions below, for example "Flexible, arranged with you".'),
          duration: smallText('How long it lasts', p.duration, 'For example "12 weeks" or "Ongoing".'),
          places: smallText('Number of places', p.places, 'For example "20 places". Leave empty if not limited.'),
          age: smallText('Age, if different from the service', p.age, ''),
          area: smallText('The area it covers', p.area, 'For example "All of Kirklees", or the towns.'),
          where: smallLines('Other places, in words', p.where, 'Places without a postcode, for example "Online" or "Community venues across Kirklees".'),
        };
        const ovId = uid('ov');
        const ov = el('textarea', { id: ovId, rows: '3', 'aria-describedby': ovId + '-count' });
        ov.value = p.overview || '';
        const ovBox = el('div', { class: 'lf-field' }, el('label', { for: ovId, text: 'What happens (mandatory)' }),
          el('p', { class: 'hint', text: 'What happens in this project, in a few sentences.' }), ov, counter(ov, L.LIMITS.projectOverview));
        // How it runs. Ticking "set times and places" shows the sessions; "by appointment" asks for the area.
        const runs = new Set(list(p.runs));
        if (!runs.size && list(p.sessions).some((x) => x.venue || list(x.days).length)) runs.add('set');
        const runBoxes = Object.entries(L.RUNS).map(([k, w]) => el('label', {}, el('input', { type: 'checkbox', value: k, checked: runs.has(k) }), ' ' + w));
        const runSet = el('fieldset', { class: 'lf-field lf-checks lf-runs' }, el('legend', { text: 'How does it run?' }), el('p', { class: 'hint', text: 'Tick all that apply.' }), el('div', { class: 'choices' }, runBoxes));
        const aud = new Set(list(p.audience));
        const audBox = el('fieldset', { class: 'lf-field lf-checks' }, el('legend', { text: 'Who this project works with, if different from the service' }),
          el('p', { class: 'hint', text: 'Leave all unticked if it is the same as the service.' }),
          el('div', { class: 'choices' }, list(choices.audience).map((v) => el('label', {}, el('input', { type: 'checkbox', value: v, checked: aud.has(v) }), AUDIENCE[v] || v))));
        const elig = eligList('Extra criteria for this project', 'Only criteria that are different from the service. ' + ESSENTIAL_HINT, p.eligibility, p.gate, true);
        const dates = datesGroup('p', p, 'Dates');
        const sessions = el('div', { class: 'lf-sessions' });
        const sessionsBox = el('div', { class: 'lf-sessions-box' },
          el(SUBH, { class: 'lf-sub', text: 'Times and places' }),
          el('p', { class: 'hint', text: 'Add a session for each venue and day it runs. If the same project runs for different groups, such as two cohorts for different age groups, add a session for each group and give it its age under "Age group, extra criteria…".' }),
          sessions, small({ text: 'Add a session', onclick: () => { addSession(sessions)._first.focus(); changed(); } }));
        const areaBox = f.area.node;
        const fs = el('fieldset', { class: 'lf-proj' + (tbc(p) ? ' tbc' : ''), 'data-id': p.id || '' },
          el('legend', { class: 'lf-proj-legend' }),
          f.name.node, ovBox, runSet, sessionsBox, areaBox, f.where.node, f.when.node,
          f.duration.node, el('div', { class: 'lf-grid' }, f.places.node, f.age.node),
          elig.box, audBox, dates.box,
          el('div', { class: 'lf-row' },
            small({ text: 'Remove this project', onclick: () => {
              if (wrap.children.length < 2) return alert('A service needs at least one project. Change this one instead.');
              fs.remove(); renumber(); changed();
            } })));
        const showRuns = () => {
          const ticked = new Set(runBoxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value));
          sessionsBox.hidden = !ticked.has('set') && !sessions.children.length;
          areaBox.hidden = !ticked.has('appointment') && !f.area.get();
        };
        runSet.addEventListener('change', () => {
          showRuns();
          const setOn = runBoxes[0].querySelector('input').checked;
          if (setOn && !sessions.children.length) addSession(sessions);
        });
        for (const s of list(p.sessions)) addSession(sessions, s);
        showRuns();
        fs._read = () => {
          const out = { id: fs.dataset.id, name: f.name.get(), overview: ov.value.trim() };
          const r = runBoxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
          if (r.length) out.runs = r;
          for (const k of ['area', 'when', 'duration', 'places', 'age']) { const v = f[k].get(); if (v) out[k] = v; }
          const where = f.where.get();
          if (where.length) out.where = where;
          const a = [...audBox.querySelectorAll('input:checked')].map((i) => i.value);
          if (a.length) out.audience = a;
          const e = elig.read();
          if (e.eligibility.length) out.eligibility = e.eligibility;
          if (e.gate.length) out.gate = e.gate;
          Object.assign(out, dates.read());
          const ss = [...sessions.children].map((c) => c._read()).filter((x) => Object.keys(x).length > 1);
          if (ss.length) out.sessions = ss;
          return out;
        };
        fs._name = f.name.input;
        fs._ov = ov;
        fs._sessions = sessions;
        fs._name.addEventListener('input', renumber);
        wrap.append(fs);
        return fs;
      }
      function renumber() {
        [...wrap.children].forEach((fs, i) => { fs.querySelector('.lf-proj-legend').textContent = 'Project ' + (i + 1) + (fs._name.value.trim() ? ': ' + fs._name.value.trim() : ''); });
      }
      function addNew() {
        const fs = addProject();
        renumber();
        fs._name.focus();
        changed();
        return fs;
      }
      for (const p of list(val)) addProject(p);
      if (!wrap.children.length) addProject();
      renumber();

      // New projects and sessions get an id made from their name (or venue and day), unique in the service. Existing
      // ones keep theirs.
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
          if (!p.id) p.id = fresh(p.name, 'project');
          for (const c of list(p.sessions)) {
            if (c.id) continue;
            const v = typeof c.venue === 'string' ? venueById.get(c.venue) : c.venue;
            c.id = fresh(c.name || [v && v.name, ...list(c.days)].filter(Boolean).join(' '), 'session');
          }
        }
        return ps;
      };
      return { box, read, rows: () => [...wrap.children], addNew };
    }

    // ----- venues used by every project -----
    function venuesQuestion(k, label, hint, val) {
      const holder = el('div', { class: 'lf-venue-rows' });
      const pickers = [];
      const add = (v) => {
        const p = venuePicker('Venue', v);
        pickers.push(p);
        allPickers.push(p);
        const r = el('div', { class: 'lf-venue-row' }, p.node, small({ text: 'Remove', 'aria-label': 'Remove this venue', onclick: () => { r.remove(); pickers.splice(pickers.indexOf(p), 1); allPickers.splice(allPickers.indexOf(p), 1); changed(); } }));
        holder.append(r);
        return p;
      };
      for (const v of list(val)) add(v);
      const box = el('div', { class: 'lf-field', 'data-key': k }, el('p', { class: 'lf-lab', text: label }), el('p', { class: 'hint', text: hint }), holder,
        small({ text: 'Add a venue', onclick: () => { add(null).input.focus(); changed(); } }), changedTag());
      return { box, read: () => pickers.map((p) => p.read()).filter(Boolean) };
    }

    // ----- the organisation, with type-ahead from the organisations already listed -----
    function orgQuestion(k, label, hint, val) {
      const listId = id('orgs');
      const input = el('input', { id: id(k), type: 'text', list: listId, autocomplete: 'off', 'aria-describedby': id(k) + '-hint ' + id(k) + '-match' });
      input.value = val || '';
      const names = list(opts.organisations);
      const match = el('p', { class: 'hint lf-match', id: id(k) + '-match' });
      const upd = () => {
        const v = input.value.trim();
        match.textContent = !v ? '' : names.includes(v) ? 'This is an organisation we already list.' : 'This will be added as a new organisation.';
      };
      input.addEventListener('input', upd);
      upd();
      const box = el('div', { class: 'lf-field', 'data-key': k },
        el('label', { for: id(k), text: label + ' (mandatory)' }), el('p', { class: 'hint', id: id(k) + '-hint', text: hint }), input,
        el('datalist', { id: listId }, names.map((n) => el('option', { value: n }))), match, changedTag());
      return { box, read: () => input.value.trim() };
    }

    let projects = null;
    for (const [title, fields] of sections(mode)) {
      const sec = el('section', { class: 'lf-section' }, el(H, { text: title }));
      for (const [k, label, kind, hint, o] of fields) {
        const v = values[k];
        let q;
        if (kind === 'text') q = textQuestion(k, label, hint, o, v);
        else if (kind === 'area') q = textQuestion(k, label, hint, { ...o, kindArea: true }, v);
        else if (kind === 'org') q = orgQuestion(k, label, hint, v);
        else if (kind === 'lines') q = linesQuestion(k, label, hint, v);
        else if (kind === 'checks') q = checksQuestion(k, label, hint, o, v);
        else if (kind === 'venues') q = venuesQuestion(k, label, hint, v);
        else if (kind === 'elig') {
          const e = eligList(label, hint, values.eligibility, values.gate, false);
          e.box.dataset.key = 'eligibility';
          e.box.append(changedTag());
          q = { box: e.box, read: () => e.read().eligibility };
          extra.gate = () => e.read().gate;
          boxes.gate = e.box;
        } else if (kind === 'yesno') {
          const sel = el('select', { id: id(k), 'aria-describedby': hint ? id(k) + '-hint' : null }, el('option', { value: 'yes', text: 'Yes' }), el('option', { value: 'no', text: 'No, not at the moment' }));
          sel.value = v === false ? 'no' : 'yes';
          q = { box: el('div', { class: 'lf-field', 'data-key': k }, el('label', { for: id(k), text: label }), hint ? el('p', { class: 'hint', id: id(k) + '-hint', text: hint }) : null, sel, changedTag()), read: () => sel.value === 'yes' };
        } else if (kind === 'select') {
          const sel = el('select', { id: id(k) }, list(choices[o.choices]).map((c) => el('option', { value: c, text: (o.labels && o.labels[c]) || c })));
          sel.value = v || list(choices[o.choices])[0] || '';
          q = { box: el('div', { class: 'lf-field', 'data-key': k }, el('label', { for: id(k), text: label }), sel, changedTag()), read: () => sel.value };
        } else if (kind === 'bool') {
          const cb = el('input', { type: 'checkbox', id: id(k), checked: v === undefined ? Boolean(o.default) : v === true });
          q = { box: el('div', { class: 'lf-field lf-bool', 'data-key': k }, el('label', { for: id(k) }, cb, ' ' + label), hint ? el('p', { class: 'hint', text: hint }) : null, changedTag()), read: () => cb.checked };
        } else if (kind === 'self') {
          const sr = v || { allowed: 'tbc', note: '' };
          const sel = el('select', { id: id('sr-allowed') }, list(choices.selfReferral).map((c) => el('option', { value: c, text: SELF[c] || c })));
          sel.value = sr.allowed;
          const note = el('input', { id: id('sr-note'), type: 'text', 'aria-describedby': id('sr-note') + '-hint' });
          note.value = sr.note || '';
          const url = el('input', { id: id('sr-url'), type: 'url' });
          url.value = sr.url || '';
          q = {
            box: el('fieldset', { class: 'lf-field lf-checks' + (tbc(sr) ? ' tbc' : ''), 'data-key': 'selfReferral' }, el('legend', { text: label }),
              el('div', { class: 'lf-field' }, el('label', { for: sel.id, text: 'Can they?' }), sel),
              el('div', { class: 'lf-field' }, el('label', { for: note.id, text: 'A few words about it (mandatory)' }), el('p', { class: 'hint', id: id('sr-note') + '-hint', text: 'For example "Fill in the form on our website" or "Through a work coach only".' }), note),
              el('div', { class: 'lf-field' }, el('label', { for: url.id, text: 'Referral or application form link (if there is one)' }), url),
              changedTag()),
            read: () => { const o2 = { allowed: sel.value, note: note.value.trim() }; if (url.value.trim()) o2.url = url.value.trim(); return o2; },
          };
        } else if (kind === 'projects') {
          q = projects = projectsQuestion(label, hint, v);
        }
        boxes[k] = q.box;
        readers[k] = q.read;
        sec.append(q.box);
      }
      root.append(sec);
    }
    if (opts.onChange) { root.addEventListener('input', opts.onChange); root.addEventListener('change', opts.onChange); }

    // Every answer, in the same shape as the data. Empty optional details are null.
    const NULLABLE = ['age', 'phone', 'webpage', 'email', 'cost', 'languages', 'coachNotes', 'notes', 'organisationOverview', 'logo'];
    function read() {
      const out = {};
      for (const [k, r] of Object.entries(readers)) out[k] = r();
      for (const [k, r] of Object.entries(extra)) out[k] = r();
      for (const k of NULLABLE) if (k in out && !out[k]) out[k] = null;
      if ('requiresMention' in out && !out.requiresMention.length) out.requiresMention = null;
      if ('venues' in out && !out.venues.length) out.venues = null;
      return out;
    }
    function changes() {
      const now = read();
      const ch = {};
      for (const [k, v] of Object.entries(now)) {
        const was = original[k] === undefined && k === 'mapLinks' ? true : original[k];
        if (norm(was) !== norm(v)) ch[k] = v;
      }
      return ch;
    }
    function mark(ch) {
      for (const [k, box] of Object.entries(boxes)) {
        const on = k in ch || (k === 'eligibility' && 'gate' in ch);
        box.classList.toggle('changed', on);
        const tag = box.querySelector(':scope > .changed-tag');
        if (tag) tag.hidden = !on;
      }
    }

    // The first problem, in plain words, with the box to go back to. Character limits only apply to text that has
    // changed: longer text already in the data is kept as it is.
    function check() {
      const now = read();
      const q = (k) => boxes[k] && boxes[k].querySelector('input, textarea, select');
      const need = (k, what) => ({ message: what, el: q(k) });
      if (!now.organisation) return need('organisation', 'Please give the name of the organisation.');
      if (!now.name) return need('name', 'Please give the name of the service.');
      if (!now.whoFor) return need('whoFor', 'Please say who your service is for.');
      if (!now.workExperience) return need('workExperience', 'Please say whether it includes volunteering or work experience (for example "No").');
      if (now.webpage && !/^https?:\/\/\S+$/.test(now.webpage)) return need('webpage', "The website needs to start with https:// (copy it from your browser's address bar).");
      if (now.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(now.email)) return need('email', "The email address doesn't look right.");
      for (const [k, limit, what] of [['whoFor', L.LIMITS.whoFor, 'Who your service is for'], ['organisationOverview', L.LIMITS.orgOverview, 'The organisation overview'], ['coachNotes', L.LIMITS.coachNotes, '"Anything coaches should know"']]) {
        if (now[k] && now[k].length > limit && now[k] !== original[k]) return need(k, `${what} is too long: please keep it to ${limit} characters.`);
      }
      if (now.organisationOverview && now.organisationOverview !== original.organisationOverview && /healthy\s+working\s+life|\bhwl\b/i.test(now.organisationOverview)) return need('organisationOverview', "The organisation overview describes the whole organisation, so please don't mention Healthy Working Life there. It is shown on each service that is part of it.");
      if (!now.referralRoutes.length) return need('referralRoutes', 'Please give at least one way people are referred or apply.');
      if (!now.selfReferral.note) return { message: 'Please say a few words about whether people can refer themselves.', el: boxes.selfReferral.querySelector('input[type=text]') };
      if (!now.audience.length) return need('audience', 'Please tick at least one box under "Who do you work with?".');
      const rows = projects.rows();
      const was = new Map(list(original.projects).map((p) => [p.id, p]));
      for (const [i, p] of now.projects.entries()) {
        if (!p.name) return { message: `Please give project ${i + 1} a name.`, el: rows[i]._name };
        if (!p.overview) return { message: `Please say what happens in "${p.name}".`, el: rows[i]._ov };
        const old = was.get(p.id);
        if (p.overview.length > L.LIMITS.projectOverview && !(old && old.overview === p.overview)) return { message: `"What happens" for "${p.name}" is too long: please keep it to ${L.LIMITS.projectOverview} characters.`, el: rows[i]._ov };
      }
      for (const pk of allPickers) {
        const pr = pk.problem();
        if (pr) return pr;
      }
      const order = L.checkParts(now.projects);
      if (order.length) return { message: order[0].replace(/^(Project|Session) id .*used twice.*$/, 'Two projects or sessions have the same name. Please make them different.') + '.', el: boxes.projects };
      if (mode === 'team') {
        if (!now.areas.length) return need('areas', 'Please tick at least one box under "Where it runs".');
        if (!now.categories.length) return need('categories', 'Please tick at least one category.');
      }
      return null;
    }

    return { node: root, read, changes, check, mark, boxes, addProject: () => projects.addNew() };
  }

  globalThis.LISTING_FORM = { build, sections, HEALTH, AUDIENCE, SELF, DATE_LABEL };
})();
