// Anonymous usage counts: how many searches, which links were opened, and so on.
//
// Only daily tallies are kept, such as "2026-10-27, link opened, wellness-to-work, referral form: 4". There is
// no IP address, no user or session id, no time of day, no browser details and nothing anyone typed. The page
// stores nothing on the person's device for this (no cookies, no local storage).
//
//   POST /usage               public (same origin and rate limit checks as feedback): one event from the page
//   GET  /usage/days          passcode (FEEDBACK_PASSCODE): the daily tallies, optionally ?since=YYYY-MM-DD
//   GET  /usage/export.csv    passcode: the same as CSV, one row per date and count
//
// Searches are counted by the Worker itself when it answers /chat (see recordUsage in index.js), so they can't
// be inflated from the page. Events from the page are checked against fixed lists and the scheme ids.
// Counting is on unless the variable USAGE_ENABLED is "false". Tallies older than 24 months are deleted.

import { safeEqual } from './feedback.js';

const LANGS = ['en', 'pl', 'ur'];
const MODES = ['public', 'staff'];
export const LINK_KINDS = ['referral', 'website', 'phone', 'email', 'directions', 'map'];
export const A11Y_KINDS = ['size-large', 'size-larger', 'contrast'];
export const LISTEN_KINDS = ['reply', 'card'];
export const CONTACT_ANSWERS = ['yes', 'notyet', 'no'];
const RETENTION_MONTHS = 24;
const MAX_BODY = 512;

// Events the page may send, and what each may carry. Every counter key is built only from these fixed values
// and scheme ids, so nothing free-form can ever be stored.
export const PAGE_EVENTS = {
  visit: [], // the page was opened
  link: ['s', 'k'], // a link on a card was opened: scheme, kind of link
  copy: ['s'], // "Copy details" on a card
  listen: ['k'], // a Listen button was started: reply or card
  a11y: ['k'], // text size or high contrast switched on
  other: [], // "Are there other options?" pressed
  contacted: ['s', 'k'], // "Did you get in touch?": scheme, yes / not yet / no
};

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));

export function retentionCutoff(now = new Date()) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - RETENTION_MONTHS);
  return d.toISOString().slice(0, 10);
}

export const usageOn = (env) => env.USAGE_ENABLED !== 'false' && Boolean(env.USAGE_STORE);

// Checks an event from the page and turns it into counter keys, or returns { error }.
// Keys look like "link|wellness-to-work|referral|en|public": event, then its details, then language and mode.
export function eventKeys(body, ids) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Not readable.' };
  const e = body.e;
  if (!Object.hasOwn(PAGE_EVENTS, e)) return { error: 'Unknown event.' };
  const allowedFields = ['e', 'lang', 'mode', ...PAGE_EVENTS[e]];
  if (Object.keys(body).some((k) => !allowedFields.includes(k))) return { error: 'Unexpected field.' };
  const lang = body.lang === undefined ? 'en' : body.lang;
  if (!LANGS.includes(lang)) return { error: 'Unknown language.' };
  const mode = body.mode === undefined || body.mode === null ? 'none' : body.mode;
  if (mode !== 'none' && !MODES.includes(mode)) return { error: 'Unknown mode.' };
  const needScheme = PAGE_EVENTS[e].includes('s');
  if (needScheme && (typeof body.s !== 'string' || !ids.has(body.s))) return { error: 'Unknown scheme.' };
  const kinds = { link: LINK_KINDS, listen: LISTEN_KINDS, a11y: A11Y_KINDS, contacted: CONTACT_ANSWERS }[e];
  if (kinds && !kinds.includes(body.k)) return { error: 'Unknown kind.' };
  const parts = [e];
  if (needScheme) parts.push(body.s);
  if (kinds) parts.push(body.k);
  return { keys: [[...parts, lang, mode].join('|')] };
}

// Counter keys for one answer from /chat. Worked out by the Worker from what it sent back, never from the page.
export function chatKeys({ lang, mode, firstMessage, status, urgent, ids }) {
  const tail = lang + '|' + mode;
  const keys = ['search|' + tail];
  if (firstMessage) keys.push('conversation|' + tail);
  if (urgent) keys.push('urgent|' + tail);
  else if (status === 'needs_more_info') keys.push('question|' + tail);
  else if (!ids.length) keys.push('no-results|' + tail);
  else keys.push('results|' + tail);
  for (const id of ids) keys.push('shown|' + id + '|' + tail);
  return keys;
}

// ---------- the store: one record per day, { date, counts: { key: n }, total } ----------
export class UsageStore {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async purge() {
    const s = this.ctx.storage;
    const day = today();
    if ((await s.get('purged')) === day) return;
    const cutoff = retentionCutoff();
    const old = [...(await s.list({ prefix: 'd:' })).keys()].filter((k) => k.slice(2) < cutoff);
    if (old.length) await s.delete(old);
    await s.put('purged', day);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json();
    const s = this.ctx.storage;

    if (url.pathname === '/add') {
      await this.purge();
      const day = today();
      const rec = (await s.get('d:' + day)) || { date: day, counts: {}, total: 0 };
      const keys = body.keys.slice(0, 20);
      // Daily cap on everything counted, so a flood of requests can't fill the store.
      if (rec.total + keys.length > body.max) return Response.json({ capped: true });
      for (const k of keys) rec.counts[k] = (rec.counts[k] || 0) + 1;
      rec.total += keys.length;
      await s.put('d:' + day, rec);
      return Response.json({ ok: true });
    }

    if (url.pathname === '/days') {
      await this.purge();
      const days = [...(await s.list({ prefix: 'd:' })).values()].filter((d) => !body.since || d.date >= body.since);
      return Response.json({ days });
    }

    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
}

// ---------- the HTTP side ----------
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors } });
}

const stub = (env) => env.USAGE_STORE.get(env.USAGE_STORE.idFromName('usage'));
async function callStore(env, p, payload) {
  const res = await stub(env).fetch('https://usage' + p, { method: 'POST', body: JSON.stringify(payload || {}) });
  return res.json();
}

// Adds counts. Never throws: counting must not get in the way of answering.
export async function addUsage(env, keys) {
  if (!usageOn(env) || !keys.length) return;
  try {
    await callStore(env, '/add', { keys, max: Number(env.MAX_USAGE_PER_DAY || 20000) });
  } catch {
    /* counting is best effort */
  }
}

function csv(days) {
  const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['date', 'event', 'scheme', 'detail', 'lang', 'mode', 'count'];
  const rows = [];
  for (const d of days.sort((a, b) => a.date.localeCompare(b.date))) {
    for (const [k, n] of Object.entries(d.counts).sort()) {
      const p = k.split('|');
      const [event] = p;
      const lang = p[p.length - 2];
      const mode = p[p.length - 1];
      const mid = p.slice(1, -2);
      const hasScheme = ['link', 'copy', 'contacted', 'shown'].includes(event);
      const scheme = hasScheme ? mid[0] : '';
      const detail = hasScheme ? mid[1] || '' : mid[0] || '';
      rows.push([d.date, event, scheme, detail, lang, mode, n].map(cell).join(','));
    }
  }
  return [head.map(cell).join(','), ...rows].join('\r\n') + '\r\n';
}

// ids: Set of scheme ids.
export async function handleUsage(request, env, url, cors, originOk, ids) {
  const path = url.pathname;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // ----- an event from the page -----
  if (path === '/usage') {
    if (request.method !== 'POST' || !usageOn(env)) return json({ error: 'Not found.' }, 404, cors);
    if (!originOk) return json({ error: 'Not allowed.' }, 403, cors);
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'Too large.' }, 413, cors);
    if (env.USAGE_LIMITER) {
      const { success } = await env.USAGE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'Too many.' }, 429, cors);
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'Not readable.' }, 400, cors);
    }
    const v = eventKeys(body, ids);
    if (v.error) return json({ error: v.error }, 400, cors);
    await addUsage(env, v.keys);
    return new Response(null, { status: 204, headers: cors });
  }

  // ----- reading (the review team, with the feedback passcode) -----
  if (!env.FEEDBACK_PASSCODE || !env.USAGE_STORE) return json({ error: 'Not found.' }, 404, cors);
  if (request.headers.get('Origin') && !originOk) return json({ error: 'Not allowed.' }, 403, cors);
  if (env.FEEDBACK_READ_LIMITER) {
    const { success } = await env.FEEDBACK_READ_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'Too many requests. Please wait a minute.' }, 429, cors);
  }
  const pass = request.headers.get('X-Feedback-Passcode') || '';
  if (!(await safeEqual(pass, env.FEEDBACK_PASSCODE))) return json({ error: 'Wrong passcode.' }, 401, cors);
  if (request.method !== 'GET' || !['/usage/days', '/usage/export.csv'].includes(path)) return json({ error: 'Not found.' }, 404, cors);
  const since = url.searchParams.get('since');
  if (since && !isDate(since)) return json({ error: '"since" must be a date, YYYY-MM-DD.' }, 400, cors);
  const { days } = await callStore(env, '/days', { since });
  if (path === '/usage/days') return json({ days, retentionMonths: RETENTION_MONTHS }, 200, cors);
  return new Response(csv(days), {
    status: 200,
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="service-finder-usage-${today()}.csv"`, 'Cache-Control': 'no-store', ...cors },
  });
}
