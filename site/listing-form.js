// The listing form: every question about a service, in one place, used by
//   - the provider review page (site/provider-check.js), where an organisation checks and corrects its listing, and
//   - All services in Admin (admin/services.js), where the team edits a service or adds a new one.
// Both show the same questions with the same wording, in the same order, so a partner and the team are always
// looking at the same thing. Team-only questions are shown only in "team" mode.
//
// The order follows how an organisation thinks about its work: the organisation, the service, its projects (each
// with their own where, when and dates, and cohorts if the same project runs more than once), who it's for, how
// people get in, and practical details. "Who it's for" is asked once, for the service; a project or cohort only
// records what is different, so nothing is asked twice.
//
// Needs site/listing-logic.js (character limits and date checks). English only, like the other team pages.
//
//   const f = LISTING_FORM.build({ values, original, mode, choices, organisations, prefix, headingLevel, isNew, onChange });
//   f.node       the form's sections, to put inside your own <form>
//   f.read()     every answer, in the same shape as the data
//   f.changes()  only the answers that differ from "original"
//   f.check()    null, or { message, el } for the first problem (the caller shows it and focuses el)
//   f.mark(ch)   marks the questions in ch as "Changed"
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
  const POSTCODE_HINT = 'One place per line. Include the full postcode: the map link only shows when there is one.';

  // The questions, in order. [key, label, kind, hint, options]
  // kinds: text, area (with a character limit), lines (one per line), checks, yesno, self, projects, bool, select, org
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
        ['webpage', 'Website', 'text', 'The best page for people to find out more, starting https://', { type: 'url' }],
        ['phone', 'Phone number', 'text', '', { type: 'tel' }],
        ['email', 'Email address', 'text', '', { type: 'email' }],
        ['social', 'Social media', 'lines', 'Links, one per line.', {}],
      ]],
      ['Projects', [
        ['projects', 'Projects', 'projects', 'A project is something different that happens, or a different group it is for. If the same project runs more than once, at different times, places or for different age groups, add each run as a cohort or session under it. Most services have one project.', {}],
        ['locations', 'Places used by every project', 'lines', 'Only if all your projects use the same places. ' + POSTCODE_HINT, {}],
      ]],
      ["Who it's for", [
        ['age', 'Age', 'text', 'For example 18+ or 16 to 25. Leave empty if there is no age limit. If a project or cohort has a different age, give it there.', {}],
        ['eligibility', 'Who can use your service', 'lines', 'What someone needs to be or have, one point per line. For example "Lives in Kirklees" or "Has a health condition or disability". If a project has extra criteria, add them to that project.', {}],
        ['gate', 'Is there anything you would turn someone away for not having?', 'lines', 'Only things that rule people out, one per line, for example "Lives in Kirklees" or "Is a Kirklees College student". The Support Finder won\'t suggest your service to people who clearly don\'t have these. Leave empty if you\'d consider anyone who fits the description above.', {}],
        ['exclusions', "Is there anyone you can't support?", 'lines', 'For example "People in full-time work". The Support Finder won\'t suggest your service to them. Leave empty if none.', {}],
        ['healthFocus', 'Do people need a health condition or disability to use your service?', 'checks', 'Leave all unticked if not. Tick "Any health condition or disability" if any will do, or only the specific ones your service is for.', { choices: 'healthFocus', labels: HEALTH }],
        ['audience', 'Who do you work with?', 'checks', 'Tick all that apply.', { choices: 'audience', labels: AUDIENCE, min: 1 }],
      ]],
      ['How people get in', [
        ['referralRoutes', 'How people are referred or apply', 'lines', 'One way per line, for example "Referral from a work coach" or "Apply online: https://…". At least one.', { min: 1 }],
        ['selfReferral', 'Can people refer themselves?', 'self', '', {}],
      ]],
      ['Practical details', [
        ['cost', 'Cost', 'text', 'Leave empty if it is free.', {}],
        ['languages', 'Languages and formats', 'text', 'For example "Interpreters available" or "Easy read leaflets". Leave empty if English only.', {}],
        ['workExperience', 'Does it include volunteering or work experience?', 'text', 'For example "No" or "Yes, a six-week placement".', { required: true }],
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
    const P = opts.prefix || 'lf';
    const H = 'h' + (opts.headingLevel || 2);
    const id = (k) => P + '-' + k;
    let seq = 0;
    const uid = (k) => P + '-' + k + '-' + ++seq;
    const boxes = {}; // key -> the element holding that question (for "Changed" and focusing)
    const readers = {}; // key -> () => value
    const root = el('div', { class: 'lf' });

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

    function checksQuestion(k, label, hint, o, val, keyForChoices) {
      const have = new Set(list(val));
      const hintId = hint ? id(k) + '-hint' : null;
      const opts2 = list(choices[keyForChoices || o.choices]);
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

    // ----- projects and their cohorts -----
    function projectsQuestion(label, hint, val) {
      const wrap = el('div', { class: 'lf-projects' });
      const box = el('div', { class: 'lf-field lf-projects-box', 'data-key': 'projects' },
        el('p', { class: 'hint', text: hint }), wrap,
        el('button', { type: 'button', class: 'btn secondary small', text: 'Add another project', onclick: () => { addProject(); renumber(); wrap.lastChild.querySelector('input').focus(); opts.onChange && opts.onChange(); } }),
        changedTag());
      const rows = [];

      function smallText(lab, v, hintText, type) {
        const i = el('input', { type: type || 'text', id: uid('p') });
        i.value = v || '';
        return { node: el('div', { class: 'lf-field' }, el('label', { for: i.id, text: lab }), hintText ? el('p', { class: 'hint', text: hintText }) : null, i), get: () => i.value.trim() };
      }
      function smallLines(lab, v, hintText) {
        const i = el('textarea', { id: uid('p'), rows: String(Math.max(2, list(v).length + 1)) });
        i.value = list(v).join('\n');
        return { node: el('div', { class: 'lf-field' }, el('label', { for: i.id, text: lab }), hintText ? el('p', { class: 'hint', text: hintText }) : null, i), get: () => linesOf(i.value) };
      }

      function addCohort(holder, c = {}) {
        const f = {
          name: smallText('Name of the cohort or session (mandatory)', c.name, 'For example "Cohort 1: ages 18 to 24" or "Tuesdays in Batley".'),
          where: smallLines('Where', c.where, 'Only if different from the project. ' + POSTCODE_HINT),
          when: smallText('Days and times', c.when, 'Only if different from the project.'),
          places: smallText('Number of places', c.places, 'For example "10 places". Leave empty if not limited.'),
          age: smallText('Age', c.age, 'Only if different from the project, for example 50+.'),
          eligibility: smallLines('Extra criteria for this cohort or session', c.eligibility, 'Only what is different, one per line. Leave empty if none.'),
          gate: smallLines('Anything else you would turn someone away for not having', c.gate, 'Only for this cohort or session. Leave empty if none.'),
        };
        const dates = datesGroup('c', c, 'Dates for this cohort or session (if different)');
        const fs = el('fieldset', { class: 'lf-cohort', 'data-id': c.id || '' }, el('legend', { text: 'Cohort or session' }),
          f.name.node, el('div', { class: 'lf-grid' }, f.when.node, f.places.node, f.age.node), f.where.node, dates.box, f.eligibility.node, f.gate.node,
          el('button', { type: 'button', class: 'btn secondary small', text: 'Remove this cohort or session', onclick: () => { fs.remove(); opts.onChange && opts.onChange(); } }));
        fs._read = () => {
          const out = { id: fs.dataset.id, name: f.name.get() };
          for (const k of ['where', 'eligibility', 'gate']) { const v = f[k].get(); if (v.length) out[k] = v; }
          for (const k of ['when', 'places', 'age']) { const v = f[k].get(); if (v) out[k] = v; }
          Object.assign(out, dates.read());
          return out;
        };
        fs._name = f.name.node.querySelector('input');
        holder.append(fs);
        return fs;
      }

      function addProject(p = {}) {
        const f = {
          name: smallText('Project name (mandatory)', p.name, ''),
          when: smallText('Days and times', p.when, 'For example "Tuesdays 10am to 12pm".'),
          duration: smallText('How long it lasts', p.duration, 'For example "12 weeks" or "Ongoing".'),
          places: smallText('Number of places', p.places, 'For example "20 places". Leave empty if not limited.'),
          age: smallText('Age, if different from the service', p.age, ''),
          where: smallLines('Where it runs', p.where, POSTCODE_HINT),
          eligibility: smallLines('Extra criteria for this project', p.eligibility, 'Only criteria that are different from the service, one per line. Leave empty if none.'),
          gate: smallLines('Anything else you would turn someone away for not having', p.gate, 'Only for this project. Leave empty if none.'),
        };
        const ovId = uid('ov');
        const ov = el('textarea', { id: ovId, rows: '3', 'aria-describedby': ovId + '-count' });
        ov.value = p.overview || '';
        const ovBox = el('div', { class: 'lf-field' }, el('label', { for: ovId, text: 'Project overview (mandatory)' }),
          el('p', { class: 'hint', text: 'What happens in this project, in a few sentences.' }), ov, counter(ov, L.LIMITS.projectOverview));
        const aud = new Set(list(p.audience));
        const audBox = el('fieldset', { class: 'lf-field lf-checks' }, el('legend', { text: 'Who this project works with, if different from the service' }),
          el('p', { class: 'hint', text: 'Leave all unticked if it is the same as the service.' }),
          el('div', { class: 'choices' }, list(choices.audience).map((v) => el('label', {}, el('input', { type: 'checkbox', value: v, checked: aud.has(v) }), AUDIENCE[v] || v))));
        const dates = datesGroup('p', p, 'Dates');
        const cohorts = el('div', { class: 'lf-cohorts' });
        const fs = el('fieldset', { class: 'lf-proj' + (tbc(p) ? ' tbc' : ''), 'data-id': p.id || '' },
          el('legend', { class: 'lf-proj-legend' }),
          f.name.node, ovBox,
          f.duration.node,
          el('div', { class: 'lf-grid' }, f.when.node, f.places.node, f.age.node),
          f.where.node, dates.box, f.eligibility.node, f.gate.node, audBox,
          el('h' + Math.min(6, (opts.headingLevel || 2) + 1), { class: 'lf-sub', text: 'Cohorts or sessions' }),
          el('p', { class: 'hint', text: 'Only if this project runs more than once at different times, places or for different groups, such as two cohorts for different age groups. Each one only needs what is different.' }),
          cohorts,
          el('div', { class: 'lf-row' },
            el('button', { type: 'button', class: 'btn secondary small', text: 'Add a cohort or session', onclick: () => { addCohort(cohorts)._name.focus(); opts.onChange && opts.onChange(); } }),
            el('button', { type: 'button', class: 'btn secondary small', text: 'Remove this project', onclick: () => {
              if (wrap.children.length < 2) return alert('A service needs at least one project. Change this one instead.');
              fs.remove(); rows.splice(rows.indexOf(fs), 1); renumber(); opts.onChange && opts.onChange();
            } })));
        for (const c of list(p.cohorts)) addCohort(cohorts, c);
        fs._read = () => {
          const out = { id: fs.dataset.id, name: f.name.get(), overview: ov.value.trim() };
          for (const k of ['where', 'eligibility', 'gate']) { const v = f[k].get(); if (v.length) out[k] = v; }
          for (const k of ['when', 'duration', 'places', 'age']) { const v = f[k].get(); if (v) out[k] = v; }
          const a = [...audBox.querySelectorAll('input:checked')].map((i) => i.value);
          if (a.length) out.audience = a;
          Object.assign(out, dates.read());
          const cs = [...cohorts.children].map((c) => c._read());
          if (cs.length) out.cohorts = cs;
          return out;
        };
        fs._name = f.name.node.querySelector('input');
        fs._ov = ov;
        fs._name.addEventListener('input', renumber);
        wrap.append(fs);
        rows.push(fs);
        return fs;
      }
      function renumber() {
        [...wrap.children].forEach((fs, i) => { fs.querySelector('.lf-proj-legend').textContent = 'Project ' + (i + 1) + (fs._name.value.trim() ? ': ' + fs._name.value.trim() : ''); });
      }
      for (const p of list(val)) addProject(p);
      if (!wrap.children.length) addProject();
      renumber();

      // New projects and cohorts get an id made from their name, unique in the service. Existing ones keep theirs.
      const read = () => {
        const ps = [...wrap.children].map((fs) => fs._read());
        const used = new Set();
        for (const p of ps) { if (p.id) used.add(p.id); for (const c of list(p.cohorts)) if (c.id) used.add(c.id); }
        const fresh = (name, fallback) => {
          let base = slug(name) || fallback;
          let x = base;
          for (let n = 2; used.has(x); n++) x = base.slice(0, 46) + '-' + n;
          used.add(x);
          return x;
        };
        for (const p of ps) {
          if (!p.id) p.id = fresh(p.name, 'project');
          for (const c of list(p.cohorts)) if (!c.id) c.id = fresh(c.name, 'cohort');
        }
        return ps;
      };
      return { box, read, rows: () => [...wrap.children] };
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
        else if (kind === 'yesno') {
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
              el('div', { class: 'lf-field' }, el('label', { for: url.id, text: 'Self-referral form link (if there is one)' }), url),
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
      for (const k of NULLABLE) if (k in out && !out[k]) out[k] = null;
      if ('requiresMention' in out && !out.requiresMention.length) out.requiresMention = null;
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
        const on = k in ch;
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
      const rows = projects.rows();
      const was = new Map(list(original.projects).map((p) => [p.id, p]));
      for (const [i, p] of now.projects.entries()) {
        if (!p.name) return { message: `Please give project ${i + 1} a name.`, el: rows[i]._name };
        if (!p.overview) return { message: `Please give "${p.name}" a short overview.`, el: rows[i]._ov };
        const old = was.get(p.id);
        if (p.overview.length > L.LIMITS.projectOverview && !(old && old.overview === p.overview)) return { message: `The overview for "${p.name}" is too long: please keep it to ${L.LIMITS.projectOverview} characters.`, el: rows[i]._ov };
        for (const c of list(p.cohorts)) if (!c.name) return { message: `Please give each cohort or session in "${p.name}" a name.`, el: rows[i].querySelector('.lf-cohort input') };
      }
      const order = L.checkParts(now.projects);
      if (order.length) return { message: order[0].replace(/^Project id .*used twice.*$/, 'Two projects or cohorts have the same name. Please make them different.') + '.', el: boxes.projects };
      if (!now.audience.length) return need('audience', 'Please tick at least one box under "Who do you work with?".');
      if (!now.referralRoutes.length) return need('referralRoutes', 'Please give at least one way people are referred or apply.');
      if (!now.selfReferral.note) return { message: 'Please say a few words about whether people can refer themselves.', el: boxes.selfReferral.querySelector('input[type=text]') };
      if (mode === 'team') {
        if (!now.areas.length) return need('areas', 'Please tick at least one box under "Where it runs".');
        if (!now.categories.length) return need('categories', 'Please tick at least one category.');
      }
      return null;
    }

    return { node: root, read, changes, check, mark, boxes };
  }

  globalThis.LISTING_FORM = { build, sections, HEALTH, AUDIENCE, SELF, DATE_LABEL };
})();
