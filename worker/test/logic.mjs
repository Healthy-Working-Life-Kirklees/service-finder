// Local logic test for the Worker (no network, no Cloudflare). Run: node worker/test/logic.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
let src = fs.readFileSync(path.join(root, 'worker/src/index.js'), 'utf8');
// Swap the two bundler-style imports for plain file reads so Node can load the module.
src = src
  .replace("import data from '../../data/services.json';", `const data = JSON.parse(${JSON.stringify(fs.readFileSync(path.join(root, 'data/services.json'), 'utf8'))});`)
  .replace("import SYSTEM_PROMPT from '../../prompt/system.md';", `const SYSTEM_PROMPT = ${JSON.stringify(fs.readFileSync(path.join(root, 'prompt/system.md'), 'utf8'))};`);
const tmp = path.join(root, 'worker/src/.under-test.mjs'); // inside src/ so './teamlog.js' resolves; git-ignored
fs.writeFileSync(tmp, src);
const mod = await import(pathToFileURL(tmp).href);
const worker = mod.default;
process.on('exit', () => fs.rmSync(tmp, { force: true }));

const O = 'https://healthy-working-life-kirklees.github.io';
let sent = null;
let reply = null;
globalThis.fetch = async (url, init) => {
  sent = JSON.parse(init.body);
  return reply();
};
const ok = (content) => () => new Response(JSON.stringify({ content, usage: {} }), { status: 200 });
const env = (model) => ({
  ALLOWED_ORIGIN: O,
  ANTHROPIC_API_KEY: 'k',
  ANTHROPIC_MODEL: model,
  CAP_COUNTER: { idFromName: () => 'x', get: () => ({ fetch: async () => Response.json({ allowed: true, n: 1 }) }) },
});
const call = async (model, body = { messages: [{ role: 'user', content: 'I am 20 and anxious in Dewsbury' }] }) => {
  const res = await worker.fetch(new Request('https://w/chat', { method: 'POST', headers: { Origin: O, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env(model));
  return { status: res.status, body: await res.json() };
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  ' + extra)); };
const tool = (input) => ok([{ type: 'tool_use', name: 'respond', input }]);

// Haiku: forced tool call, no thinking param
reply = tool({ message: 'hi', recommendations: [{ id: 'my-way-forward', why: 'x' }], safety_concern: false });
let r = await call('claude-haiku-4-5-20251001');
check('haiku: forced tool_choice', sent.tool_choice && sent.tool_choice.type === 'tool', JSON.stringify(sent.tool_choice));
check('haiku: no thinking param', sent.thinking === undefined);
check('haiku: card returned', r.body.recommendations.length === 1 && r.body.recommendations[0].id === 'my-way-forward');

// Sonnet 5.5: no forced tool, up-front thinking off
r = await call('claude-sonnet-5-5');
check('sonnet 5.5: no tool_choice sent', sent.tool_choice === undefined, JSON.stringify(sent.tool_choice));
check('sonnet 5.5: thinking = between_tools', sent.thinking && sent.thinking.type === 'between_tools', JSON.stringify(sent.thinking));
check('sonnet 5.5: card returned', r.status === 200 && r.body.recommendations.length === 1);
check('date line present in last system block', /Today's date: \d{4}-\d{2}-\d{2}/.test(sent.system[2].text));
check('cache_control on the data block', !!sent.system[1].cache_control);

// Model answers in plain text instead of using the tool
reply = ok([{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'Plain text answer.' }]);
r = await call('claude-sonnet-5-5');
check('text fallback: 200 with message', r.status === 200 && r.body.message === 'Plain text answer.' && r.body.recommendations.length === 0, JSON.stringify(r));

// Empty answer
reply = ok([]);
r = await call('claude-sonnet-5-5');
check('empty answer: 502', r.status === 502);

// Upstream 400 surfaces a diagnostic
reply = () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad thing' } }), { status: 400 });
r = await call('claude-sonnet-5-5');
check('upstream 400: 502 with detail', r.status === 502 && r.body.upstream === 400 && r.body.detail === 'bad thing', JSON.stringify(r));

// Requires-mention guard: substance-use scheme dropped unless mentioned
reply = tool({ message: 'm', recommendations: [{ id: 'ips-cgl', why: 'x' }, { id: 'wellness-to-work', why: 'y' }], safety_concern: false });
r = await call('claude-sonnet-5-5');
check('guard: ips-cgl dropped when not mentioned', r.body.recommendations.map((x) => x.id).join() === 'wellness-to-work', JSON.stringify(r.body.recommendations));
r = await call('claude-sonnet-5-5', { messages: [{ role: 'user', content: 'My client is in treatment with CGL for alcohol use' }] });
check('guard: ips-cgl kept when mentioned', r.body.recommendations.map((x) => x.id).join() === 'ips-cgl,wellness-to-work', JSON.stringify(r.body.recommendations));

// Crisis backstop: flag set by wording even if the model forgets
reply = tool({ message: 'I am sorry you feel this way.', recommendations: [{ id: 'wellness-to-work', why: 'x' }], safety_concern: false });
r = await call('claude-sonnet-5-5', { messages: [{ role: 'user', content: "I can't see the point anymore and I don't want to be here." }] });
check('crisis backstop: flag true, no cards', r.body.safety_concern === true && r.body.recommendations.length === 0, JSON.stringify(r.body));
r = await call('claude-sonnet-5-5', { messages: [{ role: 'user', content: 'I can' + String.fromCharCode(8217) + 't see the point of my CV' }] });
check('crisis backstop: curly apostrophe also caught', r.body.safety_concern === true);
r = await call('claude-sonnet-5-5', { messages: [{ role: 'user', content: 'I want help with my CV and interviews' }] });
check('crisis backstop: ordinary message not flagged', r.body.safety_concern === false && r.body.recommendations.length > 0, JSON.stringify(r.body));

// ----- Team issues log -----
const mkStore = () => {
  const mem = new Map();
  const storage = {
    get: async (k) => mem.get(k),
    put: async (k, v) => { mem.set(k, v); },
    list: async ({ prefix }) => new Map([...mem.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))),
  };
  return new mod.LogStore({ storage });
};
let store = mkStore();
const PASS = 'correct horse battery';
const logEnv = (extra = {}) => ({
  ...env('claude-sonnet-5-5'),
  TEAM_PASSCODE: PASS,
  LOG_STORE: { idFromName: () => 'x', get: () => ({ fetch: (u, init) => store.fetch(new Request(u, init)) }) },
  ...extra,
});
const logCall = async (method, p, body, { pass = PASS, e = logEnv(), origin = O } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.Origin = origin;
  if (pass !== null) headers['x-team-passcode'] = pass;
  const res = await worker.fetch(new Request('https://w' + p, { method, headers, body: body ? JSON.stringify(body) : undefined }), e);
  return { status: res.status, body: await res.json() };
};

r = await logCall('GET', '/log/items', null, { e: { ...logEnv(), TEAM_PASSCODE: undefined } });
check('log: feature off when no TEAM_PASSCODE secret (404)', r.status === 404);
r = await logCall('GET', '/log/items', null, { pass: 'nope' });
check('log: wrong passcode -> 401', r.status === 401);
r = await logCall('GET', '/log/items', null, { pass: null });
check('log: missing passcode -> 401', r.status === 401);
r = await logCall('GET', '/log/items', null, { origin: null });
check('log: wrong/missing Origin -> 403', r.status === 403);
r = await logCall('GET', '/log/items');
check('log: empty list', r.status === 200 && r.body.items.length === 0);

r = await logCall('POST', '/log/items', { type: 'Bogus', title: 'Elevate card shows wrong phone', details: 'Seen on test #1', area: 'Data accuracy', priority: 'High', owner: 'Phil' });
check('log: create -> 201, id 1, status Open, bad type falls back to Issue', r.status === 201 && r.body.item.id === 1 && r.body.item.status === 'Open' && r.body.item.type === 'Issue', JSON.stringify(r.body));
r = await logCall('POST', '/log/items', { title: 'ab' });
check('log: too-short title -> 400', r.status === 400);
r = await logCall('POST', '/log/items', { type: 'Action', title: 'Check the overdue entries' });
check('log: second item gets id 2, default area/priority', r.body.item.id === 2 && r.body.item.area === 'Other' && r.body.item.priority === 'Medium');

r = await logCall('PATCH', '/log/items/1', { status: 'Done', update: 'Fixed in the data file', by: 'PL' });
check('log: patch status + update note', r.status === 200 && r.body.item.status === 'Done' && r.body.item.updates.length === 2 && r.body.item.updates[0].text.includes('Open to Done'), JSON.stringify(r.body));
r = await logCall('PATCH', '/log/items/1', { status: 'Whatever' });
check('log: unknown status -> 400', r.status === 400);
r = await logCall('PATCH', '/log/items/99', { status: 'Done' });
check('log: unknown id -> 404', r.status === 404);
r = await logCall('GET', '/log/items');
check('log: list returns both, in id order', r.body.items.map((x) => x.id).join() === '1,2');

r = await logCall('POST', '/log/import', { items: [{ title: 'Starter one' }] });
check('log: import refused when log not empty', r.body.imported === 0);
store = mkStore();
r = await logCall('POST', '/log/import', { items: [{ title: 'Starter one', type: 'Action', status: 'Done' }, { title: 'x' }, { title: 'Starter two', area: 'Safety' }] });
check('log: import into empty log keeps valid entries only', r.body.imported === 2, JSON.stringify(r.body));
r = await logCall('GET', '/log/items');
check('log: imported statuses/areas kept', r.body.items[0].status === 'Done' && r.body.items[1].area === 'Safety');

// preflight allows the passcode header and PATCH
const pre = await worker.fetch(new Request('https://w/log/items', { method: 'OPTIONS', headers: { Origin: O } }), logEnv());
check('log: preflight allows x-team-passcode and PATCH', pre.status === 204 && pre.headers.get('Access-Control-Allow-Headers').includes('x-team-passcode') && pre.headers.get('Access-Control-Allow-Methods').includes('PATCH'));

console.log(`passed=${pass} failed=${fail}`);
process.exit(fail ? 1 : 0);
