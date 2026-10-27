// User feedback: "Report a problem with this listing", "Was this helpful?" and "Tell us what's missing".
//
// Stored in its own Durable Object (SQLite-backed), separate from the team log, so it keeps working when the
// team log is switched off for the wider test.
//
//   POST  /feedback                 public (same origin, size, rate limit and daily cap checks as /chat)
//   GET   /feedback/items           passcode: all entries, optionally ?status=New and/or ?since=YYYY-MM-DD
//   PATCH /feedback/items/:id       passcode: change the status or add a short reviewer note
//   GET   /feedback/export.csv      passcode: everything as CSV
//
// The read routes are protected by the Worker secret FEEDBACK_PASSCODE. If it is not set they return 404, but
// people can still send feedback. Sending is on unless the variable FEEDBACK_ENABLED is "false".
//
// What is stored is deliberately small: no IP address, no user agent, no time of day, nothing from the
// conversation. Free text has email addresses, phone numbers, postcodes and National Insurance numbers removed
// before it is saved, even though the page asks people not to include them. Entries are deleted after 12 months.

export const KINDS = ['card', 'reply', 'gap'];
export const STATUSES = ['New', 'Reviewed', 'Actioned', 'Not actioned'];
export const REASONS = {
  // "Report a problem with this listing" on a scheme card
  card: ['closed', 'contact-wrong', 'eligibility-wrong', 'no-reply', 'not-in-area', 'missing-details', 'other'],
  // "No" under a reply
  reply: ['none-fit', 'info-wrong', 'hard-to-understand', 'missed-service'],
  // "Tell us what's missing"
  gap: ['missing-service', 'missing-support', 'missing-other'],
};
const LANGS = ['en', 'pl', 'ur'];
const MODES = ['public', 'staff'];
export const DONT_KNOW = "Don't know";
export const SOMETHING_ELSE = 'Something else';
const MAX_TEXT = 300;
const MAX_NAME = 100;
const MAX_WEBSITE = 200;
const MAX_NOTE = 500;
const MAX_BODY = 4096;
const RETENTION_MONTHS = 12;
// The fields each kind of entry may send. Anything else is rejected.
const ALLOWED = {
  card: ['kind', 'schemeIds', 'recordLastUpdated', 'reasons', 'text', 'lang', 'mode'],
  reply: ['kind', 'schemeIds', 'helpful', 'reasons', 'text', 'lang', 'mode'],
  gap: ['kind', 'reasons', 'text', 'missedService', 'gapCategories', 'gapArea', 'lang', 'mode'],
};

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

// Checks a feedback entry from the page. `ctx` holds the scheme ids and the areas and categories in the data.
// Returns { entry } ready to store, or { error } in plain English.
export function validateFeedback(body, ctx) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'That feedback could not be read.' };
  const kind = body.kind;
  if (!KINDS.includes(kind)) return { error: 'Unknown kind of feedback.' };
  const extra = Object.keys(body).filter((k) => !ALLOWED[kind].includes(k));
  if (extra.length) return { error: 'That feedback has a field we don\'t expect.' };
  if (!LANGS.includes(body.lang)) return { error: 'Unknown language.' };
  if (!MODES.includes(body.mode)) return { error: 'Unknown mode.' };

  const reasons = list(body.reasons, REASONS[kind], 'Reason', { min: kind === 'reply' ? 0 : 1 });
  if (reasons.error) return reasons;
  const text = optText(body.text, MAX_TEXT, 'The comment');
  if (text.error) return text;

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
    lang: body.lang,
    mode: body.mode,
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
      if (typeof ms !== 'object' || Array.isArray(ms) || Object.keys(ms).some((k) => !['name', 'website', 'area'].includes(k))) return { error: 'The service details could not be read.' };
      const name = optText(ms.name, MAX_NAME, 'The service name');
      if (name.error) return name;
      const website = optText(ms.website, MAX_WEBSITE, 'The website');
      if (website.error) return website;
      if (website.value && !/^https?:\/\/[^\s/?#]+\.[^\s/?#]+[^\s]*$/i.test(website.value)) return { error: 'The website must start with http:// or https://.' };
      const area = optText(ms.area, 40, 'The area');
      if (area.error) return area;
      if (area.value && area.value !== DONT_KNOW && !ctx.areas.includes(area.value)) return { error: 'Please choose an area from the list.' };
      if (name.value || website.value || area.value) entry.missedService = { name: name.value, website: website.value, area: area.value };
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
  entry.text = scrub(entry.text);
  if (entry.missedService) {
    entry.missedService.name = scrub(entry.missedService.name);
    entry.missedService.website = scrub(entry.missedService.website);
  }
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

const CSV_COLUMNS = ['id', 'date', 'kind', 'status', 'schemeIds', 'recordLastUpdated', 'helpful', 'reasons', 'text', 'missedServiceName', 'missedServiceWebsite', 'missedServiceArea', 'gapCategories', 'gapArea', 'lang', 'mode', 'redacted', 'note'];
function csv(items) {
  // A leading = + - @ would be run as a formula by a spreadsheet, so it gets a ' in front.
  const cell = (v) => {
    let s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const rows = items.map((x) => {
    const ms = x.missedService || {};
    const row = { ...x, missedServiceName: ms.name, missedServiceWebsite: ms.website, missedServiceArea: ms.area };
    return CSV_COLUMNS.map((c) => cell(row[c])).join(',');
  });
  return [CSV_COLUMNS.map(cell).join(','), ...rows].join('\r\n') + '\r\n';
}

// ctx: { ids: Set of scheme ids, areas: [...], categories: [...] }, worked out from the data by index.js.
export async function handleFeedback(request, env, url, cors, originOk, ctx) {
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
    if (text.length > MAX_BODY) return json({ error: 'That feedback was too large.' }, 413, cors);
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
    const v = validateFeedback(body, ctx);
    if (v.error) return json({ error: v.error }, 400, cors);
    const r = await call('/add', { entry: v.entry, max: Number(env.MAX_FEEDBACK_PER_DAY || 300) });
    if (r.body.capped) return json({ error: 'We have had a lot of feedback today. Please try again tomorrow.' }, 503, cors);
    return json({ ok: true, redacted: v.entry.redacted }, 201, cors);
  }

  // ----- reading and triage (passcode) -----
  // Off unless the FEEDBACK_PASSCODE secret is set. A browser on another site is refused; the digest script,
  // which sends no Origin, is allowed with the passcode.
  if (!env.FEEDBACK_PASSCODE || !env.FEEDBACK_STORE) return json({ error: 'Not found.' }, 404, cors);
  if (request.headers.get('Origin') && !originOk) return json({ error: 'Not allowed.' }, 403, cors);
  if (env.FEEDBACK_READ_LIMITER) {
    const { success } = await env.FEEDBACK_READ_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'Too many requests. Please wait a minute.' }, 429, cors);
  }
  const pass = request.headers.get('X-Feedback-Passcode') || '';
  if (!(await safeEqual(pass, env.FEEDBACK_PASSCODE))) return json({ error: 'Wrong passcode.' }, 401, cors);

  if (request.method === 'GET' && (path === '/feedback/items' || path === '/feedback/export.csv')) {
    const status = url.searchParams.get('status');
    const since = url.searchParams.get('since');
    if (status && !STATUSES.includes(status)) return json({ error: 'Unknown status.' }, 400, cors);
    if (since && !isDate(since)) return json({ error: '"since" must be a date, YYYY-MM-DD.' }, 400, cors);
    const { body } = await call('/list', { status, since });
    if (path === '/feedback/items') return json({ items: body.items, statuses: STATUSES }, 200, cors);
    return new Response(csv(body.items), {
      status: 200,
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="service-finder-feedback-${today()}.csv"`, 'Cache-Control': 'no-store', ...cors },
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
