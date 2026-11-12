// Provider review links: a private link for one named contact at one scheme, so the scheme can check everything the
// Support Finder holds about it and send corrections, without the team passcode and without seeing anything else.
//
// - The MVP team makes a link on the All services page (POST /log/provider-links, team passcode) and emails it
//   themselves. Nothing is emailed from here.
// - The link opens site/provider-check.html#<token>. That page reads the scheme (GET /provider/<token>) and sends
//   either "all correct" or changed details (POST /provider/<token>). The token is the only key: it works for
//   one scheme, until it expires or the team cancels it.
// - Replies are stored with the link in the team store (LogStore in teamlog.js). They never change the data by
//   themselves: the team reviews them on All services and saves them as an ordinary edit, which is applied the
//   usual way (Actions > Apply team changes, or Apply changes now).
//
// The feature is off (404) unless the TEAM_PASSCODE secret is set, like the rest of the team tools.
// Stored about the contact: the name the team typed in, and the name they give when replying. No email address.

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DAY = 86400000;
// Fields not shown to the provider: they can't change them here and they're about maintaining the data.
// (Which fields a provider can't change is checker.TEAM_ONLY, in serviceedit.js.)
const HIDDEN = new Set(['provenance', 'listing', 'requiresMention', 'logo', 'lastUpdated', 'reviewCycle', 'level', 'hwlFunded', 'notes', 'mapLinks', 'areas', 'categories']);

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...cors },
  });
}

function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const isLive = (link) => link && !link.cancelled && Date.parse(link.expires) > Date.now();

// ---------- team side: /log/provider-links (called from handleLog, after the passcode check) ----------
export async function teamLinks(request, path, body, call, cors, checker) {
  if (request.method === 'GET' && path === '/log/provider-links') {
    return json(await call('/plinks/list'), 200, cors);
  }

  if (request.method === 'POST' && path === '/log/provider-links') {
    const id = clean(body.id, 50);
    if (!ID_RE.test(id) || !checker || !checker.byId || !checker.byId.has(id)) return json({ error: 'Links can only be made for services on the live list.' }, 400, cors);
    const by = clean(body.by, 40);
    if (!by) return json({ error: 'Please give your name or initials.' }, 400, cors);
    const contact = clean(body.contact, 80);
    if (contact.length < 2) return json({ error: "Please give the name of the person you're sending it to." }, 400, cors);
    const days = [7, 14, 30, 60, 90].includes(Number(body.days)) ? Number(body.days) : 30;
    const expires = new Date(Date.now() + days * DAY).toISOString();
    const res = await call('/plinks/create', { token: newToken(), id, contact, by, expires });
    return json(res, res.error ? 400 : 201, cors);
  }

  const c = path.match(/^\/log\/provider-links\/([A-Za-z0-9_-]{32})\/cancel$/);
  if (request.method === 'POST' && c) {
    const by = clean(body.by, 40);
    if (!by) return json({ error: 'Please give your name or initials.' }, 400, cors);
    const res = await call('/plinks/cancel', { token: c[1], by });
    return json(res, res.error ? 404 : 200, cors);
  }

  return json({ error: 'Not found.' }, 404, cors);
}

// ---------- provider side: /provider/<token> ----------
export async function handleProvider(request, env, url, cors, originOk, checker, schema) {
  if (!env.TEAM_PASSCODE || !env.LOG_STORE) return json({ error: 'Not found.' }, 404, cors);
  if (!originOk) return json({ error: 'Not allowed.' }, 403, cors);

  if (env.LOG_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.LOG_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'Too many requests. Please wait a minute.' }, 429, cors);
  }

  const notWorking = () => json({ error: "This link isn't working. It may have expired or been cancelled. Please contact the Healthy Working Life team for a new one." }, 404, cors);
  const m = url.pathname.match(/^\/provider\/([^/]+)$/);
  if (!m || !TOKEN_RE.test(m[1])) return notWorking();
  const token = m[1];

  const stub = env.LOG_STORE.get(env.LOG_STORE.idFromName('team-log'));
  const call = async (path, payload) => (await stub.fetch('https://log' + path, { method: 'POST', body: JSON.stringify(payload || {}) })).json();
  const { link } = await call('/plinks/get', { token });
  const service = link && checker.byId.get(link.id);
  if (!isLive(link) || !service) return notWorking();

  if (request.method === 'GET') {
    const P = schema.properties;
    const enumOf = (prop) => (prop.items ? prop.items.enum : prop.enum);
    const shown = Object.fromEntries(Object.entries(service).filter(([k]) => !HIDDEN.has(k)));
    const last = link.replies.length ? link.replies[link.replies.length - 1] : null;
    return json({
      contact: link.contact,
      expires: link.expires,
      service: shown,
      choices: {
        audience: enumOf(P.audience), healthFocus: enumOf(P.healthFocus), selfReferral: enumOf(P.selfReferral.properties.allowed), groups: enumOf(P.groups),
      },
      // Every organisation's name, so the form can suggest them as the person types.
      organisations: checker.organisations || [],
      // Every venue already listed (name, address and postcode only), so they can pick one instead of retyping it.
      venues: checker.venues || [],
      // The organisation's other services on the live list, for "Do you run anything else?".
      otherServices: [...(checker.byId ? checker.byId.values() : [])].filter((x) => x.organisation === service.organisation && x.id !== service.id).map((x) => ({ id: x.id, name: x.name })),
      lastReply: last ? { t: last.t, allCorrect: last.allCorrect } : null,
    }, 200, cors);
  }

  if (request.method !== 'POST') return json({ error: 'Not found.' }, 404, cors);
  const text = await request.text();
  if (text.length > 60000) return json({ error: 'That was too large to send.' }, 413, cors);
  let body;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    return json({ error: 'That could not be read.' }, 400, cors);
  }

  const name = clean(body.name, 80) || link.contact;
  const note = clean(body.note, 2000);
  let changes = {};
  const allCorrect = body.allCorrect === true;
  if (!allCorrect) {
    const input = body.changes && typeof body.changes === 'object' && !Array.isArray(body.changes) ? body.changes : {};
    const blocked = Object.keys(input).filter((k) => checker.TEAM_ONLY.includes(k));
    if (blocked.length) return json({ error: `"${blocked[0]}" can't be changed here.` }, 400, cors);
    if (!Object.keys(input).length) {
      if (note.length < 3) return json({ error: "Nothing has been changed. Change the details above, or tell us what's wrong in the box at the end." }, 400, cors);
    } else {
      const checked = checker.checkChanges(input, service);
      if (checked.error) return json({ error: checked.error }, 400, cors);
      changes = checked.changes;
    }
  }
  // What the data said when the reply was sent, so the team can see old and new, and a later change can be spotted.
  const before = {};
  for (const k of Object.keys(changes)) before[k] = service[k] === undefined ? null : service[k];
  const res = await call('/plinks/reply', { token, reply: { allCorrect, changes, before, note, name } });
  if (res.error) return json({ error: res.error }, 429, cors);
  return json({ ok: true, t: res.reply.t }, 200, cors);
}
