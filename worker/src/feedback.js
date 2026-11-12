// User feedback: "Report a problem with this listing", "Was this helpful?", "Tell us what's missing" and, during
// the pilot, the fuller "Give pilot feedback" form (kind 'pilot', only accepted when PILOT_FEEDBACK is "true").
//
// Stored in its own Durable Object (SQLite-backed), separate from the team log, so it keeps working when the
// team log is switched off for the wider test.
//
//   POST  /feedback                 public (same origin, size, rate limit and daily cap checks as /chat)
//   GET   /feedback/items           passcode: all entries, optionally ?status=New and/or ?since=YYYY-MM-DD
//   PATCH /feedback/items/:id       passcode: change the status or add a short reviewer note
//   GET   /feedback/export.csv      passcode: everything as CSV
//
// The read routes are protected by the Worker secret TEAM_PASSCODE, the one team passcode for the Admin pages. If it is not set they return 404, but
// people can still send feedback. Sending is on unless the variable FEEDBACK_ENABLED is "false".
//
// What is stored is deliberately small: no IP address, no user agent, no time of day, nothing from the
// conversation. Free text has email addresses, phone numbers, postcodes and National Insurance numbers removed
// before it is saved, even though the page asks people not to include them. Entries are deleted after 12 months.
// The one exception is a pilot tester's own name and work email, kept only when they tick "You can contact me",
// so the team can follow up with them. Those are about the tester, never about anyone they were helping.
//
// Every new entry, apart from a plain "Yes, it was helpful", is also emailed to the team inbox (notify.js).

import { notifyFeedback } from './notify.js';

export const KINDS = ['card', 'reply', 'gap', 'pilot'];
export const STATUSES = ['New', 'Reviewed', 'Actioned', 'Not actioned'];
export const REASONS = {
  // "Report a problem with this listing" on a scheme card
  card: ['closed', 'contact-wrong', 'eligibility-wrong', 'no-reply', 'not-in-area', 'missing-details', 'other'],
  // "No" under a reply
  reply: ['none-fit', 'info-wrong', 'hard-to-understand', 'missed-service'],
  // "Tell us what's missing"
  gap: ['missing-service', 'missing-support', 'missing-other'],
  // "Give pilot feedback": which best describes it (one only)
  pilot: ['found-useful', 'missed-service', 'unsuitable', 'hard-to-use', 'broken', 'idea', 'other'],
};
export const CONTACTED = ['yes', 'no', 'not-yet', 'not-applicable'];
const LANGS = ['en', 'pl', 'ur'];
const MODES = ['public', 'staff'];
export const DONT_KNOW = "Don't know";
export const SOMETHING_ELSE = 'Something else';
const MAX_TEXT = 300;
const MAX_PILOT_TEXT = 1500;
const MAX_EMAIL = 200;
const MAX_NAME = 100;
const MAX_WEBSITE = 200;
const MAX_NOTE = 500;
const MAX_BODY = 4096;
// A suggested service with all its details can be longer than other feedback.
const MAX_BODY_GAP = 16384;
const RETENTION_MONTHS = 12;
// The fields each kind of entry may send. Anything else is rejected.
const ALLOWED = {
  card: ['kind', 'schemeIds', 'recordLastUpdated', 'reasons', 'text', 'lang', 'mode'],
  reply: ['kind', 'schemeIds', 'helpful', 'reasons', 'text', 'lang', 'mode'],
  gap: ['kind', 'reasons', 'text', 'missedService', 'gapCategories', 'gapArea', 'lang', 'mode'],
  pilot: ['kind', 'reasons', 'text', 'schemeIds', 'contacted', 'ease', 'contact', 'lang', 'mode'],
};
const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}$/i;

// ---------- removing personal details ----------
// The page has a copy of these patterns (site/feedback.js) so it can warn people and remove them before sending.
// Keep the two in step: worker/test/logic.mjs checks that they match.
export const REDACT_PATTERNS = [
  // Email addresses
  /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi,
  // National Insurance numbers, for example QQ 12 34 56 C
  /\b[A-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/gi,
  // UK postcodes, for example HD1 4EW or WF135AB. A district on its own (HD1) is left alone.
  /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/gi,
  // UK phone numbers: 07700 900123, 01484 123456, (01484) 123456, 0800-123-4567, +44 7700 900123, +44 (0)1484 123456
  /(?:(?:\+|\b00)44[ -]?(?:\(0\)[ -]?)?|\(?\b0)\d{2,4}\)?(?:[ -]?\d){5,8}\b/g,
];

// Replaces personal details in a piece of free text with [removed]. Returns the new text and whether anything changed.
export function redact(text) {
  let out = String(text == null ? '' : text);
  for (const re of REDACT_PATTERNS) out = out.replace(re, '[removed]');
  return { text: out, redacted: out !== String(text == null ? '' : text) };
}

// ---------- checking what the page sent ----------
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const today = () => new Date().toISOString().slice(0, 10);

// Optional free text: trimmed, and rejected (rather than cut short) if it is too long, so nothing is silently lost.
function optText(v, max, label) {
  if (v === undefined || v === null || v === '') return { value: '' };
  if (typeof v !== 'string') return { error: `${label} must be text.` };
  const value = v.trim();
  if (value.length > max) return { error: `${label} is too long (${max} characters at most).` };
  return { value };
}

function list(v, allowed, label, { min = 0, max = allowed.length } = {}) {
  if (v === undefined) v = [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return { error: `${label} must be a list.` };
  const value = [...new Set(v)];
  const bad = value.filter((x) => !allowed.includes(x));
  if (bad.length) return { error: `${label} has a value we don't recognise.` };
  if (value.length < min) return { error: min === 1 ? `Please choose at least one ${label.toLowerCase()}.` : `${label} needs at least ${min}.` };
  if (value.length > max) return { error: `${label} has too many values.` };
  return { value };
}

// ---------- a suggested service's details ----------
// The questions a suggestion can answer. They match a listing (organisation > service > project), so the team can
// turn a suggestion into a listing in Admin without retyping. The older names (description, activities, running,
// dates, addresses) are still accepted from a page loaded before November 2026, and labelled on the review page.
export const SERVICE_FIELDS = ['name', 'website', 'area', 'role', 'organisation', 'organisationOverview', 'addTo', 'whoFor', 'open', 'projectName', 'projectOverview', 'where', 'when', 'duration', 'places',
  'runsFrom', 'runsTo', 'referralsFrom', 'referralsUntil', 'age', 'eligibility', 'gate', 'exclusions', 'healthNeed', 'conditions', 'audience', 'categories', 'noMap', 'level', 'phone', 'email', 'social',
  'referral', 'selfReferral', 'cost', 'languages', 'workExperience', 'coachNotes', 'logoOk', 'contactName', 'projects', 'groups',
  'description', 'activities', 'running', 'dates', 'addresses'];
const SERVICE_TEXT = {
  organisation: 150, organisationOverview: 300, whoFor: 300, projectName: 150, projectOverview: 400, where: 500, when: 150, duration: 150, places: 60,
  age: 60, eligibility: 800, gate: 500, exclusions: 500, conditions: 300, phone: 80, email: 150, social: 300, referral: 600, cost: 200, languages: 200, workExperience: 300,
  coachNotes: 500, contactName: 100,
  description: 800, activities: 1200, dates: 150, addresses: 500,
};
const SERVICE_DATES = ['runsFrom', 'runsTo', 'referralsFrom', 'referralsUntil'];
const SERVICE_CHOICES = { role: ['provider', 'suggester'], open: ['yes', 'no'], running: ['now', 'paused', 'soon', 'ended'], healthNeed: ['none', 'any', 'specific'], level: ['local', 'regional', 'national'], selfReferral: ['yes', 'partly', 'no'] };
const AUDIENCES = ['individual', 'employer', 'organisation', 'student'];
const LABELS = {
  organisation: 'The organisation', organisationOverview: 'About the organisation', whoFor: 'Who the service is for', projectName: 'The project name', projectOverview: 'What happens in the project',
  where: 'Where it runs', when: 'The days and times', duration: 'How long it lasts', places: 'The number of places', age: 'The age range', eligibility: 'Who can use it', gate: 'What you would turn someone away for not having',
  exclusions: "Who it isn't for", conditions: 'The conditions', phone: 'The phone number', email: 'The email address', social: 'Social media', referral: 'How people get referred', cost: 'The cost',
  languages: 'The languages', workExperience: 'Work experience', coachNotes: 'What coaches should know', contactName: 'The contact name',
  description: 'The description', activities: 'What happens', dates: 'The dates', addresses: 'The addresses',
};

// The projects in a suggestion: [{ name, overview, online, appointment, duration, places, dates, sessions: [{ where,
// day, start, end }] }]. Only short text, choices and dates: the team turns them into a listing in Admin.
const DAY_IDS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const GROUP_IDS = ['everyone', 'children', 'young-people', 'young-adults', 'adults', 'adults-50', 'older-people', 'families', 'parents', 'mothers', 'fathers', 'women', 'men', 'carers', 'disabled', 'health-condition', 'mental-health', 'refugees', 'ethnic-minority', 'lgbtq', 'students', 'veterans'];
function suggestedProjects(v) {
  if (!Array.isArray(v) || v.length > 10) return { error: 'You can tell us about up to 10 projects.' };
  const out = [];
  for (const p of v) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: 'The project details could not be read.' };
    const bad = Object.keys(p).find((k) => !['name', 'overview', 'online', 'appointment', 'duration', 'places', 'sessions', ...SERVICE_DATES].includes(k));
    if (bad) return { error: 'The project details could not be read.' };
    const one = {};
    for (const [k, max, label] of [['name', 150, 'The project name'], ['overview', 400, 'What happens in the project'], ['duration', 150, 'How long it lasts'], ['places', 60, 'The number of places']]) {
      const t = optText(p[k], max, label);
      if (t.error) return t;
      if (t.value) one[k] = t.value;
    }
    for (const k of ['online', 'appointment']) {
      if (p[k] === undefined || p[k] === false) continue;
      if (p[k] !== true) return { error: 'The project details could not be read.' };
      one[k] = true;
    }
    for (const k of SERVICE_DATES) {
      if (p[k] === undefined || p[k] === null || p[k] === '') continue;
      if (typeof p[k] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p[k]) || Number.isNaN(Date.parse(p[k]))) return { error: 'Please give the dates as day, month and year.' };
      one[k] = p[k];
    }
    if ((one.runsFrom && one.runsTo && one.runsFrom > one.runsTo) || (one.referralsFrom && one.referralsUntil && one.referralsFrom > one.referralsUntil)) return { error: 'One of the end dates is before its start date.' };
    if (p.sessions !== undefined && p.sessions !== null) {
      if (!Array.isArray(p.sessions) || p.sessions.length > 20) return { error: 'You can give up to 20 venues or days for each project.' };
      const ss = [];
      for (const x of p.sessions) {
        if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some((k) => !['where', 'day', 'start', 'end'].includes(k))) return { error: 'The venue details could not be read.' };
        const se = {};
        const w = optText(x.where, 300, 'The venue and address');
        if (w.error) return w;
        if (w.value) se.where = w.value;
        if (x.day !== undefined && x.day !== '' && x.day !== null) {
          if (!DAY_IDS.includes(x.day)) return { error: 'Please choose a day from the list.' };
          se.day = x.day;
        }
        for (const k of ['start', 'end']) {
          if (x[k] === undefined || x[k] === '' || x[k] === null) continue;
          if (typeof x[k] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x[k])) return { error: 'Please give the times like 10:30.' };
          se[k] = x[k];
        }
        if (se.start && se.end && se.start >= se.end) return { error: 'One of the finishing times is before its start time.' };
        if (Object.keys(se).length) ss.push(se);
      }
      if (ss.length) one.sessions = ss;
    }
    if (Object.keys(one).length) out.push(one);
  }
  return { value: out };
}

function serviceDetails(ms, ctx) {
  const out = {};
  for (const [k, max] of Object.entries(SERVICE_TEXT)) {
    const v = optText(ms[k], max, LABELS[k]);
    if (v.error) return v;
    if (v.value) out[k] = v.value;
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) return { error: 'The email address doesn\'t look right.' };
  for (const [k, allowed] of Object.entries(SERVICE_CHOICES)) {
    if (ms[k] === undefined || ms[k] === null || ms[k] === '') continue;
    if (!allowed.includes(ms[k])) return { error: 'Please choose from the list.' };
    out[k] = ms[k];
  }
  for (const k of SERVICE_DATES) {
    if (ms[k] === undefined || ms[k] === null || ms[k] === '') continue;
    if (typeof ms[k] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ms[k]) || Number.isNaN(Date.parse(ms[k]))) return { error: 'Please give the dates as day, month and year.' };
    out[k] = ms[k];
  }
  if ((out.runsFrom && out.runsTo && out.runsFrom > out.runsTo) || (out.referralsFrom && out.referralsUntil && out.referralsFrom > out.referralsUntil)) return { error: 'One of the end dates is before its start date.' };
  // "A new project of a service we already list": one of the services in the data.
  // Projects (from November 2026): any number, each with its places, days and times.
  if (ms.projects !== undefined && ms.projects !== null) {
    const r = suggestedProjects(ms.projects);
    if (r.error) return r;
    if (r.value.length) out.projects = r.value;
  }
  if (ms.groups !== undefined && ms.groups !== null) {
    if (!Array.isArray(ms.groups) || ms.groups.length > 30 || ms.groups.some((g) => typeof g !== 'string' || !GROUP_IDS.includes(g))) return { error: 'Please choose from the list.' };
    if (ms.groups.length) out.groups = [...new Set(ms.groups)];
  }
  if (ms.addTo !== undefined && ms.addTo !== null && ms.addTo !== '') {
    if (typeof ms.addTo !== 'string' || !(ctx.ids && ctx.ids.has(ms.addTo))) return { error: 'Please choose a service from the list.' };
    out.addTo = ms.addTo;
  }
  for (const k of ['noMap', 'logoOk']) {
    if (ms[k] === undefined || ms[k] === false) continue;
    if (ms[k] !== true) return { error: 'The service details could not be read.' };
    out[k] = true;
  }
  const aud = list(ms.audience, AUDIENCES, 'Who it is for');
  if (aud.error) return aud;
  if (aud.value.length) out.audience = aud.value;
  const cats = list(ms.categories, ctx.categories, 'Kind of support');
  if (cats.error) return cats;
  if (cats.value.length) out.categories = cats.value;
  return { value: out };
}

// Checks a feedback entry from the page. `ctx` holds the scheme ids and the areas and categories in the data.
// Returns { entry } ready to store, or { error } in plain English.
export function validateFeedback(body, ctx, { pilot = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'That feedback could not be read.' };
  const kind = body.kind;
  if (!KINDS.includes(kind) || (kind === 'pilot' && !pilot)) return { error: 'Unknown kind of feedback.' };
  const extra = Object.keys(body).filter((k) => !ALLOWED[kind].includes(k));
  if (extra.length) return { error: 'That feedback has a field we don\'t expect.' };
  if (!LANGS.includes(body.lang)) return { error: 'Unknown language.' };
  if (!MODES.includes(body.mode)) return { error: 'Unknown mode.' };

  const reasons = list(body.reasons, REASONS[kind], 'Reason', { min: kind === 'reply' ? 0 : 1, max: kind === 'pilot' ? 1 : undefined });
  if (reasons.error) return reasons;
  const text = optText(body.text, kind === 'pilot' ? MAX_PILOT_TEXT : MAX_TEXT, 'The comment');
  if (text.error) return text;
  if (kind === 'pilot' && !text.value) return { error: 'Please tell us what happened.' };

  const entry = {
    kind,
    date: today(),
    schemeIds: [],
    recordLastUpdated: null,
    helpful: null,
    reasons: reasons.value,
    text: text.value,
    missedService: null,
    gapCategories: [],
    gapArea: null,
    contacted: null,
    ease: null,
    contact: null,
    lang: body.lang,
    mode: body.mode,
    site: ctx.site || 'live',
    redacted: false,
    status: 'New',
    note: '',
  };

  if (kind === 'card' || kind === 'reply') {
    const ids = body.schemeIds;
    const max = kind === 'card' ? 1 : 5;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > max || ids.some((x) => typeof x !== 'string' || !ctx.ids.has(x))) {
      return { error: 'That feedback is about a scheme we don\'t know.' };
    }
    entry.schemeIds = [...new Set(ids)];
  }

  if (kind === 'pilot') {
    // The schemes shown in the most recent reply, if there was one. Optional.
    const ids = body.schemeIds === undefined ? [] : body.schemeIds;
    if (!Array.isArray(ids) || ids.length > 5 || ids.some((x) => typeof x !== 'string' || !ctx.ids.has(x))) {
      return { error: 'That feedback is about a scheme we don\'t know.' };
    }
    entry.schemeIds = [...new Set(ids)];
    if (body.contacted !== undefined && body.contacted !== null) {
      if (!CONTACTED.includes(body.contacted)) return { error: 'Please choose an answer from the list.' };
      entry.contacted = body.contacted;
    }
    if (body.ease !== undefined && body.ease !== null) {
      if (!Number.isInteger(body.ease) || body.ease < 1 || body.ease > 5) return { error: 'Ease of use must be from 1 to 5.' };
      entry.ease = body.ease;
    }
    const c = body.contact;
    if (c !== undefined && c !== null) {
      if (typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some((k) => !['name', 'email'].includes(k))) return { error: 'The contact details could not be read.' };
      const name = optText(c.name, MAX_NAME, 'Your name');
      if (name.error) return name;
      const email = optText(c.email, MAX_EMAIL, 'Your email');
      if (email.error) return email;
      if (!email.value || !EMAIL_RE.test(email.value)) return { error: 'Please give an email address we can contact you on.' };
      entry.contact = { name: name.value, email: email.value };
    }
  }

  if (kind === 'card') {
    if (!isDate(body.recordLastUpdated)) return { error: 'The date the listing was last checked is missing or not a date.' };
    entry.recordLastUpdated = body.recordLastUpdated;
  }

  if (kind === 'reply') {
    if (typeof body.helpful !== 'boolean') return { error: 'Please say whether this was helpful.' };
    entry.helpful = body.helpful;
    if (body.helpful && (entry.reasons.length || entry.text)) return { error: 'Reasons and comments go with "No" only.' };
  }

  if (kind === 'gap') {
    const ms = body.missedService;
    if (ms !== undefined && ms !== null) {
      if (!entry.reasons.includes('missing-service')) return { error: 'Service details go with "A service you know about".' };
      if (typeof ms !== 'object' || Array.isArray(ms) || Object.keys(ms).some((k) => !SERVICE_FIELDS.includes(k))) return { error: 'The service details could not be read.' };
      const name = optText(ms.name, MAX_NAME, 'The service name');
      if (name.error) return name;
      if (!name.value) return { error: 'Please give the name of the service.' };
      const website = optText(ms.website, MAX_WEBSITE, 'The website');
      if (website.error) return website;
      if (website.value && !/^https?:\/\/[^\s/?#]+\.[^\s/?#]+[^\s]*$/i.test(website.value)) return { error: 'The website must start with http:// or https://.' };
      const area = optText(ms.area, 40, 'The area');
      if (area.error) return area;
      if (area.value && area.value !== DONT_KNOW && !ctx.areas.includes(area.value)) return { error: 'Please choose an area from the list.' };
      entry.missedService = { name: name.value, website: website.value, area: area.value };
      // The fuller details a service (or someone who knows it) can add. All optional; checked against fixed
      // lists and length limits. They describe the service, so they are kept as written (see below).
      const more = serviceDetails(ms, ctx);
      if (more.error) return more;
      Object.assign(entry.missedService, more.value);
      // Whether they are from the service or suggesting it decides which questions the page shows, so it is needed.
      if (!entry.missedService.role) return { error: 'Please say whether you are from the service or suggesting it.' };
      if (!entry.missedService.organisation) return { error: 'Please give the name of the organisation that runs it.' };
      if (entry.missedService.conditions && entry.missedService.healthNeed !== 'specific') return { error: 'Conditions go with "Yes, a specific condition".' };
    } else if (entry.reasons.includes('missing-service')) {
      return { error: 'Please give the name of the service.' };
    }
    const cats = list(body.gapCategories, [...ctx.categories, SOMETHING_ELSE], 'Kind of support');
    if (cats.error) return cats;
    if (cats.value.length && !entry.reasons.includes('missing-support')) return { error: 'Kinds of support go with "A kind of support you looked for".' };
    entry.gapCategories = cats.value;
    if (body.gapArea !== undefined && body.gapArea !== null && body.gapArea !== '') {
      if (typeof body.gapArea !== 'string' || (body.gapArea !== DONT_KNOW && !ctx.areas.includes(body.gapArea))) return { error: 'Please choose an area from the list.' };
      if (!entry.reasons.includes('missing-support')) return { error: 'The area goes with "A kind of support you looked for".' };
      entry.gapArea = body.gapArea;
    }
  }

  // Remove personal details from every piece of free text. The page removes them too, and marks where it did
  // with [removed], so that also counts.
  const scrub = (v) => {
    const r = redact(v);
    if (r.redacted || r.text.includes('[removed]')) entry.redacted = true;
    return r.text;
  };
  // The service's own details (its name, website, phone, email, address and so on) are about the service, not a
  // person, so they are kept as written. The page says so beside them and asks people not to include anything
  // about the people who use the service.
  // The service name is still checked: a name never needs a phone number or email in it.
  entry.text = scrub(entry.text);
  if (entry.missedService) entry.missedService.name = scrub(entry.missedService.name);
  return { entry };
}

// ---------- the store ----------
const pad = (id) => 'fb:' + String(id).padStart(7, '0');

// The oldest date kept: anything dated before this is deleted.
export function retentionCutoff(now = new Date()) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - RETENTION_MONTHS);
  return d.toISOString().slice(0, 10);
}

export class FeedbackStore {
  constructor(ctx) {
    this.ctx = ctx;
  }

  // Delete entries older than 12 months. Runs on every write and every read, so nothing older is ever returned.
  // Entries are numbered in the order they arrive, so the oldest come first and it can stop at the first one
  // that is still in date.
  async purge() {
    const s = this.ctx.storage;
    const cutoff = retentionCutoff();
    let removed = 0;
    for (;;) {
      const batch = [...(await s.list({ prefix: 'fb:', limit: 100 })).entries()];
      const old = batch.filter(([, v]) => !v.date || v.date < cutoff).map(([k]) => k);
      if (old.length) await s.delete(old);
      removed += old.length;
      if (old.length < batch.length || batch.length < 100) return removed;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json();
    const s = this.ctx.storage;

    if (url.pathname === '/add') {
      // Global daily cap, counted here so the count and the entries live together.
      const day = today();
      let n = (await s.get('day')) === day ? (await s.get('n')) || 0 : 0;
      n += 1;
      await s.put({ day, n });
      if (n > body.max) return Response.json({ capped: true });
      await this.purge();
      const id = ((await s.get('seq')) || 0) + 1;
      await s.put('seq', id);
      await s.put(pad(id), { id, ...body.entry });
      return Response.json({ id });
    }

    if (url.pathname === '/list') {
      await this.purge();
      const items = [...(await s.list({ prefix: 'fb:' })).values()];
      return Response.json({ items: items.filter((x) => (!body.status || x.status === body.status) && (!body.since || x.date >= body.since)) });
    }

    if (url.pathname === '/update') {
      const key = pad(body.id);
      const item = await s.get(key);
      if (!item) return Response.json({ error: 'Not found.' }, { status: 404 });
      if (body.status) item.status = body.status;
      if (body.note !== undefined) item.note = body.note;
      await s.put(key, item);
      return Response.json({ item });
    }

    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
}

// ---------- the HTTP side (called from the Worker's fetch) ----------
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
  });
}

// Compare passcodes without leaking timing: hash both, then compare the hashes (the same method as the team log).
export async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export const feedbackOn = (env) => env.FEEDBACK_ENABLED !== 'false' && Boolean(env.FEEDBACK_STORE);
// The "Give pilot feedback" form: on only where PILOT_FEEDBACK is exactly "true" (the preview, for now).
export const pilotOn = (env) => feedbackOn(env) && env.PILOT_FEEDBACK === 'true';

const CSV_COLUMNS = ['id', 'date', 'kind', 'status', 'schemeIds', 'recordLastUpdated', 'helpful', 'reasons', 'text', 'missedServiceName', 'missedServiceWebsite', 'missedServiceArea', 'missedServiceDetails', 'gapCategories', 'gapArea', 'contacted', 'ease', 'contactName', 'contactEmail', 'lang', 'mode', 'site', 'team', 'redacted', 'note'];
function csv(items) {
  // A leading = + - @ would be run as a formula by a spreadsheet, so it gets a ' in front.
  const cell = (v) => {
    let s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const rows = items.map((x) => {
    const ms = x.missedService || {};
    // Projects are a list of objects: written out in words, one project after another.
    const words = (v) => (Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? Object.entries(x).map(([a, b]) => a + ' ' + words(b)).join(', ') : x)).join('; ') : v && typeof v === 'object' ? JSON.stringify(v) : v);
    const details = Object.entries(ms).filter(([k]) => !['name', 'website', 'area'].includes(k)).map(([k, v]) => k + ': ' + words(v)).join(' | ');
    const ct = x.contact || {};
    const row = { ...x, missedServiceName: ms.name, missedServiceWebsite: ms.website, missedServiceArea: ms.area, missedServiceDetails: details, contactName: ct.name, contactEmail: ct.email };
    return CSV_COLUMNS.map((c) => cell(row[c])).join(',');
  });
  return [CSV_COLUMNS.map(cell).join(','), ...rows].join('\r\n') + '\r\n';
}

// ctx: { ids: Set of scheme ids, names: Map id -> name, areas: [...], categories: [...] }, worked out from the
// data by index.js. exec is the Worker's execution context, so the email can be sent after the reply.
// Admin test mode: the finder sends the team passcode in an X-Team-Test header (or, for usage events, a "t" field)
// when an Admin has opened it in test mode. Searches, events and feedback are then kept apart from real use, so
// they can be looked at separately on the Feedback and usage page. Without TEAM_PASSCODE nothing is ever a test.
export async function isTeamTest(value, env) {
  if (!env.TEAM_PASSCODE || typeof value !== 'string' || !value) return false;
  return safeEqual(value, env.TEAM_PASSCODE);
}

export async function handleFeedback(request, env, url, cors, originOk, ctx, exec) {
  const path = url.pathname;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const stub = () => env.FEEDBACK_STORE.get(env.FEEDBACK_STORE.idFromName('feedback'));
  const call = async (p, payload) => {
    const res = await stub().fetch('https://feedback' + p, { method: 'POST', body: JSON.stringify(payload || {}) });
    return { status: res.status, body: await res.json() };
  };

  // ----- sending feedback (public) -----
  if (path === '/feedback') {
    if (request.method !== 'POST' || !feedbackOn(env)) return json({ error: 'Not found.' }, 404, cors);
    if (!originOk) return json({ error: 'Not allowed.' }, 403, cors);
    const text = await request.text();
    if (text.length > MAX_BODY_GAP || (text.length > MAX_BODY && !/"kind"\s*:\s*"gap"/.test(text))) return json({ error: 'That feedback was too large.' }, 413, cors);
    if (env.FEEDBACK_LIMITER) {
      const { success } = await env.FEEDBACK_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'You have sent quite a lot of feedback in a short time. Please wait a minute and try again.' }, 429, cors);
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'That feedback could not be read.' }, 400, cors);
    }
    const site = env.ALLOW_SELF_ORIGIN === 'true' ? 'preview' : 'live';
    const v = validateFeedback(body, { ...ctx, site }, { pilot: pilotOn(env) });
    if (v.error) return json({ error: v.error }, 400, cors);
    if (await isTeamTest(request.headers.get('X-Team-Test'), env)) v.entry.team = true;
    const r = await call('/add', { entry: v.entry, max: Number(env.MAX_FEEDBACK_PER_DAY || 300) });
    if (r.body.capped) return json({ error: 'We have had a lot of feedback today. Please try again tomorrow.' }, 503, cors);
    // Email the team, after the entry is safely stored. A failed email never loses the feedback.
    const review = env.FEEDBACK_REVIEW_URL || (site === 'preview' ? url.origin + '/admin/feedback.html' : '');
    const mail = notifyFeedback(env, { id: r.body.id, ...v.entry }, ctx.names, review);
    if (exec && exec.waitUntil) exec.waitUntil(mail);
    else await mail;
    return json({ ok: true, redacted: v.entry.redacted }, 201, cors);
  }

  // ----- reading and triage (passcode) -----
  // Off unless the TEAM_PASSCODE secret is set. A browser on another site is refused; the digest script,
  // which sends no Origin, is allowed with the passcode.
  if (!env.TEAM_PASSCODE || !env.FEEDBACK_STORE) return json({ error: 'Not found.' }, 404, cors);
  if (request.headers.get('Origin') && !originOk) return json({ error: 'Not allowed.' }, 403, cors);
  if (env.FEEDBACK_READ_LIMITER) {
    const { success } = await env.FEEDBACK_READ_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'Too many requests. Please wait a minute.' }, 429, cors);
  }
  // The one team passcode (TEAM_PASSCODE) for all the Admin pages, the same as the log and All services pages. The old
  // X-Feedback-Passcode header name is still accepted, for scripts written before the passcodes were merged.
  const pass = request.headers.get('X-Team-Passcode') || request.headers.get('X-Feedback-Passcode') || '';
  if (!(await safeEqual(pass, env.TEAM_PASSCODE))) return json({ error: 'Wrong passcode.' }, 401, cors);

  if (request.method === 'GET' && (path === '/feedback/items' || path === '/feedback/export.csv')) {
    const status = url.searchParams.get('status');
    const since = url.searchParams.get('since');
    if (status && !STATUSES.includes(status)) return json({ error: 'Unknown status.' }, 400, cors);
    if (since && !isDate(since)) return json({ error: '"since" must be a date, YYYY-MM-DD.' }, 400, cors);
    const { body } = await call('/list', { status, since });
    if (path === '/feedback/items') return json({ items: body.items, statuses: STATUSES }, 200, cors);
    return new Response(csv(body.items), {
      status: 200,
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="support-finder-feedback-${today()}.csv"`, 'Cache-Control': 'no-store', ...cors },
    });
  }

  const m = path.match(/^\/feedback\/items\/(\d{1,9})$/);
  if (request.method === 'PATCH' && m) {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'That request was too large.' }, 413, cors);
    let body;
    try {
      body = JSON.parse(text || '{}');
    } catch {
      return json({ error: 'That request could not be read.' }, 400, cors);
    }
    const patch = {};
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return json({ error: 'Unknown status.' }, 400, cors);
      patch.status = body.status;
    }
    if (body.note !== undefined) {
      const note = optText(body.note, MAX_NOTE, 'The note');
      if (note.error) return json({ error: note.error }, 400, cors);
      patch.note = redact(note.value).text;
    }
    if (!Object.keys(patch).length) return json({ error: 'Nothing to change.' }, 400, cors);
    const r = await call('/update', { id: Number(m[1]), ...patch });
    return json(r.body, r.status === 404 ? 404 : 200, cors);
  }

  return json({ error: 'Not found.' }, 404, cors);
}
