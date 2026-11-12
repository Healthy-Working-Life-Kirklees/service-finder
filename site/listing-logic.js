// Shared rules for a listing's projects, sessions, venues and dates. One copy, used by:
//   the finder page (site/app.js), the provider and Admin forms (site/listing-form.js), the Worker
//   (worker/src/index.js, which imports this file), the directory PDF (scripts/build-print.mjs), the data
//   checks (scripts/check-data.mjs) and the commissioner page (admin/commissioner.js).
// It is a plain script that sets globalThis.LISTING, so it works in a browser <script> tag and as an import.
//
// A service has projects; a project has sessions. A session is the project at a venue on a day and time, or for a
// group of its own (such as Raise Your Game's two age groups). Projects and sessions can have four optional dates.
// A session uses its project's date when it has none of its own. Blank dates mean ongoing.
//   - After "runsTo" or "referralsUntil": closed. Not suggested and not shown.
//   - "referralsFrom" in the future, within SOON_DAYS: suggested if it fits, marked "Referrals open from ...".
//   - "referralsFrom" further ahead: not suggested; the AI only mentions it if someone asks for it by name.
// A service is shown when it is taking referrals ("open") and at least one project or session is.
//
// A session "for a group" has its own age, eligibility or "essential" criteria: the AI says which of those fit the
// person, and only those are shown. Other sessions are times and places, all shown, the ones the AI named first.
(() => {
  'use strict';

  const SOON_DAYS = 31;
  const REMIND_DAYS = 30;
  // Character limits shown on the forms. Longer text already in the data is kept and flagged, never cut.
  const LIMITS = { whoFor: 300, projectOverview: 400, orgOverview: 300, coachNotes: 500 };
  const DATE_KEYS = ['runsFrom', 'runsTo', 'referralsFrom', 'referralsUntil'];

  // How a project runs. A project can do more than one.
  const RUNS = { set: 'At set times and places', appointment: 'By appointment, or around the person', online: 'Online or by phone' };
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const FREQUENCY = { weekly: 'every week', fortnightly: 'every other week', monthly: 'once a month', once: 'one time only', varies: 'dates vary' };
  // "Who it's for": the groups a service is specifically for, so services can be counted and filtered. Words as the
  // team agreed (November 2026); "everyone" means no restriction.
  const GROUPS = {
    everyone: 'Everyone (no restriction)',
    children: 'Children (0 to 11)',
    'young-people': 'Young people (12 to 18)',
    'young-adults': 'Young adults (16 to 25)',
    adults: 'Adults (18+)',
    'adults-50': 'Adults 50 and over',
    'older-people': 'Older people (65+)',
    families: 'Families',
    parents: 'Parents',
    mothers: 'Mothers',
    fathers: 'Fathers',
    women: 'Women',
    men: 'Men',
    carers: 'Carers',
    disabled: 'Disabled people',
    'health-condition': 'People with a health condition',
    'mental-health': 'People with mental ill health',
    refugees: 'Refugees and migrants',
    'ethnic-minority': 'Ethnic minority communities',
    lgbtq: 'LGBTQ+ people',
    students: 'Students',
    veterans: 'Veterans',
  };

  const today = () => new Date().toISOString().slice(0, 10);
  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const longDate = (iso) => (iso ? Number(iso.slice(8, 10)) + ' ' + MONTHS[Number(iso.slice(5, 7)) - 1] + ' ' + iso.slice(0, 4) : '');

  // A session's dates: its own, or its project's where it has none.
  function datesOf(project, session) {
    const d = {};
    for (const k of DATE_KEYS) {
      const v = (session && session[k]) || (project && project[k]);
      if (v) d[k] = v;
    }
    return d;
  }

  // 'open', 'soon' (referrals open within SOON_DAYS), 'later' (further ahead) or 'closed'.
  function state(dates, on) {
    const t = on || today();
    if ((dates.runsTo && dates.runsTo < t) || (dates.referralsUntil && dates.referralsUntil < t)) return 'closed';
    if (dates.referralsFrom && dates.referralsFrom > t) return dates.referralsFrom <= addDays(t, SOON_DAYS) ? 'soon' : 'later';
    return 'open';
  }
  const showable = (st) => st === 'open' || st === 'soon';
  // A session for a group of its own (rather than just a time and place).
  const forGroup = (s) => Boolean(s && (s.age || (s.eligibility || []).length || (s.gate || []).length));

  // Every project and session with its state. A project with sessions takes the best state of its sessions.
  const RANK = { open: 3, soon: 2, later: 1, closed: 0 };
  function parts(service, on) {
    return (service.projects || []).map((p) => {
      const sessions = (p.sessions || []).map((s) => {
        const dates = datesOf(p, s);
        return { session: s, dates, state: state(dates, on) };
      });
      const own = datesOf(p, null);
      const st = sessions.length ? sessions.reduce((best, s) => (RANK[s.state] > RANK[best] ? s.state : best), 'closed') : state(own, on);
      return { project: p, dates: own, state: st, sessions };
    });
  }

  // What can be suggested and shown today: projects (and their sessions) that are open or opening soon.
  function visible(service, on) {
    return parts(service, on)
      .filter((x) => showable(x.state))
      .map((x) => ({ ...x, sessions: x.sessions.filter((s) => showable(s.state)) }));
  }
  const isShown = (service, on) => service.open === true && visible(service, on).length > 0;

  // The ids of what is visible today (projects and sessions), for checking which ones the AI said fit.
  function visibleIds(service, on) {
    const ids = new Set();
    for (const x of visible(service, on)) {
      ids.add(x.project.id);
      for (const s of x.sessions) ids.add(s.session.id);
    }
    return ids;
  }

  // Of the parts the AI said fit, which projects and sessions to show. Nothing named (or nothing valid) shows all.
  // Naming a project shows it with all its sessions. Naming a session shows its project; sessions for a group of
  // their own that weren't named are left out (a 20-year-old doesn't see the 50+ group), times and places stay.
  // Named sessions come first, marked "named".
  function pick(service, ids, on) {
    const vis = visible(service, on);
    const want = new Set((ids || []).filter((id) => typeof id === 'string'));
    const named = vis.filter((x) => want.has(x.project.id) || x.sessions.some((s) => want.has(s.session.id)));
    if (!named.length) return vis;
    return named.map((x) => {
      if (want.has(x.project.id)) return x;
      const keep = x.sessions.filter((s) => want.has(s.session.id) || !forGroup(s.session)).map((s) => ({ ...s, named: want.has(s.session.id) }));
      return { ...x, sessions: [...keep.filter((s) => s.named), ...keep.filter((s) => !s.named)] };
    });
  }

  // Projects and sessions whose end date or referral close date is within REMIND_DAYS (today included). A session
  // with no dates of its own is covered by its project.
  function endingSoon(service, on, days = REMIND_DAYS) {
    const t = on || today();
    const out = [];
    const check = (project, session, dates) => {
      for (const [k, kind] of [['referralsUntil', 'referrals close'], ['runsTo', 'ends']]) {
        const d = dates[k];
        if (d && d >= t && daysBetween(t, d) <= days) out.push({ service, project, session, kind, date: d, daysLeft: daysBetween(t, d) });
      }
    };
    for (const p of service.projects || []) {
      check(p, null, datesOf(p, null));
      for (const s of p.sessions || []) {
        const own = {};
        for (const k of DATE_KEYS) if (s[k]) own[k] = s[k];
        check(p, s, own);
      }
    }
    return out;
  }
  // Projects and sessions that have closed (end or referral close date passed).
  function closedParts(service, on) {
    const out = [];
    for (const x of parts(service, on)) {
      if (x.state === 'closed') out.push({ project: x.project, session: null, dates: x.dates });
      else for (const s of x.sessions) if (s.state === 'closed') out.push({ project: x.project, session: s.session, dates: s.dates });
    }
    return out;
  }

  // Plain words for a set of dates, for cards, the directory and the AI.
  function dateWords(dates, on) {
    const t = on || today();
    const w = [];
    if (dates.referralsFrom && dates.referralsFrom > t) w.push('Referrals open from ' + longDate(dates.referralsFrom));
    if (dates.referralsUntil) w.push('Taking referrals until ' + longDate(dates.referralsUntil));
    if (dates.runsFrom && dates.runsTo) w.push((dates.runsFrom > t ? 'Runs ' : 'Running ') + longDate(dates.runsFrom) + ' to ' + longDate(dates.runsTo));
    else if (dates.runsFrom && dates.runsFrom > t) w.push('Starts ' + longDate(dates.runsFrom));
    else if (dates.runsTo) w.push('Runs until ' + longDate(dates.runsTo));
    return w;
  }

  // "1pm", "1.30pm", "10am" from "13:00", "13:30", "10:00".
  function clock(hhmm) {
    if (!/^\d\d:\d\d$/.test(hhmm || '')) return '';
    const h = Number(hhmm.slice(0, 2));
    const m = hhmm.slice(3);
    const h12 = h % 12 || 12;
    return h12 + (m === '00' ? '' : '.' + m) + (h < 12 ? 'am' : 'pm');
  }
  // "Tuesdays and Thursdays, 1pm to 3pm, every other week" (or "" when no day or time is given).
  function timeWords(s) {
    const days = (s.days || []).filter((d) => DAY_NAMES[d]);
    const parts2 = [];
    if (days.length === 5 && ['mon', 'tue', 'wed', 'thu', 'fri'].every((d) => days.includes(d))) parts2.push('Monday to Friday');
    else if (days.length) {
      const names = days.map((d) => DAY_NAMES[d] + (s.frequency === 'once' ? '' : 's'));
      parts2.push(names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0]);
    }
    if (s.start && s.end) parts2.push(clock(s.start) + ' to ' + clock(s.end));
    else if (s.start) parts2.push('from ' + clock(s.start));
    if (s.frequency && s.frequency !== 'weekly' && FREQUENCY[s.frequency]) parts2.push(FREQUENCY[s.frequency]);
    return parts2.join(', ');
  }
  // A venue's name and address on one line ("Jo Cox House, Market Square, Batley, WF17 5DR").
  function venueLine(v) {
    if (!v) return '';
    const addr = v.address && v.address.toLowerCase().startsWith(v.name.toLowerCase()) ? v.address : [v.name, v.address].filter(Boolean).join(', ');
    return v.postcode && !addr.toUpperCase().replace(/\s/g, '').includes(v.postcode.replace(/\s/g, '')) ? addr + ', ' + v.postcode : addr;
  }
  // Sort sessions by day then start time (sessions with no day last).
  function byDay(a, b) {
    const da = (a.days || [])[0];
    const db = (b.days || [])[0];
    const ia = da ? DAYS.indexOf(da) : 9;
    const ib = db ? DAYS.indexOf(db) : 9;
    return ia - ib || String(a.start || '').localeCompare(String(b.start || ''));
  }

  // Every venue id a service uses (its own and its sessions').
  function venueIds(service) {
    const ids = new Set(service.venues || []);
    for (const p of service.projects || []) for (const s of p.sessions || []) if (s.venue) ids.add(s.venue);
    return [...ids];
  }

  // Checks a project list's ids and dates. Returns a list of plain-English problems (empty when fine).
  function checkParts(projects) {
    const problems = [];
    const seen = new Set();
    const id = (x, what) => {
      if (seen.has(x.id)) problems.push(`${what} id "${x.id}" is used twice in this service`);
      seen.add(x.id);
    };
    const order = (d, what) => {
      if (d.runsFrom && d.runsTo && d.runsFrom > d.runsTo) problems.push(`${what} ends before it starts`);
      if (d.referralsFrom && d.referralsUntil && d.referralsFrom > d.referralsUntil) problems.push(`${what} stops taking referrals before it starts`);
    };
    for (const p of projects || []) {
      id(p, 'Project');
      order(p, `"${p.name}"`);
      for (const s of p.sessions || []) {
        id(s, 'Session');
        const label = `"${p.name}: ${s.name || timeWords(s) || 'a session'}"`;
        order(datesOf(p, s), label);
        if (s.start && s.end && s.start >= s.end) problems.push(`${label} finishes before it starts`);
      }
    }
    return problems;
  }

  globalThis.LISTING = {
    SOON_DAYS, REMIND_DAYS, LIMITS, DATE_KEYS, RUNS, DAYS, DAY_NAMES, FREQUENCY, GROUPS,
    today, addDays, daysBetween, longDate, datesOf, state, forGroup, parts, visible, isShown, visibleIds, pick, endingSoon, closedParts,
    dateWords, clock, timeWords, venueLine, byDay, venueIds, checkParts,
  };
})();
