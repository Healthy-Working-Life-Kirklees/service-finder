// Team issues & actions log (MVP team only).
//
// Stored in one Durable Object (SQLite-backed). Protected by a shared passcode held as the Worker
// secret TEAM_PASSCODE. If that secret is not set, every /log route returns 404, i.e. the feature is off.
// Free text only: the page tells people not to enter personal or identifying details.

const TYPES = ['Issue', 'Action', 'Idea', 'Question'];
const AREAS = ['Matching quality', 'Data accuracy', 'Wording and content', 'Safety', 'Technical', 'Process and governance', 'Other'];
const PRIORITIES = ['High', 'Medium', 'Low'];
const STATUSES = ['Open', 'In progress', 'Done', "Won't do"];

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const pad = (id) => 'item:' + String(id).padStart(6, '0');

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
  });
}

// Compare passcodes without leaking timing: hash both, then compare the hashes.
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function newItemFields(src) {
  return {
    type: pick(src.type, TYPES, 'Issue'),
    title: clean(src.title, 120),
    details: clean(src.details, 4000),
    area: pick(src.area, AREAS, 'Other'),
    priority: pick(src.priority, PRIORITIES, 'Medium'),
    owner: clean(src.owner, 40),
  };
}

// ---------- the store ----------
export class LogStore {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json();
    const s = this.ctx.storage;
    const now = new Date().toISOString();

    const create = async (fields, status) => {
      const id = ((await s.get('seq')) || 0) + 1;
      const item = { ...fields, id, status: pick(status, STATUSES, 'Open'), created: now, updated: now, updates: [] };
      await s.put('seq', id);
      await s.put(pad(id), item);
      return item;
    };

    if (url.pathname === '/list') {
      const m = await s.list({ prefix: 'item:' });
      return Response.json({ items: [...m.values()] });
    }

    if (url.pathname === '/create') {
      return Response.json({ item: await create(body.fields) });
    }

    if (url.pathname === '/import') {
      if (((await s.get('seq')) || 0) > 0) return Response.json({ imported: 0, reason: 'The log already has entries.' });
      let n = 0;
      for (const f of body.items) {
        await create(f.fields, f.status);
        n += 1;
      }
      return Response.json({ imported: n });
    }

    if (url.pathname === '/update') {
      const key = pad(body.id);
      const item = await s.get(key);
      if (!item) return Response.json({ error: 'Not found.' }, { status: 404 });
      const p = body.patch || {};
      if (p.status && p.status !== item.status) item.updates.push({ t: now, by: p.by || '', text: 'Status changed from ' + item.status + ' to ' + p.status + '.' });
      for (const k of ['type', 'title', 'details', 'area', 'priority', 'owner', 'status']) if (p[k] !== undefined) item[k] = p[k];
      if (p.update) item.updates.push({ t: now, by: p.by || '', text: p.update });
      item.updates = item.updates.slice(-100);
      item.updated = now;
      await s.put(key, item);
      return Response.json({ item });
    }

    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
}

// ---------- the HTTP side (called from the Worker's fetch) ----------
export async function handleLog(request, env, url, cors) {
  if (!env.TEAM_PASSCODE || !env.LOG_STORE) return json({ error: 'Not found.' }, 404, cors);

  if (env.LOG_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.LOG_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'Too many requests. Please wait a minute.' }, 429, cors);
  }

  const pass = request.headers.get('X-Team-Passcode') || '';
  if (!(await safeEqual(pass, env.TEAM_PASSCODE))) return json({ error: 'Wrong passcode.' }, 401, cors);

  const stub = env.LOG_STORE.get(env.LOG_STORE.idFromName('team-log'));
  const call = async (path, payload) => (await stub.fetch('https://log' + path, { method: 'POST', body: JSON.stringify(payload || {}) })).json();

  let body = {};
  if (request.method !== 'GET') {
    const text = await request.text();
    if (text.length > 60000) return json({ error: 'That request was too large.' }, 413, cors);
    try {
      body = JSON.parse(text || '{}');
    } catch {
      return json({ error: 'That request could not be read.' }, 400, cors);
    }
  }

  const path = url.pathname;

  if (request.method === 'GET' && path === '/log/items') {
    return json(await call('/list'), 200, cors);
  }

  if (request.method === 'GET' && path === '/log/check') {
    return json({ ok: true, types: TYPES, areas: AREAS, priorities: PRIORITIES, statuses: STATUSES }, 200, cors);
  }

  if (request.method === 'POST' && path === '/log/items') {
    const fields = newItemFields(body);
    if (fields.title.length < 3) return json({ error: 'Please give the entry a title (at least 3 characters).' }, 400, cors);
    return json(await call('/create', { fields }), 201, cors);
  }

  if (request.method === 'POST' && path === '/log/import') {
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 60) return json({ error: 'Nothing to import.' }, 400, cors);
    const items = body.items.map((x) => ({ fields: newItemFields(x), status: pick(x.status, STATUSES, 'Open') })).filter((x) => x.fields.title.length >= 3);
    return json(await call('/import', { items }), 200, cors);
  }

  const m = path.match(/^\/log\/items\/(\d{1,9})$/);
  if (request.method === 'PATCH' && m) {
    const patch = { by: clean(body.by, 40) };
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return json({ error: 'Unknown status.' }, 400, cors);
      patch.status = body.status;
    }
    if (body.type !== undefined) patch.type = pick(body.type, TYPES, 'Issue');
    if (body.area !== undefined) patch.area = pick(body.area, AREAS, 'Other');
    if (body.priority !== undefined) patch.priority = pick(body.priority, PRIORITIES, 'Medium');
    if (body.owner !== undefined) patch.owner = clean(body.owner, 40);
    if (body.title !== undefined) {
      patch.title = clean(body.title, 120);
      if (patch.title.length < 3) return json({ error: 'The title is too short.' }, 400, cors);
    }
    if (body.details !== undefined) patch.details = clean(body.details, 4000);
    if (body.update !== undefined) patch.update = clean(body.update, 2000);
    const res = await call('/update', { id: Number(m[1]), patch });
    return json(res, res.error ? 404 : 200, cors);
  }

  return json({ error: 'Not found.' }, 404, cors);
}
