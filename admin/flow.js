// Shared by the To do list (Admin home), the reply and suggestion checks and the organisation pages: loads
// everything the team is working on, and says where each thing is up to. All services (services.js) keeps its own
// copy of the same rules (editState, teamState, newestReply), so a change to one belongs in both.
//
// Where a thing is up to: it came in (a partner reply, a suggested service, something that couldn't go live), it
// has been checked (saved as an edit, decision or new service, waiting to go live), or it is live.
(() => {
  'use strict';

  const cfg = window.FINDER_CONFIG || {};
  const API = String(cfg.apiBase || '').replace(/\/$/, '');
  const AUTH = window.TEAM_AUTH || { pass: () => '', by: () => '', signOut: () => {} };
  const LL = globalThis.LISTING;

  // ---------- small helpers (text only, never innerHTML) ----------
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = Boolean(v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }
  const list = (v) => (Array.isArray(v) ? v : []);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const day = (iso) => {
    const d = new Date(String(iso).length === 10 ? iso + 'T00:00:00' : iso);
    return isNaN(d) ? String(iso || '') : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const when = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  async function api(method, path, body) {
    if (!API) throw Object.assign(new Error('This page has not been connected to the Worker yet.'), { status: 0 });
    let res;
    try {
      res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', 'x-team-passcode': AUTH.pass() }, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('Could not reach the Support Finder service. Please check your connection.'), { status: 0 });
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { AUTH.signOut(); }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
    return data;
  }
  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const was = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = was; }, 2000);
    } catch {
      prompt('Copy this:', text);
    }
  }

  // ---------- the same comparisons as All services ----------
  const canon = (v) => {
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return null;
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]).filter(([, x]) => x !== null));
    return v;
  };
  const norm = (v) => JSON.stringify(canon(v));
  const squash = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const orgSimple = (t) => String(t || '').toLowerCase().replace(/\b(the|ltd|limited|cic|plc|charity|trust)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

  const S = {}; // everything loaded: see load()

  function venueIdOf(v) {
    if (!v || typeof v !== 'object') return v;
    const f = S.venues.find((x) => x.postcode === v.postcode && (squash(x.address) === squash(v.address) || x.name.toLowerCase() === String(v.name).toLowerCase()));
    return f ? f.id : v;
  }
  function settleVenues(c) {
    const out = { ...c };
    if (Array.isArray(out.venues)) out.venues = [...new Set(out.venues.map(venueIdOf))];
    if (Array.isArray(out.projects)) out.projects = out.projects.map((p) => (p.sessions ? { ...p, sessions: p.sessions.map((x) => (x.venue ? { ...x, venue: venueIdOf(x.venue) } : x)) } : p));
    return out;
  }
  const byId = (id) => S.services.find((s) => s.id === id);
  const listingOf = (s) => (s && s.listing && s.listing.decision) || 'include';
  // A saved edit: 'none', 'pending' (waiting to go live) or 'applied'.
  function editState(id) {
    const e = S.edits[id];
    const s = byId(id);
    if (!e || !s) return 'none';
    const d0 = String(e.t).slice(0, 10);
    // A provider's own check also waits until it is recorded as provenance.providerChecked.
    if (e.checkedWith === 'provider' && String((s.provenance && s.provenance.providerChecked) || '') < d0) return 'pending';
    if (!Object.keys(e.changes).length) return e.checked && String(s.lastUpdated || '') < d0 ? 'pending' : 'applied';
    const want = settleVenues(e.changes);
    return Object.keys(e.changes).every((k) => norm(s[k]) === norm(want[k])) ? 'applied' : 'pending';
  }
  // A team decision (include, review, exclude): 'none', 'pending' or 'applied'.
  function decisionState(id) {
    const t = S.decisions[id];
    const s = byId(id);
    if (!t) return 'none';
    if (!s) return 'pending';
    return t.decision === listingOf(s) ? 'applied' : 'pending';
  }
  function orgPending(id) {
    const c = S.orgChanges[id];
    if (!c || !c.changes) return null;
    const o = S.organisations.find((x) => x.id === id);
    if (c.changes.mergeInto) return o ? c : null;
    if (!o) return null;
    return Object.entries(c.changes).every(([k, v]) => (k === 'name' ? o.name === v : (o[k] || null) === (v || null))) ? null : c;
  }
  function venuePending(id) {
    const c = S.venueChanges[id];
    if (!c || !c.changes) return null;
    const v = S.venues.find((x) => x.id === id);
    if (c.changes.mergeInto) return v ? c : null;
    if (!v) return null;
    return Object.entries(c.changes).every(([k, x]) => (v[k] || null) === (x || null)) ? null : c;
  }

  // ---------- a value in words, for "we had / they say" (as on All services) ----------
  const FIELD_LABEL = {
    name: 'Name of the service', organisation: 'Organisation', organisationOverview: 'About the organisation', open: 'Taking new referrals', level: 'Level', whoFor: 'Who the service is for', age: 'Age',
    webpage: 'Website', email: 'Email', phone: 'Phone', social: 'Social media', locations: 'Places used by every project', venues: 'Venues used by every project',
    areas: 'Where it runs', audience: 'Who they work with', categories: 'Categories', healthFocus: 'Health focus', eligibility: 'Who can use the service', exclusions: "Who it isn't for",
    gate: 'Essential (turned away without)', referralRoutes: 'How people get in', selfReferral: 'Can people refer themselves?', projects: 'What happens, where and when', workExperience: 'Work experience or volunteering',
    cost: 'Cost', languages: 'Languages and formats', coachNotes: 'Anything coaches should know', groups: "Who it's for (groups)", notes: 'Team notes', reviewCycle: 'Review cycle',
    hwlFunded: 'Healthy Working Life funded', mapLinks: 'Map buttons', logo: 'Logo', requiresMention: 'Only shown when mentioned',
    partners: 'In partnership with', residence: 'Who can use it, by where they live', work: 'Work situation', healthNote: 'Health conditions, in their words', ageMin: 'Age from', ageMax: 'Age up to',
    referral: 'Referral needed, and who can make it', answers: 'Where the answers came from',
  };
  const SELF = { yes: 'Yes', partly: 'Partly', no: 'No, they need a referral', tbc: 'Not known yet' };
  const venueText = (v) => {
    const x = typeof v === 'string' ? S.venues.find((y) => y.id === v) : v;
    if (!x) return typeof v === 'string' ? v : '';
    return LL.venueLine(x) + (x.ward ? ' (' + x.ward + ')' : x.id ? '' : ' (new venue)');
  };
  function sessionWords(c) {
    return [c.name, c.age ? 'age ' + c.age : '', c.venue ? venueText(c.venue) : '', LL.timeWords(c) || c.when || '', c.note].filter(Boolean).join(', ') || '(no details)';
  }
  function projectWords(p) {
    return (p.name || 'A project') + (list(p.sessions).length ? ': ' + p.sessions.map(sessionWords).join('; ') : '');
  }
  function words(v, k) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '(none)';
    if (k === 'projects') return list(v).map(projectWords).join(' | ');
    if (k === 'groups') return LL.groupNames(v).join('; ');
    if (k === 'venues') return list(v).map(venueText).join('; ');
    if (Array.isArray(v) && k !== 'healthFocus') return v.join('; ');
    if (k === 'residence' && typeof v === 'object') return LL.residenceWords(v);
    if (k === 'work' && typeof v === 'object') return v.needed === 'no' ? 'Any work situation' : LL.workWords(v);
    if (k === 'referral' && typeof v === 'object') return v.needed === 'no' ? 'No referral needed: people can just turn up or sign up' : v.who === 'professional' ? 'Referral needed, only from a professional' + (v.professionals ? ': ' + v.professionals : '') : v.who === 'anyone' ? 'Referral needed: anyone can make it, including the person themselves' : 'Referral needed';
    if (k === 'healthFocus') return v.map((h) => (h === 'any' ? 'Any health condition or disability' : h.replace(/-/g, ' '))).join('; ');
    if (k === 'selfReferral' && typeof v === 'object') return (SELF[v.allowed] || v.allowed) + (v.note ? '. ' + v.note : '') + (v.url ? ' ' + v.url : '');
    if (v === true) return 'Yes';
    if (v === false) return 'No';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  // Text with its web addresses as links that open in a new tab, so they can be checked with one click.
  const URL_IN_TEXT = /\b(https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+)/gi;
  function linked(text) {
    const t = String(text == null ? '' : text);
    const out = [];
    let last = 0;
    for (const m of t.matchAll(URL_IN_TEXT)) {
      const raw = m[0].replace(/[.,;:]+$/, '');
      out.push(t.slice(last, m.index));
      out.push(el('a', { href: /^https?:/i.test(raw) ? raw : 'https://' + raw, target: '_blank', rel: 'noopener noreferrer', text: raw }));
      last = m.index + raw.length;
    }
    out.push(t.slice(last));
    return out.filter((x) => x !== '');
  }

  // ---------- partner replies ----------
  const linksFor = (id) => S.links.filter((l) => l.id === id).sort((a, b) => b.created.localeCompare(a.created));
  const linkLive = (l) => !l.cancelled && Date.parse(l.expires) > Date.now();
  const linkUrl = (l) => new URL('../provider-check.html', location.href).href + '#' + l.token;
  // The newest reply for a service, and whether the team has dealt with it: marked as dealt with, or an edit
  // saved for the service since.
  function newestReply(id) {
    const replies = linksFor(id).flatMap((l) => l.replies.map((r) => ({ ...r, link: l }))).sort((a, b) => b.t.localeCompare(a.t));
    const r = replies[0] || null;
    const e = S.edits[id];
    return { reply: r, handled: Boolean(r && (r.handled || (e && e.t > r.t))), count: replies.length };
  }

  const reminderText = (s, l) => `Subject: A reminder: please check your details on the Healthy Working Life Support Finder (${s.name})

Hi ${l.contact},

A quick reminder about the link I sent on ${day(l.created)} to check the details the Support Finder holds about ${s.name}. It takes about 5 minutes:

${linkUrl(l)}

At the bottom of that page, press "Everything is correct" if nothing needs changing, or change anything that's wrong or missing and press "Send my changes". The link works until ${day(l.expires)}.

Thank you,
`;

  // ---------- suggested services (Suggest a service, in the feedback) ----------
  const isSuggestion = (x) => x.kind === 'gap' && x.missedService && x.missedService.name && !x.team;
  // 'check' (new, to look at), 'waiting' (asked them something), 'started' (a listing made from it), 'done'.
  function suggestionState(x) {
    const started = Object.values(S.added).some((a) => String(a.note || '').includes('feedback #' + x.id + ','));
    if (started) return 'started';
    if (x.status === 'New') return 'check';
    if (x.status === 'Reviewed') return 'waiting';
    return 'done';
  }
  // The organisation a suggestion most likely belongs to: the same name, another name it is known by, or one name
  // starting with the other ("TCD" and "TCD Mental Health Charity").
  function matchOrg(name) {
    const a = orgSimple(name);
    if (!a) return null;
    const names = (o) => [o.name, ...list(o.aliases)].map(orgSimple).filter(Boolean);
    const exact = S.organisations.find((o) => names(o).includes(a));
    if (exact) return exact;
    return S.organisations.find((o) => names(o).some((b) => b.length >= 3 && (a.startsWith(b + ' ') || b.startsWith(a + ' ')))) || null;
  }
  const servicesOfOrg = (o) => S.services.filter((s) => s.organisation === o.name || list(o.aliases).includes(s.organisation));
  // Services another organisation leads, delivered in partnership with this one (its name or other names in "partners").
  const partnerServicesOf = (o) => S.services.filter((s) => list(s.partners).some((p) => p === o.name || list(o.aliases).includes(p)));

  // Things to ask the person who suggested a service before it can be listed: answers that disagree, or that are
  // too short to match people on. Each: { what, said, why }.
  const ageNums = (t) => {
    const m = String(t || '').match(/(\d{1,2})\s*(\+|plus|and over|or over|to|-|–)?/i);
    return m ? Number(m[1]) : null;
  };
  function suggestionQuestions(ms, org) {
    const out = [];
    // The full service form: the person from the service answered the questions in the listing's own shape, so
    // only the overlap with listings we already have is worth asking about.
    if (ms.listing) {
      if (org) {
        const others = servicesOfOrg(org).filter((s) => orgSimple(s.name) !== orgSimple(ms.name));
        if (others.length) out.push({ what: 'Other ' + org.name + ' services', said: 'We already list: ' + others.map((s) => s.name).join('; '), why: 'Is it separate from these, or part of one of them?' });
      }
      return out;
    }
    const groups = list(ms.groups);
    const minAge = ageNums(ms.age);
    const under = String(ms.exclusions || '').match(/under\s*(\d{1,2})/i);
    if (minAge != null && under && Number(under[1]) !== minAge) out.push({ what: 'Age', said: ms.age + ', and "who it isn’t for": ' + ms.exclusions, why: 'These disagree. What is the youngest age that can join?' });
    const young = groups.filter((g) => ['children', 'young-people', 'students'].includes(g));
    if (minAge != null && minAge >= 18 && young.length) out.push({ what: 'Age and groups', said: 'Age ' + ms.age + ', but ticked ' + LL.groupNames(young).join(', '), why: 'Can younger people join, or should those groups be unticked?' });
    if (groups.length >= 10 && !groups.includes('everyone')) out.push({ what: 'Who it’s for (groups)', said: groups.length + ' of ' + Object.keys(LL.GROUPS).length + ' groups ticked, but not "Everyone"', why: 'Is it open to everyone, or are some sessions for particular groups? Which?' });
    if (!ms.eligibility || String(ms.eligibility).trim().length < 25) out.push({ what: 'Who can join', said: ms.eligibility ? '"' + ms.eligibility + '"' : 'Not given', why: 'Too short for the AI to match people on. Who exactly can join? Is a diagnosis or referral needed?' });
    if (ms.healthNeed === 'none' && groups.some((g) => ['mental-health', 'health-condition', 'disabled'].includes(g))) out.push({ what: 'Health need', said: 'None, but ticked ' + LL.groupNames(groups.filter((g) => ['mental-health', 'health-condition', 'disabled'].includes(g))).join(', '), why: 'Is it for people with that need, or open to anyone?' });
    const ps = list(ms.projects);
    const placed = ps.some((p) => p.online || p.appointment || list(p.sessions).some((x) => x.where || x.day));
    if (!placed && !ms.where && !ms.addresses) out.push({ what: 'Where and when', said: 'No venues, days or times', why: 'Where and when does it run? Venue and postcode, days and times.' });
    if (!ms.phone && !ms.email && !ms.website && !ms.referral) out.push({ what: 'How to get in touch', said: 'No phone, email, website or referral route', why: 'How do people join or get referred?' });
    if (org) {
      const others = servicesOfOrg(org).filter((s) => orgSimple(s.name) !== orgSimple(ms.name));
      if (others.length) out.push({ what: 'Other ' + org.name + ' services', said: 'We already list: ' + others.map((s) => s.name).join('; '), why: 'Is it separate from these, or part of one of them?' });
    }
    return out;
  }

  // ---------- loading ----------
  const getJson = (u) => fetch(u, { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });
  async function load() {
    const data = await getJson('services-all.json').catch(() => getJson('../services.json'));
    const opt = (p, empty) => api('GET', p).catch((e) => { if (e.status === 401) throw e; return empty; });
    const [d, e, nw, pl, og, vg, fb, ap] = await Promise.all([
      api('GET', '/log/decisions'), api('GET', '/log/edits'), api('GET', '/log/new'),
      opt('/log/provider-links', { links: [] }), opt('/log/orgs', { orgs: {} }), opt('/log/venues', { venues: {} }),
      opt('/feedback/items', { items: [] }), opt('/log/apply/status', null),
    ]);
    Object.assign(S, {
      services: list(data.services), organisations: list(data.organisations), venues: list(data.venues), choices: data.choices || {},
      decisions: d.decisions || {}, edits: e.edits || {}, added: nw.added || {}, links: list(pl.links), orgChanges: og.orgs || {},
      venueChanges: vg.venues || {}, feedback: list(fb.items), apply: ap,
    });
    const done = ap && ap.apply && ap.apply.status === 'completed';
    S.aside = done && ap.report ? list(ap.report.setAside) : [];
    return S;
  }

  // ---------- "Put live" (the Apply team changes workflow, as on All services) ----------
  // Starts the run, then follows it and the deploys it starts. say(text, kind, link) shows progress; resolves when done.
  async function putLive(say) {
    const by = AUTH.by();
    if (!by) { say('Please sign out and in again with your name or initials, so the team can see who put this live.', 'err'); return false; }
    const asked = Date.now();
    await api('POST', '/log/apply', { by });
    say('Starting…', 'info');
    const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, i ? 8000 : 5000));
      let st;
      try { st = await api('GET', '/log/apply/status'); } catch { continue; }
      const a = st.apply;
      if (!a || Date.parse(a.created) < asked - 30000) { say('Starting…', 'info'); continue; }
      const busy = (r) => r && r.status !== 'completed';
      const failed = (r) => r && r.status === 'completed' && r.conclusion !== 'success';
      if (busy(a)) { say('Checking the changes and the data (started ' + hhmm(a.created) + '). This takes a minute or two.', 'info'); continue; }
      if (failed(a)) { say('Nothing went live: the check found a problem. Your changes are still saved. Please tell Phil.', 'err', a.url); return false; }
      if (!st.site && !st.worker) { say('Nothing new to put live: the finder already has all the team’s changes.', 'ok'); return true; }
      if (busy(st.site) || busy(st.worker) || !st.site || !st.worker) { say('Checks passed. Updating the live finder now…', 'info'); continue; }
      if (failed(st.site) || failed(st.worker)) { say('The changes are merged, but updating the live finder failed. Please tell Phil.', 'err', (failed(st.site) ? st.site : st.worker).url); return false; }
      const aside = list(st.report && st.report.setAside);
      say('Live: the finder, the AI and the printable directory have the changes.' + (aside.length ? ' ' + plural(aside.length, 'change', 'changes') + ' couldn’t go live: see "To check".' : ''), aside.length ? 'info' : 'ok');
      return true;
    }
    say('Still going after 12 minutes. Check back on the To do list later.', 'info');
    return false;
  }

  window.FLOW = {
    API, AUTH, LL, S, el, list, plural, day, when, api, copy, norm, load, putLive, FIELD_LABEL, words, linked, projectWords, sessionWords, venueText,
    byId, listingOf, editState, decisionState, orgPending, venuePending, settleVenues,
    linksFor, linkLive, linkUrl, newestReply, reminderText, isSuggestion, suggestionState, matchOrg, orgSimple, servicesOfOrg, partnerServicesOf, suggestionQuestions,
  };
})();
