// Check a suggested service (suggestion.html?id=<feedback id>), from "Suggest a service" on the finder:
//   1. which organisation it belongs to (matched for you, so there's no duplicate), and whether to update that
//      organisation's record with the name and description they gave;
//   2. things to ask them: answers that disagree or are too short to match people on (FLOW.suggestionQuestions),
//      with an email drafted from them;
//   3. what they told us;
//   4. start the listing (Add a service on All services, filled in, as "waiting for review"), mark it as waiting on
//      them, or don't add it.
(() => {
  'use strict';

  const F = window.FLOW;
  const { el, list, plural, day, S } = F;
  const $ = (s) => document.querySelector(s);
  const fid = Number(new URLSearchParams(location.search).get('id'));
  const page = $('#page');
  const DRAFT_KEY = 'hwl-listing-draft';
  const LABELS = {
    organisation: 'Organisation', organisationOverview: 'About the organisation', whoFor: 'Who it’s for', open: 'Taking referrals now', age: 'Age',
    eligibility: 'Who can join', gate: 'Essential', exclusions: 'Who it isn’t for', healthNeed: 'Health need', conditions: 'Conditions', groups: 'Groups ticked',
    audience: 'Works with', categories: 'Kinds of support', level: 'Covers', phone: 'Phone', email: 'Email', social: 'Social media', referral: 'How people get referred',
    selfReferral: 'Self-referral', cost: 'Cost', languages: 'Languages', workExperience: 'Work experience', coachNotes: 'Anything coaches should know', logoOk: 'OK to use their logo',
    where: 'Where', when: 'When', projectName: 'Project', projectOverview: 'What happens', duration: 'How long', places: 'Places',
  };
  const CHOICE = {
    'open:yes': 'Yes', 'open:no': 'No, not at the moment', 'healthNeed:none': 'No, anyone', 'healthNeed:any': 'Any health condition or disability', 'healthNeed:specific': 'A specific condition',
    'level:local': 'Kirklees', 'level:regional': 'West Yorkshire', 'level:national': 'UK-wide', 'selfReferral:yes': 'Yes', 'selfReferral:partly': 'Sometimes', 'selfReferral:no': 'No, needs a referral',
  };
  const value = (k, v) => (k === 'groups' ? F.LL.groupNames(v).join(', ') : v === true ? 'Yes' : Array.isArray(v) ? v.join(', ') : CHOICE[k + ':' + v] || String(v));

  function draw() {
    const x = S.feedback.find((y) => y.id === fid);
    if (!x || !F.isSuggestion(x)) return page.replaceChildren(el('p', { class: 'msg err', text: 'That suggestion was not found.' }));
    const ms = x.missedService;
    const state = F.suggestionState(x);
    const org = F.matchOrg(ms.organisation || '');
    const msg = el('p', { class: 'msg', role: 'status', hidden: true });
    const say = (text, kind) => { msg.className = 'msg ' + kind; msg.textContent = text; msg.hidden = false; };
    const by = () => F.AUTH.by() || 'someone';

    // 1. The organisation.
    const orgName = 'org-choice';
    const useOrg = el('input', { type: 'radio', name: orgName, value: 'match', checked: Boolean(org) });
    const newOrg = el('input', { type: 'radio', name: orgName, value: 'new', checked: !org });
    const renameBox = org && ms.organisation && F.orgSimple(ms.organisation) !== F.orgSimple(org.name) ? el('input', { type: 'checkbox', checked: true }) : null;
    const overviewBox = org && ms.organisationOverview && !org.overview && !/healthy\s+working\s+life|\bhwl\b/i.test(ms.organisationOverview) ? el('input', { type: 'checkbox', checked: true }) : null;
    const others = org ? F.servicesOfOrg(org) : [];
    const step1 = el('section', { class: 'change' },
      el('h2', { text: '1. Which organisation does it belong to?' }),
      org ? el('p', { class: 'mt0' }, '"' + (ms.organisation || '') + '" looks like ', el('strong', { text: org.name }), others.length ? ', which we already list with ' + plural(others.length, 'service', 'services') + ': ' + others.map((s) => s.name).join('; ') + '.' : ', which we already list.')
        : el('p', { class: 'mt0', text: ms.organisation ? 'We don’t list "' + ms.organisation + '" yet: a new organisation record is made when the service is added.' : 'They didn’t give an organisation.' }),
      org ? el('fieldset', { class: 'choice-row' }, el('legend', { text: 'Organisation' }),
        el('label', {}, useOrg, 'Add it under ' + org.name), el('label', {}, newOrg, 'It’s a different organisation')) : null,
      renameBox ? el('p', {}, el('label', {}, renameBox, ' Also rename ' + org.name + ' to "' + ms.organisation + '" (keeping "' + org.name + '" as another name)')) : null,
      overviewBox ? el('p', {}, el('label', {}, overviewBox, ' Also use their "About the organisation" text for ' + org.name + ' (it has none yet)')) : null,
      org ? el('p', { class: 'hint', text: 'The Healthy Working Life marker never goes on an organisation, only on the services that are funded.' }) : null);

    // 2. Things to ask.
    const qs = F.suggestionQuestions(ms, org);
    const email = 'Subject: The service you suggested for the Healthy Working Life Support Finder (' + ms.name + ')\n\nHi,\n\nThank you for telling us about ' + ms.name + '. Before we add it, could you help us with a few questions, so we match the right people to it?\n\n' +
      qs.map((q) => '- ' + q.what + ': ' + q.why).join('\n') + '\n\nThank you,\n';
    const step2 = el('section', { class: 'change' },
      el('h2', { text: '2. Things to ask them' + (qs.length ? ' (' + qs.length + ')' : '') }),
      qs.length ? el('div', { class: 'table-scroll' }, el('table', { class: 'ask-table' },
        el('thead', {}, el('tr', {}, ['Question', 'What they said', 'Why ask'].map((h) => el('th', { scope: 'col', text: h })))),
        el('tbody', {}, qs.map((q) => el('tr', {}, el('td', {}, el('strong', { text: q.what })), el('td', { text: q.said }), el('td', { text: q.why }))))))
        : el('p', { class: 'mt0', text: 'Nothing obvious. Still check the details with them before the service goes live.' }),
      qs.length ? el('p', {}, el('button', { type: 'button', class: 'btn secondary small', text: 'Copy an email with these questions', onclick: (ev) => F.copy(email, ev.currentTarget) })) : null);

    // 3. What they told us.
    const dl = el('dl', { class: 'facts' });
    for (const [k, lab] of Object.entries(LABELS)) {
      const v = ms[k];
      if (v == null || v === '' || (Array.isArray(v) && !v.length) || v === false || (ms.listing && k in ms.listing)) continue;
      dl.append(el('dt', { text: lab }), el('dd', { text: value(k, v) }));
    }
    // The full service form: the whole listing, one line per question answered.
    if (ms.listing) {
      for (const [k, v] of Object.entries(ms.listing)) {
        if (k === 'projects' || k === 'name' || k === 'organisation') continue;
        const w = F.words(v, k);
        if (w) dl.append(el('dt', { text: F.FIELD_LABEL[k] || k }), el('dd', {}, ...F.linked(w)));
      }
      const ps = list(ms.listing.projects).map(F.projectWords).filter(Boolean);
      if (ps.length) dl.append(el('dt', { text: 'Activities and timetable' }), el('dd', {}, el('ol', { class: 'mt0' }, ps.map((t) => el('li', { text: t })))));
    }
    const projects = F.LL.suggestedProjectLines(ms.projects);
    if (projects.length) dl.append(el('dt', { text: 'Projects' }), el('dd', {}, el('ol', { class: 'mt0' }, projects.map((t) => el('li', { text: t })))));
    const step3 = el('section', { class: 'change' }, el('h2', { text: '3. What they told us' }),
      el('p', { class: 'hint mt0', text: 'Sent on ' + day(x.date) + ' by ' + (ms.role === 'provider' ? 'someone from the service' : ms.role === 'suggester' ? 'someone who knows about it' : 'someone') + (ms.website ? '. Website: ' + ms.website : '') + '.' + (ms.listing ? ' They filled in the full service form, so the listing starts with all their answers.' : '') }), dl);

    // 4. What to do.
    const start = el('button', { type: 'button', class: 'btn primary', text: org ? 'Start the listing under ' + org.name : 'Start the listing', onclick: async () => {
      const under = org && useOrg.checked ? org : null;
      start.disabled = true;
      try {
        if (under && (renameBox && renameBox.checked || overviewBox && overviewBox.checked)) {
          const changes = {};
          if (renameBox && renameBox.checked) changes.name = ms.organisation.trim().slice(0, 150);
          if (overviewBox && overviewBox.checked) changes.overview = ms.organisationOverview.trim().slice(0, F.LL.LIMITS.orgOverview);
          const d = await F.api('PUT', '/log/orgs/' + under.id, { changes, before: { name: under.name, overview: under.overview || null, website: under.website || null }, note: 'From the suggestion of ' + ms.name + ' (feedback #' + x.id + ').', by: by() });
          S.orgChanges[under.id] = d.item;
        }
        const { contactName, ...rest } = ms;
        const draft = { ...rest, from: x.id, date: x.date };
        if (under) draft.organisation = under.name;
        try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
        location.href = 'services.html';
      } catch (err) { start.disabled = false; say(err.message, 'err'); }
    } });
    const wait = el('button', { type: 'button', class: 'btn secondary', text: 'Mark as waiting on them', onclick: async () => {
      try {
        await F.api('PATCH', '/feedback/items/' + x.id, { status: 'Reviewed', note: ('Asked them (' + by() + ', ' + day(new Date().toISOString()) + ')' + (qs.length ? ': ' + qs.map((q) => q.what).join(', ') : '') + '.').slice(0, 500) });
        say('Marked as waiting on them. It’s under "Waiting on a partner" on the To do list.', 'ok');
      } catch (err) { say(err.message, 'err'); }
    } });
    const no = el('button', { type: 'button', class: 'btn secondary', text: 'Don’t add it', onclick: async () => {
      const why = prompt('Why not? (a few words, kept with the suggestion)');
      if (why == null) return;
      try {
        await F.api('PATCH', '/feedback/items/' + x.id, { status: 'Not actioned', note: ('Not added (' + by() + '): ' + why).slice(0, 500) });
        say('Done. It’s off the To do list.', 'ok');
      } catch (err) { say(err.message, 'err'); }
    } });
    const stateText = { check: 'Not looked at yet.', waiting: 'Waiting on them' + (x.note ? ': ' + x.note : '.'), started: 'A listing has been started from it: see All services.', done: 'Dealt with (' + x.status + ')' + (x.note ? ': ' + x.note : '.') }[state];
    page.replaceChildren(
      el('h1', { class: 'mt0', text: ms.name }),
      el('p', { class: 'hint', text: 'Suggested on ' + day(x.date) + (ms.organisation ? ', from ' + ms.organisation : '') + '. ' + stateText }),
      el('p', { class: 'steps', 'aria-label': 'Where this is up to' }, el('span', { text: 'Came in' }), '→', el('span', { class: 'on', text: 'Checking' }), '→', el('span', { text: 'Live' })),
      step1, step2, step3,
      state === 'started' || state === 'done' ? null : el('div', { class: 'decide-bar' },
        el('span', { text: 'Start the listing now and finish it when they reply. It’s added as "waiting for review", so nobody sees it until you include it.' }),
        el('span', { class: 'row-end' }, no, wait, start)),
      msg);
  }

  (async () => {
    try {
      await F.load();
      draw();
    } catch (err) {
      page.replaceChildren(el('p', { class: 'msg err', text: 'This page could not be loaded: ' + err.message }));
    }
  })();
})();
