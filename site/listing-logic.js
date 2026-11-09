// Shared rules for a listing's projects, cohorts and dates. One copy, used by:
//   the finder page (site/app.js), the provider and Admin forms (site/listing-form.js), the Worker
//   (worker/src/index.js, which imports this file), the directory PDF (scripts/build-print.mjs) and the data
//   checks (scripts/check-data.mjs).
// It is a plain script that sets globalThis.LISTING, so it works in a browser <script> tag and as an import.
//
// A service has projects; a project can have cohorts (the same project at a different time, place or for a
// different group). Each can have four optional dates. A cohort uses its project's date when it has none of its
// own. Blank dates mean ongoing.
//   - After "runsTo" or "referralsUntil": closed. Not suggested and not shown.
//   - "referralsFrom" in the future, within SOON_DAYS: suggested if it fits, marked "Referrals open from ...".
//   - "referralsFrom" further ahead: not suggested; the AI only mentions it if someone asks for it by name.
// A service is shown when it is taking referrals ("open") and at least one project or cohort is.
(() => {
  'use strict';

  const SOON_DAYS = 31;
  const REMIND_DAYS = 30;
  // Character limits shown on the forms. Longer text already in the data is kept and flagged, never cut.
  const LIMITS = { whoFor: 300, projectOverview: 400, orgOverview: 300, coachNotes: 500 };
  const DATE_KEYS = ['runsFrom', 'runsTo', 'referralsFrom', 'referralsUntil'];

  const today = () => new Date().toISOString().slice(0, 10);
  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const longDate = (iso) => (iso ? Number(iso.slice(8, 10)) + ' ' + MONTHS[Number(iso.slice(5, 7)) - 1] + ' ' + iso.slice(0, 4) : '');

  // A cohort's dates: its own, or its project's where it has none.
  function datesOf(project, cohort) {
    const d = {};
    for (const k of DATE_KEYS) {
      const v = (cohort && cohort[k]) || (project && project[k]);
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

  // Every project and cohort with its state. A project with cohorts takes the best state of its cohorts.
  const RANK = { open: 3, soon: 2, later: 1, closed: 0 };
  function parts(service, on) {
    return (service.projects || []).map((p) => {
      const cohorts = (p.cohorts || []).map((c) => {
        const dates = datesOf(p, c);
        return { cohort: c, dates, state: state(dates, on) };
      });
      const own = datesOf(p, null);
      const st = cohorts.length ? cohorts.reduce((best, c) => (RANK[c.state] > RANK[best] ? c.state : best), 'closed') : state(own, on);
      return { project: p, dates: own, state: st, cohorts };
    });
  }

  // What can be suggested and shown today: projects (and their cohorts) that are open or opening soon.
  function visible(service, on) {
    return parts(service, on)
      .filter((x) => showable(x.state))
      .map((x) => ({ ...x, cohorts: x.cohorts.filter((c) => showable(c.state)) }));
  }
  const isShown = (service, on) => service.open === true && visible(service, on).length > 0;

  // The ids of what is visible today (projects and cohorts), for checking which ones the AI said fit.
  function visibleIds(service, on) {
    const ids = new Set();
    for (const x of visible(service, on)) {
      ids.add(x.project.id);
      for (const c of x.cohorts) ids.add(c.cohort.id);
    }
    return ids;
  }

  // Of the parts the AI said fit, which projects and cohorts to show. Nothing named (or nothing valid) shows all.
  // Naming a cohort shows its project with only that cohort; naming a project shows it with all its cohorts.
  function pick(service, ids, on) {
    const vis = visible(service, on);
    const want = new Set((ids || []).filter((id) => typeof id === 'string'));
    const named = vis.filter((x) => want.has(x.project.id) || x.cohorts.some((c) => want.has(c.cohort.id)));
    if (!named.length) return vis;
    return named.map((x) => (want.has(x.project.id) ? x : { ...x, cohorts: x.cohorts.filter((c) => want.has(c.cohort.id)) }));
  }

  // Projects and cohorts whose end date or referral close date is within REMIND_DAYS (today included).
  function endingSoon(service, on, days = REMIND_DAYS) {
    const t = on || today();
    const out = [];
    const check = (project, cohort, dates) => {
      for (const [k, kind] of [['referralsUntil', 'referrals close'], ['runsTo', 'ends']]) {
        const d = dates[k];
        if (d && d >= t && daysBetween(t, d) <= days) out.push({ service, project, cohort, kind, date: d, daysLeft: daysBetween(t, d) });
      }
    };
    for (const p of service.projects || []) {
      if (p.cohorts && p.cohorts.length) for (const c of p.cohorts) check(p, c, datesOf(p, c));
      else check(p, null, datesOf(p, null));
    }
    return out;
  }
  // Projects and cohorts that have closed (end or referral close date passed).
  function closedParts(service, on) {
    const out = [];
    for (const x of parts(service, on)) {
      if (x.cohorts.length) { for (const c of x.cohorts) if (c.state === 'closed') out.push({ project: x.project, cohort: c.cohort, dates: c.dates }); }
      else if (x.state === 'closed') out.push({ project: x.project, cohort: null, dates: x.dates });
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
      for (const c of p.cohorts || []) {
        id(c, 'Cohort');
        order(datesOf(p, c), `"${p.name}: ${c.name}"`);
      }
    }
    return problems;
  }

  globalThis.LISTING = { SOON_DAYS, REMIND_DAYS, LIMITS, DATE_KEYS, today, addDays, daysBetween, longDate, datesOf, state, parts, visible, isShown, visibleIds, pick, endingSoon, closedParts, dateWords, checkParts };
})();
