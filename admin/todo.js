// The To do list (todo.html): everything waiting for the team, in one list, each with its next step.
//   To check: partner replies, suggested services, changes that couldn't go live, projects ending soon.
//   Ready to go live: edits, decisions, new services and organisation or venue changes saved but not yet live,
//     with one button to put them live.
//   Waiting on a partner: verify links with no reply, suggestions where we've asked them something.
//   Recently live: what went live in the last three weeks.
// Everything comes from the same places as All services (flow.js); nothing new is stored.
(() => {
  'use strict';

  const F = window.FLOW;
  const { el, list, plural, day, S } = F;
  const RECENT_DAYS = 21;
  let started = false;

  const item = (o) => el('li', { class: 'todo-item ' + (o.tone || '') },
    el('div', { class: 'todo-body' },
      el('span', { class: 'todo-kind', text: o.kind }),
      el('span', { class: 'todo-title' }, o.title),
      o.sub ? el('span', { class: 'todo-sub', text: o.sub }) : null),
    o.action || null);
  const go = (href, text, primary) => el('a', { class: 'btn ' + (primary ? 'primary' : 'secondary') + ' small', href, text });
  const svcHref = (id) => 'services.html#svc-' + encodeURIComponent(id);
  const section = (title, count, kids, extra) => el('section', { class: 'todo-sec', 'aria-labelledby': 'todo-' + title.replace(/\W+/g, '-').toLowerCase() },
    el('h2', { id: 'todo-' + title.replace(/\W+/g, '-').toLowerCase() }, title, ' ', el('span', { class: 'todo-count', text: String(count) })),
    count ? el('ul', { class: 'todo-list' }, kids) : el('p', { class: 'hint', text: 'Nothing here.' }), extra || null);

  function toCheck() {
    const out = [];
    // Partner replies the team hasn't dealt with.
    for (const s of S.services) {
      const { reply: r, handled } = F.newestReply(s.id);
      if (!r || handled) continue;
      const keys = Object.keys(r.changes || {});
      const prot = F.LL.protectedLines(s);
      const dropsRule = ['gate', 'eligibility'].some((k) => k in (r.changes || {}) && prot.some((l) => list(s[k]).includes(l) && !list(r.changes[k]).includes(l)));
      out.push({ t: r.t, tone: 'reply', kind: 'Partner reply · ' + day(r.t),
        title: r.allCorrect ? s.name + ': says everything is correct' : keys.length ? s.name + ': ' + plural(keys.length, 'change', 'changes') + ' from ' + r.name : s.name + ': a comment from ' + r.name,
        sub: keys.length ? keys.map((k) => F.FIELD_LABEL[k] || k).join(', ') + '.' + (dropsRule ? ' One would remove a grant funding rule: that part is kept as it is.' : '') : r.note ? 'They wrote a note.' : '',
        action: go('reply.html?id=' + encodeURIComponent(s.id), r.allCorrect ? 'Check and record' : 'Check changes', true) });
    }
    // Suggested services not looked at yet.
    for (const x of S.feedback.filter(F.isSuggestion)) {
      if (F.suggestionState(x) !== 'check') continue;
      const ms = x.missedService;
      const org = F.matchOrg(ms.organisation || '');
      const qs = F.suggestionQuestions(ms, org);
      out.push({ t: x.date, tone: 'suggest', kind: 'New service suggested · ' + day(x.date),
        title: ms.name + (ms.organisation ? ', from ' + ms.organisation : ''),
        sub: (ms.role === 'provider' ? 'Sent in by someone from the service. ' : ms.role === 'suggester' ? 'Sent in by someone who knows it. ' : '') + (qs.length ? plural(qs.length, 'thing', 'things') + ' to ask them before it can go live.' : ''),
        action: go('suggestion.html?id=' + encodeURIComponent(x.id), 'Check suggestion', true) });
    }
    // Changes the last run couldn't put live.
    for (const a of S.aside) {
      const href = a.kind === 'org' ? 'organisation.html' : a.kind === 'venue' ? 'services.html' : svcHref(a.id);
      out.push({ t: '9', tone: 'bad', kind: "Couldn't go live", title: a.name, sub: a.why + (a.by ? ' (' + a.by + ').' : '.'), action: go(href, 'Fix it') });
    }
    // Projects or groups on the live list that end, or stop taking referrals, within 30 days.
    for (const s of S.services.filter((y) => F.listingOf(y) === 'include' && y.open)) {
      const seen = new Set();
      for (const e of F.LL.endingSoon(s)) {
        // A session with the same date as its project says nothing new.
        const key = e.project.id + '|' + e.kind + '|' + e.date;
        if (seen.has(key)) continue;
        seen.add(key);
        const what = [e.project.name && e.project.name !== s.name ? e.project.name : '', e.session && e.session.name ? e.session.name : ''].filter(Boolean).join(', ');
        out.push({ t: '0' + e.date, tone: 'soon', kind: 'Ending soon · ' + day(e.date),
          title: s.name + (what ? ' (' + what + ')' : '') + ': ' + e.kind + ' in ' + plural(e.daysLeft, 'day', 'days'),
          sub: 'Check with the service whether it carries on, and update the dates.', action: go(svcHref(s.id), 'Open') });
      }
    }
    return out.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  }

  function ready() {
    const skip = new Set(S.aside.map((a) => a.kind + ':' + a.id));
    const out = [];
    for (const id of Object.keys(S.edits)) {
      if (F.editState(id) !== 'pending' || skip.has('service:' + id)) continue;
      const e = S.edits[id];
      const s = F.byId(id);
      const keys = Object.keys(e.changes);
      out.push({ t: e.t, title: el('span', {}, el('strong', { text: s.name }), ': ' + (keys.length ? keys.map((k) => F.FIELD_LABEL[k] || k).join(', ').toLowerCase() : 'checked, nothing changed') + ' (' + e.by + ', ' + day(e.t) + ')'), href: svcHref(id) });
    }
    for (const id of Object.keys(S.decisions)) {
      if (F.decisionState(id) !== 'pending' || skip.has('service:' + id) || skip.has('new:' + id)) continue;
      const d = S.decisions[id];
      const s = F.byId(id) || (S.added[id] && S.added[id].service) || { name: id };
      out.push({ t: d.t, title: el('span', {}, el('strong', { text: s.name }), ': ' + ({ include: 'include on the live list', review: 'needs further review', exclude: 'exclude' }[d.decision]) + ' (' + d.by + ', ' + day(d.t) + ')'), href: svcHref(id) });
    }
    for (const [id, a] of Object.entries(S.added)) {
      if (F.byId(id) || skip.has('new:' + id)) continue;
      out.push({ t: a.t, title: el('span', {}, el('strong', { text: a.service.name }), ': new service, waiting for review once added (' + a.createdBy + ', ' + day(a.t) + ')'), href: svcHref(id) });
    }
    for (const id of Object.keys(S.orgChanges)) {
      const c = F.orgPending(id);
      if (!c || skip.has('org:' + id)) continue;
      const o = S.organisations.find((x) => x.id === id);
      out.push({ t: c.t, title: el('span', {}, el('strong', { text: o ? o.name : id }), ': organisation ' + [c.changes.mergeInto ? 'combined' : '', c.changes.name ? 'renamed to "' + c.changes.name + '"' : '', 'overview' in c.changes ? 'new overview' : '', 'website' in c.changes ? 'new website' : ''].filter(Boolean).join(', ') + ' (' + c.by + ')'), href: 'organisation.html?id=' + encodeURIComponent(id) });
    }
    for (const id of Object.keys(S.venueChanges)) {
      const c = F.venuePending(id);
      if (!c || skip.has('venue:' + id)) continue;
      const v = S.venues.find((x) => x.id === id);
      out.push({ t: c.t, title: el('span', {}, el('strong', { text: v ? v.name : id }), ': venue details changed (' + c.by + ')'), href: 'services.html' });
    }
    return out.sort((a, b) => b.t.localeCompare(a.t));
  }

  function waiting() {
    const out = [];
    for (const s of S.services) {
      const links = F.linksFor(s.id);
      const live = links.find(F.linkLive);
      if (!live || links.some((l) => l.replies.length)) continue;
      out.push({ t: live.created, kind: 'Verify link sent · ' + day(live.created), title: s.name + ': no reply yet',
        sub: 'Sent to ' + live.contact + '. The link works until ' + day(live.expires) + '.',
        action: el('button', { type: 'button', class: 'btn secondary small', text: 'Copy a reminder email', onclick: (ev) => F.copy(F.reminderText(s, live), ev.currentTarget) }) });
    }
    for (const x of S.feedback.filter(F.isSuggestion)) {
      if (F.suggestionState(x) !== 'waiting') continue;
      const ms = x.missedService;
      out.push({ t: x.date, kind: 'Suggested service · asked them', title: ms.name + (ms.organisation ? ', from ' + ms.organisation : ''), sub: x.note || '', action: go('suggestion.html?id=' + encodeURIComponent(x.id), 'Open') });
    }
    return out.sort((a, b) => b.t.localeCompare(a.t));
  }

  function recent() {
    const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();
    const out = [];
    for (const [id, e] of Object.entries(S.edits)) if (e.t >= since && F.editState(id) === 'applied') out.push({ t: e.t, text: F.byId(id).name + ': ' + (Object.keys(e.changes).length ? 'details updated' : 'checked as current') });
    for (const [id, d] of Object.entries(S.decisions)) if (d.t >= since && F.decisionState(id) === 'applied' && F.byId(id)) out.push({ t: d.t, text: F.byId(id).name + ': ' + ({ include: 'on the live list', review: 'waiting for review', exclude: 'excluded' }[d.decision]) });
    return out.sort((a, b) => b.t.localeCompare(a.t)).slice(0, 12);
  }

  function draw() {
    const box = document.getElementById('todo');
    const a = toCheck();
    const r = ready();
    const w = waiting();
    const rec = recent();
    const msg = el('p', { class: 'msg', role: 'status', hidden: true });
    const say = (text, kind, link) => { msg.className = 'msg ' + (kind || 'info'); msg.replaceChildren(text, ...(link ? [' ', el('a', { href: link, target: '_blank', rel: 'noopener', text: 'See the details on GitHub' }), '.'] : [])); msg.hidden = false; };
    const live = el('button', { type: 'button', class: 'btn primary', text: 'Put ' + plural(r.length, 'checked change', 'checked changes') + ' live', onclick: async () => {
      if (!confirm('Put ' + plural(r.length, 'change', 'changes') + ' live now?\n\nThey are checked first. If the check passes they go live on the finder in about 3 minutes; if not, nothing changes.')) return;
      live.disabled = true;
      try {
        const ok = await F.putLive(say);
        if (ok) { await F.load(); draw(); }
      } catch (err) { say(err.message, 'err'); }
      live.disabled = false;
    } });
    const readyBox = el('div', { class: 'todo-ready' },
      el('ul', { class: 'todo-plain' }, r.map((x) => el('li', {}, x.title, ' ', el('a', { href: x.href, text: 'See or undo' })))),
      el('div', { class: 'apply-row' }, live, el('span', { class: 'hint', text: 'Checks run again, then the finder, the AI’s list and the printable directory update in a few minutes.' })), msg);
    box.replaceChildren(
      el('div', { class: 'todo-head' },
        el('h1', { class: 'mt0', text: 'To do' }),
        el('p', { class: 'hint', text: 'Everything waiting for the team, in one list. Each item says what to do next.' }),
        el('p', { class: 'todo-stats' }, el('span', { class: 'pill warn', text: a.length + ' to check' }), el('span', { class: 'pill', text: r.length + ' ready to go live' }), el('span', { class: 'pill', text: plural(w.length, 'waiting on a partner', 'waiting on partners') }))),
      section('To check', a.length, a.map(item)),
      el('section', { class: 'todo-sec', 'aria-labelledby': 'todo-ready-h' },
        el('h2', { id: 'todo-ready-h' }, 'Ready to go live ', el('span', { class: 'todo-count', text: String(r.length) })),
        r.length ? readyBox : el('p', { class: 'hint', text: 'Nothing waiting. Changes the team saves (edits, decisions, new services) appear here until they are live.' })),
      section('Waiting on a partner', w.length, w.map(item)),
      el('section', { class: 'todo-sec', 'aria-labelledby': 'todo-recent-h' },
        el('h2', { id: 'todo-recent-h', text: 'Recently live' }),
        rec.length ? el('ul', { class: 'todo-plain' }, rec.map((x) => el('li', {}, x.text + ' ', el('span', { class: 'hint', text: '(' + day(x.t) + ')' })))) : el('p', { class: 'hint', text: 'Nothing in the last three weeks.' })));
  }

  async function start() {
    if (started || !F.AUTH.pass()) return;
    started = true;
    const box = document.getElementById('todo');
    box.hidden = false;
    box.replaceChildren(el('p', { class: 'hint', text: 'Loading the To do list…' }));
    try {
      await F.load();
      draw();
    } catch (err) {
      started = false;
      box.replaceChildren(el('p', { class: 'msg err', text: err.status === 401 ? 'Your session has ended. Please sign in again.' : 'The To do list could not be loaded: ' + err.message }));
    }
  }

  window.TODO = { start };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
