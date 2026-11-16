// Organisations (organisation.html): with no organisation chosen, every organisation to search; with one
// (?id=<organisation id> or ?name=<a name it is known by>), everything it runs, from the organisation down to each
// time, place and group, with where each service is up to and what's missing. "Add a service" here adds it under
// this organisation (All services, filled in).
(() => {
  'use strict';

  const F = window.FLOW;
  const { el, list, plural, day, S } = F;
  const $ = (s) => document.querySelector(s);
  const q = new URLSearchParams(location.search);
  const page = $('#page');
  const STALE_DAYS = 135; // as the finder's "may be out of date" warning
  const LISTING = { include: ['Live', 'ok'], review: ['Waiting for review', 'warn'], exclude: ['Excluded', 'bad'] };

  function chooser() {
    const box = el('input', { id: 'org-find', type: 'search', autocomplete: 'off' });
    const out = el('ul', { class: 'org-list-page' });
    const count = el('p', { class: 'count', role: 'status' });
    const draw = () => {
      const words = box.value.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = S.organisations.filter((o) => words.every((w) => (o.name + ' ' + list(o.aliases).join(' ')).toLowerCase().includes(w)))
        .sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' }));
      count.textContent = plural(hits.length, 'organisation', 'organisations');
      out.replaceChildren(...hits.slice(0, 80).map((o) => {
        const svcs = F.servicesOfOrg(o);
        const live = svcs.filter((s) => F.listingOf(s) === 'include').length;
        return el('li', {}, el('a', { href: '?id=' + encodeURIComponent(o.id) }, el('strong', { text: o.name }),
          ' — ' + plural(svcs.length, 'service', 'services') + (svcs.length ? ', ' + live + ' live' : '') + (svcs.some((s) => s.hwlFunded) ? ', Healthy Working Life' : '')));
      }));
    };
    box.addEventListener('input', draw);
    page.replaceChildren(
      el('h1', { class: 'mt0', text: 'Organisations' }),
      el('p', { class: 'hint', text: 'Each organisation with everything it runs. Open one to see its services, projects, times, places and groups, where each is up to and what’s missing.' }),
      el('div', { class: 'field' }, el('label', { for: 'org-find', text: 'Find an organisation' }), box), count, out);
    draw();
  }

  function sessionLine(c) {
    const gaps = [];
    if (!c.venue && !list(c.where).length && !(c.age || list(c.eligibility).length)) gaps.push('no venue');
    if (!list(c.days).length && !c.when && !c.note) gaps.push('no day or time');
    return el('p', {}, el('strong', { text: c.age || list(c.eligibility).length ? 'Group: ' : '' }), F.sessionWords(c),
      gaps.length ? ' ' : '', gaps.length ? el('span', { class: 'pill warn', text: gaps.join(', ') }) : null);
  }

  function serviceBox(s) {
    const l = LISTING[F.listingOf(s)] || LISTING.include;
    const links = F.linksFor(s.id);
    const { reply, handled } = F.newestReply(s.id);
    const age = Math.floor((Date.now() - Date.parse(s.lastUpdated + 'T00:00:00')) / 86400000);
    const pills = [el('span', { class: 'pill ' + l[1], text: l[0] })];
    if (s.hwlFunded) pills.push(el('span', { class: 'pill blue', text: 'Healthy Working Life' }));
    if (!s.open) pills.push(el('span', { class: 'pill bad', text: 'Not taking referrals' }));
    if (reply && !handled) pills.push(el('a', { class: 'pill warn', href: 'reply.html?id=' + encodeURIComponent(s.id), text: 'Partner replied: check it' }));
    else if (links.length && !links.some((x) => x.replies.length)) pills.push(el('span', { class: 'pill warn', text: 'Verify link sent ' + day(links[0].created) + ', no reply' }));
    else if (!links.length && F.listingOf(s) === 'include') pills.push(el('span', { class: 'pill', text: 'No verify link yet' }));
    if (F.editState(s.id) === 'pending') pills.push(el('span', { class: 'pill', text: 'Changes ready to go live' }));
    if (age > STALE_DAYS) pills.push(el('span', { class: 'pill warn', text: 'Not checked for ' + age + ' days' }));
    if (JSON.stringify(s).includes('To be completed')) pills.push(el('span', { class: 'pill warn', text: 'Details to complete' }));
    return el('article', { class: 'org-svc' },
      el('p', { class: 'todo-kind mt0', text: 'Service' }),
      el('h3', {}, el('a', { href: 'services.html#svc-' + encodeURIComponent(s.id), text: s.name })),
      el('p', { class: 'mt0' }, pills),
      el('p', { class: 'hint', text: (s.whoFor || '') + (s.lastUpdated ? ' Last checked ' + day(s.lastUpdated) + '.' : '') }),
      el('div', { class: 'tree' }, list(s.projects).map((p) => el('div', {},
        el('p', {}, el('strong', { text: 'Project: ' + (p.name || '(no name)') }), p.runs ? ' (' + list(p.runs).map((r) => F.LL.RUNS[r] || r).join('; ').toLowerCase() + ')' : ''),
        list(p.sessions).length ? el('div', { class: 'tree' }, p.sessions.map(sessionLine))
          : list(p.runs).includes('set') || !list(p.runs).length ? el('p', { class: 'tree' }, el('span', { class: 'pill warn', text: 'No times, places or groups yet' })) : null))),
      el('p', { class: 'row-end' }, el('a', { class: 'btn secondary small', href: 'services.html#svc-' + encodeURIComponent(s.id), text: 'Edit or send a verify link' })));
  }

  function show(o) {
    const svcs = F.servicesOfOrg(o).sort((a, b) => Number(b.hwlFunded) - Number(a.hwlFunded) || a.name.localeCompare(b.name));
    const pendingNew = Object.entries(S.added).filter(([id, a]) => !F.byId(id) && (a.service.organisation === o.name || list(o.aliases).includes(a.service.organisation)));
    const suggested = S.feedback.filter(F.isSuggestion).filter((x) => ['check', 'waiting'].includes(F.suggestionState(x)) && F.matchOrg(x.missedService.organisation || '') === o);
    const c = F.orgPending(o.id);
    document.title = o.name + ' | Organisations | Kirklees HWL Support Finder';
    page.replaceChildren(
      el('p', { class: 'crumbs' }, el('a', { href: 'organisation.html', text: 'Organisations' }), ' › ' + o.name),
      el('section', { class: 'org-head' },
        el('p', { class: 'todo-kind mt0', text: 'Organisation' }),
        el('h1', { class: 'mt0', text: o.name }),
        el('p', { class: 'hint', text: (list(o.aliases).length ? 'Also known as: ' + o.aliases.join('; ') + '. ' : '') + plural(svcs.length, 'service', 'services') + (svcs.filter((s) => s.hwlFunded).length ? ', ' + svcs.filter((s) => s.hwlFunded).length + ' Healthy Working Life' : '') + '.' }),
        o.overview ? el('p', { text: o.overview }) : el('p', {}, el('span', { class: 'pill warn', text: 'No "About the organisation" yet' })),
        o.website ? el('p', {}, el('a', { href: o.website, target: '_blank', rel: 'noopener noreferrer', text: o.website })) : null,
        c ? el('p', { class: 'msg info', text: 'Changes to this organisation are ready to go live (' + c.by + ').' }) : null,
        el('p', { class: 'hint', text: 'The Healthy Working Life marker never goes on the organisation, only on the services that are funded.' }),
        el('p', { class: 'row-end' },
          el('a', { class: 'btn secondary small', href: 'services.html?orgs=' + encodeURIComponent(o.name), text: 'Edit organisation' }),
          el('a', { class: 'btn primary small', href: 'services.html?add=' + encodeURIComponent(o.name), text: 'Add a service' }))),
      ...svcs.map(serviceBox),
      ...pendingNew.map(([id, a]) => el('article', { class: 'org-svc suggested' }, el('p', { class: 'todo-kind mt0', text: 'New service, not added yet' }), el('h3', {}, el('a', { href: 'services.html#svc-' + encodeURIComponent(id), text: a.service.name })), el('p', { class: 'hint', text: 'Saved by ' + a.createdBy + ' on ' + day(a.t) + '. It’s added as "waiting for review" when the team’s changes go live.' }))),
      ...suggested.map((x) => el('article', { class: 'org-svc suggested' },
        el('p', { class: 'todo-kind mt0', text: 'Suggested service · ' + day(x.date) }),
        el('h3', { text: x.missedService.name }),
        el('p', { class: 'row-end' }, el('a', { class: 'btn primary small', href: 'suggestion.html?id=' + x.id, text: 'Check suggestion' })))));
  }

  (async () => {
    try {
      await F.load();
      const id = q.get('id');
      const name = q.get('name');
      const o = id ? S.organisations.find((x) => x.id === id) : name ? F.matchOrg(name) : null;
      if (o) show(o);
      else {
        chooser();
        if (id || name) page.prepend(el('p', { class: 'msg info', text: 'That organisation wasn’t found. Choose one below.' }));
      }
    } catch (err) {
      page.replaceChildren(el('p', { class: 'msg err', text: 'This page could not be loaded: ' + err.message }));
    }
  })();
})();
