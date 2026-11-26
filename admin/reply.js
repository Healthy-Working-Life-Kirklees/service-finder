// Check a partner's reply (reply.html?id=<service id>): only the questions they changed, what we had next to what
// they say, and for each one "Use this", "Change it first" or "Don't use". On a grant project, a change that would
// take out one of the funding rules (LISTING.protectedLines) is flagged for the team to check; nothing is locked.
//
// Saving puts the changes used into the service's edit (with any edit already waiting), marked as checked with the
// provider, so it shows under "Ready to go live" on the To do list. "Change it first" opens the edit form on All
// services with those changes filled in. Using none of them marks the reply as dealt with.
(() => {
  'use strict';

  const F = window.FLOW;
  const { el, list, plural, day, S } = F;
  const $ = (s) => document.querySelector(s);
  const id = new URLSearchParams(location.search).get('id') || '';
  const page = $('#page');
  const PREFILL_KEY = 'hwl-edit-prefill';

  // Lists one item to a line, so a missing line is easy to spot.
  const shown = (v, k) => (k === 'projects' ? list(v).map(F.projectWords).join('\n') || '(none)' : Array.isArray(v) && k !== 'groups' && k !== 'venues' ? (v.length ? v.join('\n') : '(none)') : F.words(v, k));

  // Once a partner has checked their details, they can be invited to join the pilot.
  function invitePilot(s, r) {
    const o = F.matchOrg(s.organisation);
    const btn = el('button', { type: 'button', class: 'btn secondary small', text: 'Copy a pilot invitation email', onclick: (ev) => F.copy(F.inviteText({ contact: r.name, service: s.name }), ev.currentTarget) });
    return el('p', { class: 'hint' }, F.inPilot(o) ? o.name + ' is already in the pilot. ' : 'Invite them to join the pilot: ', btn,
      ' Attach the quick guide before sending.', o && !F.inPilot(o) ? ' Once they agree, switch on "Taking part in the pilot" on ' : '',
      o && !F.inPilot(o) ? el('a', { href: 'organisation.html?id=' + encodeURIComponent(o.id), text: o.name + '’s page' }) : null, o && !F.inPilot(o) ? '.' : '');
  }

  function draw() {
    const s = F.byId(id);
    if (!s) return page.replaceChildren(el('p', { class: 'msg err', text: 'That service was not found.' }));
    const { reply: r, handled } = F.newestReply(id);
    if (!r) return page.replaceChildren(el('p', { class: 'msg info', text: s.name + ' has no reply from its partner yet.' }), el('p', {}, el('a', { href: 'todo.html', text: 'Back to the To do list' })));
    const e = S.edits[id];
    const pending = e && F.editState(id) === 'pending' ? e.changes : {};
    const keys = Object.keys(r.changes || {});
    const prot = F.LL.protectedLines(s);
    const msg = el('p', { class: 'msg', role: 'status', hidden: true });
    const say = (text, kind) => { msg.className = 'msg ' + kind; msg.textContent = text; msg.hidden = false; };
    const head = [
      el('h1', { class: 'mt0', text: s.name + ': ' + (r.allCorrect ? 'says everything is correct' : keys.length ? plural(keys.length, 'change', 'changes') + ' from the partner' : 'a comment from the partner') }),
      el('p', { class: 'hint', text: 'Sent through their verify link on ' + day(r.t) + ' by ' + r.name + (r.name !== r.link.contact ? ' (the link was for ' + r.link.contact + ')' : '') + '. Only the questions they changed are shown.' }),
      el('p', { class: 'steps', 'aria-label': 'Where this is up to' }, el('span', { text: 'Came in' }), '→', el('span', { class: handled ? '' : 'on', text: 'Checking' }), '→', el('span', { class: handled ? 'on' : '', text: handled ? 'Checked' : 'Live' })),
      handled ? el('p', { class: 'msg info', text: r.handled ? 'Dealt with by ' + r.handled.by + ' on ' + day(r.handled.t) + (r.handled.note ? ': ' + r.handled.note : '.') : 'The team has saved changes for this service since this reply.' }) : null,
      Object.keys(pending).length ? el('p', { class: 'msg info', text: 'There are other changes to ' + s.name + ' waiting to go live (' + e.by + '). They are kept: what you use here is added to them.' }) : null,
      invitePilot(s, r),
    ];
    const note = r.note ? el('div', { class: 'change' }, el('h2', { text: 'Their note to the team' }), el('p', { class: 'mt0' }, el('em', { text: '"' + r.note + '"' }))) : null;

    // All correct: one button.
    if (r.allCorrect) {
      const rec = el('button', { type: 'button', class: 'btn primary', text: 'Accept as verified', onclick: async () => {
        rec.disabled = true;
        try {
          const d = await F.api('PUT', '/log/edits/' + encodeURIComponent(id), { changes: pending, before: {}, by: F.AUTH.by() || 'someone', checked: true, checkedUrl: '', checkedWith: 'provider',
            note: ('Checked with ' + r.name + ' (partner) using a verify link, ' + day(r.t) + ': everything correct.' + (r.note ? ' They added: ' + r.note : '')).slice(0, 1000) });
          S.edits[id] = d.item;
          say('Recorded. It’s on the To do list under "Ready to go live": the last-checked date moves on when it goes live.', 'ok');
          rec.hidden = true;
        } catch (err) { rec.disabled = false; say(err.message, 'err'); }
      } });
      return page.replaceChildren(...head.filter(Boolean), ...[note].filter(Boolean), el('div', { class: 'decide-bar' }, el('span', { text: 'Nothing changed. Accepting records that ' + s.name + '’s details were confirmed by the organisation, so it shows as verified once it goes live.' }), rec), msg);
    }

    // One card per change.
    const cards = keys.map((k, i) => {
      const before = r.before && k in r.before ? r.before[k] : s[k];
      const now = r.changes[k];
      // Not locked: on a grant project, a change that takes out one of the funding rules is only flagged, so the
      // team checks it with the organisation. "Use this" uses the whole change.
      const dropped = k === 'gate' || k === 'eligibility' ? prot.filter((l) => list(s[k]).includes(l) && !list(now).includes(l))
        : k === 'healthFocus' && F.LL.isGrantProject(s) && list(s.healthFocus).includes('any') && !list(now).includes('any') ? ['Any health condition or disability']
        : k === 'essential' && F.LL.isGrantProject(s) ? list(s.essential).filter((x) => !list(now).includes(x)).map((x) => F.words([x], 'essential')) : [];
      const moved = r.before && k in r.before && F.norm(s[k]) !== F.norm(r.before[k]);
      const name = 'ch-' + i;
      const opt = (v, text, on) => el('label', {}, el('input', { type: 'radio', name, value: v, checked: on }), text);
      const choice = el('fieldset', { class: 'choice-row' }, el('legend', { text: 'What to do with this change' }),
        opt('use', 'Use this', true), opt('change', 'Change it first'), opt('skip', "Don't use"));
      const card = el('section', { class: 'change' + (dropped.length ? ' blocked' : '') },
        el('h2', { text: F.FIELD_LABEL[k] || k }),
        el('div', { class: 'change-cols' }, el('div', { class: 'was' }, el('b', { text: 'We had' }), ...F.linked(shown(before, k))), el('div', { class: 'now' }, el('b', { text: 'They say' }), ...F.linked(shown(r.changes[k], k)))),
        moved ? el('p', { class: 'msg info' }, 'This has changed since they replied. It now says: ', ...F.linked(shown(s[k], k))) : null,
        dropped.length ? el('p', { class: 'kept' }, el('strong', { text: 'Check this: ' }), 'it takes out ' + dropped.map((l) => '"' + l + '"').join(', ') + ', ' + (dropped.length === 1 ? 'a funding rule' : 'funding rules') + ' for the Healthy Working Life grant projects. Check with the organisation before you use it.') : null,
        choice);
      card._k = k;
      card._value = now;
      card._choice = () => card.querySelector('input:checked').value;
      return card;
    });

    const pick = () => {
      const out = { use: [], change: [], skip: [] };
      for (const c of cards) out[c._choice()].push(c);
      return out;
    };
    const summary = el('span', { class: 'decide-text' });
    const save = el('button', { type: 'button', class: 'btn primary' });
    const refresh = () => {
      const p = pick();
      summary.textContent = [p.use.length ? plural(p.use.length, 'change', 'changes') + ' to use' : '', p.change.length ? plural(p.change.length, 'to change first', 'to change first') : '', p.skip.length ? p.skip.length + ' not used' : ''].filter(Boolean).join(', ') + '.';
      save.textContent = p.change.length ? 'Open in the edit form' : p.use.length ? 'Save as checked' : "Don't use any of them";
    };
    page.addEventListener('change', refresh);
    const labels = (cs) => cs.map((c) => F.FIELD_LABEL[c._k] || c._k).join(', ');
    save.addEventListener('click', async () => {
      const p = pick();
      const by = F.AUTH.by() || 'someone';
      const used = [...p.use, ...p.change];
      const noteText = ('From ' + r.name + ' (partner) using a verify link, ' + day(r.t) + '.' + (used.length ? ' Used: ' + labels(used) + '.' : '') + (p.skip.length ? ' Not used: ' + labels(p.skip) + '.' : '') + (r.note ? ' They said: ' + r.note : '')).slice(0, 1000);
      const changes = { ...pending };
      const before = {};
      for (const c of used) { changes[c._k] = c._value; before[c._k] = s[c._k] === undefined ? null : s[c._k]; }
      save.disabled = true;
      try {
        if (p.change.length) {
          try { sessionStorage.setItem(PREFILL_KEY, JSON.stringify({ id, changes, note: noteText })); } catch { /* ignore */ }
          location.href = 'services.html#svc-' + encodeURIComponent(id);
          return;
        }
        if (p.use.length) {
          const d = await F.api('PUT', '/log/edits/' + encodeURIComponent(id), { changes, before, by, checked: true, checkedUrl: '', checkedWith: 'provider', note: noteText });
          S.edits[id] = d.item;
          say('Saved. It’s on the To do list under "Ready to go live". Nothing is live yet.', 'ok');
        } else {
          await F.api('POST', '/log/provider-links/' + r.link.token + '/handled', { t: r.t, by, note: 'None of the changes used.' });
          say('Done: none of their changes were used. You may want to tell them why.', 'ok');
        }
        bar.hidden = true;
      } catch (err) { save.disabled = false; say(err.message, 'err'); }
    });
    const ask = el('button', { type: 'button', class: 'btn secondary', text: 'Copy an email to ask them something', onclick: (ev) => F.copy('Subject: Your changes to ' + s.name + ' on the Healthy Working Life Support Finder\n\nHi ' + r.name + ',\n\nThank you for checking the details of ' + s.name + '. Before we put your changes live, could you tell us:\n\n- \n\nThank you,\n', ev.currentTarget) });
    const bar = el('div', { class: 'decide-bar' }, summary, el('span', { class: 'row-end' }, ask, save));
    const others = Object.keys(s).filter((k) => F.FIELD_LABEL[k] && !keys.includes(k)).length;
    refresh();
    page.replaceChildren(...[...head, ...cards, note,
      el('p', { class: 'hint' }, plural(others, 'other question', 'other questions') + ' not changed. ', el('a', { href: 'services.html#svc-' + encodeURIComponent(id), text: 'Show the whole listing' })),
      handled ? null : bar, msg].filter(Boolean));
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
