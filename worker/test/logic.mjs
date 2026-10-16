// Local logic test for the Worker (no network, no Cloudflare). Run: node worker/test/logic.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
// data/services.json is generated from the per-scheme files, so build it first.
execFileSync(process.execPath, [path.join(root, 'scripts/build-data.mjs')], { stdio: 'inherit' });
let src = fs.readFileSync(path.join(root, 'worker/src/index.js'), 'utf8');
// Swap the two bundler-style imports for plain file reads so Node can load the module.
src = src
  .replace("import data from '../../data/services.json';", `const data = JSON.parse(${JSON.stringify(fs.readFileSync(path.join(root, 'data/services.json'), 'utf8'))});`)
  .replace("import schema from '../../data/schema.json';", `const schema = JSON.parse(${JSON.stringify(fs.readFileSync(path.join(root, 'data/schema.json'), 'utf8'))});`)
  .replace("import SYSTEM_PROMPT from '../../prompt/system.md';", `const SYSTEM_PROMPT = ${JSON.stringify(fs.readFileSync(path.join(root, 'prompt/system.md'), 'utf8'))};`);
const tmp = path.join(root, 'worker/src/.under-test.mjs'); // inside src/ so './teamlog.js' and './feedback.js' resolve; git-ignored
fs.writeFileSync(tmp, src);
const mod = await import(pathToFileURL(tmp).href);
const fb = await import(pathToFileURL(path.join(root, 'worker/src/feedback.js')).href);
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

// ----- data file: the fields the prompt relies on -----
const svc = JSON.parse(fs.readFileSync(path.join(root, 'data/services.json'), 'utf8')).services;
const AUD = ['individual', 'employer', 'organisation', 'student'];
const HF = ['any', 'mental-health', 'severe-mental-illness', 'musculoskeletal-pain', 'substance-use', 'learning-disability-autism', 'unpaid-caring'];
check('data: ids are unique', new Set(svc.map((x) => x.id)).size === svc.length);
check('data: every scheme has audience, gate and healthFocus in the agreed vocabulary', svc.every((x) => Array.isArray(x.audience) && x.audience.length && x.audience.every((a) => AUD.includes(a)) && Array.isArray(x.gate) && x.gate.every((g) => typeof g === 'string' && g) && Array.isArray(x.healthFocus) && x.healthFocus.every((h) => HF.includes(h))), svc.filter((x) => !(Array.isArray(x.gate) && Array.isArray(x.healthFocus))).map((x) => x.id).join());
check('data: only the College hub is student-only', svc.filter((x) => x.audience.includes('student')).map((x) => x.id).join() === 'health-wellbeing-hub' && !svc.find((x) => x.id === 'health-wellbeing-hub').audience.includes('individual'));
check('data: HWL schemes with a gate are the four expected', svc.filter((x) => x.hwlFunded && x.gate.length).map((x) => x.id).join() === 'health-wellbeing-hub,ips-cgl,ips-smi,talking-therapies-employment');
check('data: every substance-use or severe mental illness scheme needs the person to mention it', svc.filter((x) => x.healthFocus.includes('substance-use') || x.healthFocus.includes('severe-mental-illness')).every((x) => x.requiresMention), svc.filter((x) => (x.healthFocus.includes('substance-use') || x.healthFocus.includes('severe-mental-illness')) && !x.requiresMention).map((x) => x.id).join());
check('data: the 31 HWL schemes are all marked hwlFunded and local', svc.filter((x) => x.hwlFunded).length === 31 && svc.filter((x) => x.hwlFunded).every((x) => x.level === 'local'));

// A well-formed model reply in the new shape; override only what each test cares about.
const reply0 = (o = {}) => ({
  status: 'results', message: 'hi', urgent_support: false, urgent_types: [], pii_detected: false,
  understood_needs: ['anxious', 'nearest to Dewsbury'], follow_up_questions: [],
  matches: [{ service_id: 'my-way-forward', fit: 'strong', reason: 'x', check_first: '' }], ...o,
});
const m = (id, fit = 'strong', reason = 'r', check_first = '') => ({ service_id: id, fit, reason, check_first });
const ids = (b) => b.recommendations.map((x) => x.id).join();
const asked = (n) => ({ role: 'assistant', content: 'A question?\n\n(Follow-up questions asked: ' + n + ')' });
const U = (t) => ({ role: 'user', content: t });

// Haiku: forced tool call, no thinking param
reply = tool(reply0());
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
check('data block leaves out contact details and trigger words', !/"(phone|email|webpage|requiresMention|provenance)":/.test(sent.system[1].text) && sent.system[1].text.includes('"hwlFunded"'));

// ----- new reply shape: what the Worker sends to the model -----
const props = sent.tools[0].input_schema.properties;
const schemeCount = JSON.parse(fs.readFileSync(path.join(root, 'data/services.json'), 'utf8')).services.length;
check(`schema: matches carry service_id enum of all ${schemeCount} schemes, max 5`, props.matches.maxItems === 5 && props.matches.items.properties.service_id.enum.length === schemeCount);
check('schema: fit is strong/possible', props.matches.items.properties.fit.enum.join() === 'strong,possible');
check('schema: urgent_types enum has the five kinds', props.urgent_types.items.enum.length === 5);
check('schema: all 2 follow-up questions left at the start', props.follow_up_questions.maxItems === 2 && /FOLLOW-UP QUESTIONS LEFT: 2/.test(sent.system[2].text));
check('schema: reply fields are required', ['status', 'message', 'urgent_support', 'matches'].every((k) => sent.tools[0].input_schema.required.includes(k)));

// ----- what the Worker sends to the page -----
reply = tool(reply0({ matches: [m('my-way-forward', 'strong', 'Fits age.', ''), m('wellness-to-work', 'weird fit value', 'Health.', 'Check the age.')], pii_detected: true }));
r = await call('claude-sonnet-5-5');
check('page shape: id/why/fit/check_first, odd fit becomes possible', r.body.recommendations[0].why === 'Fits age.' && r.body.recommendations[0].fit === 'strong' && r.body.recommendations[1].fit === 'possible' && r.body.recommendations[1].check_first === 'Check the age.', JSON.stringify(r.body.recommendations));
check('page shape: status, message, understood_needs, pii flag passed on', r.body.status === 'results' && r.body.message === 'hi' && r.body.understood_needs.length === 2 && r.body.pii_detected === true && r.body.safety_concern === false && r.body.urgent_types.length === 0, JSON.stringify(r.body));

// Unknown, duplicate, closed and surplus matches
reply = tool(reply0({ matches: [m('nope'), m('wellness-to-work'), m('wellness-to-work'), m('hwl-community-grants'), m('fitness-for-work'), m('flippin-pain'), m('get-set-goal'), m('elevate'), m('employment-kirklees')] }));
r = await call('claude-sonnet-5-5');
check('cards: unknown, duplicate and not-open schemes dropped; capped at 5', ids(r.body) === 'wellness-to-work,fitness-for-work,flippin-pain,get-set-goal,elevate', ids(r.body));

// Model answers in plain text instead of using the tool
reply = ok([{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'Plain text answer.' }]);
r = await call('claude-sonnet-5-5');
check('text fallback: 200 with message, no cards, status results', r.status === 200 && r.body.message === 'Plain text answer.' && r.body.recommendations.length === 0 && r.body.status === 'results', JSON.stringify(r));

// Empty answer
reply = ok([]);
r = await call('claude-sonnet-5-5');
check('empty answer: 502', r.status === 502);

// Upstream 400 surfaces a diagnostic
reply = () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad thing' } }), { status: 400 });
r = await call('claude-sonnet-5-5');
check('upstream 400: 502 with detail', r.status === 502 && r.body.upstream === 400 && r.body.detail === 'bad thing', JSON.stringify(r));

// Requires-mention guard: substance-use scheme dropped unless mentioned
reply = tool(reply0({ matches: [m('ips-cgl'), m('wellness-to-work')] }));
r = await call('claude-sonnet-5-5');
check('guard: ips-cgl dropped when not mentioned', ids(r.body) === 'wellness-to-work', ids(r.body));
r = await call('claude-sonnet-5-5', { messages: [U('My client is in treatment with CGL for alcohol use')] });
check('guard: ips-cgl kept when mentioned', ids(r.body) === 'ips-cgl,wellness-to-work', ids(r.body));

// ----- follow-up questions -----
reply = tool(reply0({ status: 'needs_more_info', message: 'What kind of health issue is it?', follow_up_questions: ['What kind of health issue is it?'], matches: [m('wellness-to-work')] }));
r = await call('claude-sonnet-5-5');
check('questions: needs_more_info returns the question and no cards', r.body.status === 'needs_more_info' && r.body.follow_up_questions.length === 1 && r.body.recommendations.length === 0, JSON.stringify(r.body));

reply = tool(reply0({ status: 'needs_more_info', follow_up_questions: ['One?', 'Two?'] }));
r = await call('claude-sonnet-5-5', { messages: [U('hello'), asked(1), U('still unsure')] });
check('questions: one already asked -> schema allows 1, Worker keeps only 1', sent.tools[0].input_schema.properties.follow_up_questions.maxItems === 1 && /FOLLOW-UP QUESTIONS LEFT: 1/.test(sent.system[2].text) && r.body.follow_up_questions.length === 1, JSON.stringify(r.body.follow_up_questions));

r = await call('claude-sonnet-5-5', { messages: [U('hello'), asked(1), U('still unsure'), asked(1), U('and more')] });
check('questions: both used -> no question field, results only, told zero left', sent.tools[0].input_schema.properties.follow_up_questions === undefined && sent.tools[0].input_schema.properties.status.enum.join() === 'results' && /FOLLOW-UP QUESTIONS LEFT: 0/.test(sent.system[2].text), JSON.stringify(sent.tools[0].input_schema.properties.status));
check('questions: model asks anyway after the limit -> treated as results, nothing asked', r.body.status === 'results' && r.body.follow_up_questions.length === 0, JSON.stringify(r.body));

reply = tool(reply0({ status: 'needs_more_info', follow_up_questions: [], matches: [] }));
r = await call('claude-sonnet-5-5');
check('questions: needs_more_info with no question -> treated as results', r.body.status === 'results', JSON.stringify(r.body));

reply = tool(reply0({ status: 'results', follow_up_questions: ['Stray question?'] }));
r = await call('claude-sonnet-5-5');
check('questions: stray question dropped from a results reply', r.body.status === 'results' && r.body.follow_up_questions.length === 0 && r.body.recommendations.length === 1);

// ----- questions promised but missing (the "Two quick questions..." bug) -----
// A sequence of replies, one per call to the model; counts the calls.
let calls = 0;
const seq = (...inputs) => () => { const i = inputs[Math.min(calls++, inputs.length - 1)]; return ok([{ type: 'tool_use', id: 'tu' + calls, name: 'respond', input: i }])(); };
const Q2 = ['Which language do you feel most comfortable speaking?', 'Are you looking for paid work, or volunteering first?'];

calls = 0;
reply = seq(reply0({ status: 'results', message: 'Two quick questions so I can find the best fit.', follow_up_questions: Q2, matches: [] }));
r = await call('claude-sonnet-5-5');
check('missing questions: questions labelled "results" with no cards are kept as a question reply', r.body.status === 'needs_more_info' && r.body.follow_up_questions.length === 2 && calls === 1, JSON.stringify(r.body));

calls = 0;
reply = seq(
  reply0({ status: 'needs_more_info', message: 'Thanks. Two quick questions so I can find the best fit for you.', follow_up_questions: [], matches: [] }),
  reply0({ status: 'needs_more_info', message: 'Thanks. ' + Q2.join(' '), follow_up_questions: Q2, matches: [] }),
);
r = await call('claude-sonnet-5-5');
const retryMsgs = sent.messages;
check('missing questions: needs_more_info with none written -> asks the model once more', calls === 2 && retryMsgs.length === 3 && retryMsgs[1].role === 'assistant' && retryMsgs[2].content[0].type === 'tool_result' && retryMsgs[2].content[0].tool_use_id === 'tu1', JSON.stringify(retryMsgs.slice(1)).slice(0, 300));
check('missing questions: the retried questions reach the page', r.body.status === 'needs_more_info' && r.body.follow_up_questions.join('|') === Q2.join('|'), JSON.stringify(r.body));

calls = 0;
reply = seq(
  reply0({ status: 'results', message: 'I can help near Dewsbury. Two quick questions so I can find the best fit for you.', follow_up_questions: [], matches: [] }),
  reply0({ status: 'needs_more_info', message: Q2.join(' '), follow_up_questions: Q2, matches: [] }),
);
r = await call('claude-sonnet-5-5');
check('missing questions: "results" that talks about questions but asks none -> retried', calls === 2 && r.body.follow_up_questions.length === 2, JSON.stringify(r.body));

calls = 0;
reply = seq(reply0({ status: 'results', message: 'Mam dwa szybkie pytania, żeby znaleźć najlepsze wsparcie.', follow_up_questions: [], matches: [] }), reply0({ status: 'needs_more_info', message: 'Jaki język? Praca czy wolontariat?', follow_up_questions: ['Jaki język?', 'Praca czy wolontariat?'], matches: [] }));
r = await call('claude-sonnet-5-5');
check('missing questions: Polish wording also retried', calls === 2 && r.body.follow_up_questions.length === 2);

calls = 0;
reply = seq(reply0({ status: 'needs_more_info', message: 'Two quick questions.', follow_up_questions: [], matches: [] }), reply0({ status: 'needs_more_info', message: 'Still none.', follow_up_questions: [], matches: [] }));
r = await call('claude-sonnet-5-5');
check('missing questions: retried only once, then falls back to results', calls === 2 && r.body.status === 'results', JSON.stringify(r.body));

calls = 0;
reply = seq(reply0({ status: 'results', message: 'Nothing in the information I have fits well, sorry.', follow_up_questions: [], matches: [] }));
r = await call('claude-sonnet-5-5');
check('missing questions: an honest "nothing fits" reply is not retried', calls === 1 && r.body.status === 'results');

calls = 0;
reply = seq(reply0({ status: 'results', message: 'Is that a question about benefits? This tool only covers work and health support.', follow_up_questions: [], matches: [] }));
r = await call('claude-sonnet-5-5');
check('missing questions: a message that already asks something is not retried', calls === 1);

calls = 0;
reply = seq(reply0({ status: 'needs_more_info', message: 'Two questions.', follow_up_questions: [], matches: [] }));
r = await call('claude-sonnet-5-5', { messages: [U('hello'), asked(1), U('still unsure'), asked(1), U('and more')] });
check('missing questions: no retry once both questions are used up', calls === 1 && r.body.status === 'results');

calls = 0;
reply = seq(reply0({ status: 'needs_more_info', message: 'Two quick questions.', follow_up_questions: [], matches: [] }));
globalThis.fetch = (() => { const real = globalThis.fetch; let n = 0; return async (u, i) => (n++ === 0 ? real(u, i) : new Response('{}', { status: 529 })); })();
r = await call('claude-sonnet-5-5');
check('missing questions: if the retry fails, the first reply is still returned', r.status === 200 && r.body.status === 'results', JSON.stringify(r));
globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body); return reply(); };

// ----- urgent support: no cards, no questions, whatever else the model sent -----
reply = tool(reply0({ urgent_support: true, urgent_types: ['domestic_abuse', 'bogus', 'domestic_abuse'], status: 'needs_more_info', follow_up_questions: ['Where do you live?'], matches: [m('wellness-to-work')] }));
r = await call('claude-sonnet-5-5');
check('urgent (model flag): no cards, no questions, results, types cleaned', r.body.safety_concern === true && r.body.recommendations.length === 0 && r.body.follow_up_questions.length === 0 && r.body.status === 'results' && r.body.urgent_types.join() === 'domestic_abuse' && r.body.understood_needs.length === 0, JSON.stringify(r.body));

// Crisis backstop: flag set by wording even if the model forgets
reply = tool(reply0({ message: 'I am sorry you feel this way.', matches: [m('wellness-to-work')] }));
r = await call('claude-sonnet-5-5', { messages: [U("I can't see the point anymore and I don't want to be here.")] });
check('crisis backstop: flag true, no cards, mental health type added', r.body.safety_concern === true && r.body.recommendations.length === 0 && r.body.urgent_types.join() === 'mental_health_crisis', JSON.stringify(r.body));
r = await call('claude-sonnet-5-5', { messages: [U('I can' + String.fromCharCode(8217) + 't see the point of my CV')] });
check('crisis backstop: curly apostrophe also caught', r.body.safety_concern === true);
reply = tool(reply0({ urgent_support: true, urgent_types: ['child_safeguarding'], matches: [] }));
r = await call('claude-sonnet-5-5', { messages: [U('I want to hurt myself')] });
check('crisis backstop: wording adds mental health to the model\'s own types', r.body.urgent_types.join() === 'child_safeguarding,mental_health_crisis', r.body.urgent_types.join());
reply = tool(reply0());
r = await call('claude-sonnet-5-5', { messages: [U('I want help with my CV and interviews')] });
check('crisis backstop: ordinary message not flagged', r.body.safety_concern === false && r.body.recommendations.length > 0, JSON.stringify(r.body));

// ----- Languages -----
reply = tool(reply0());
await call('claude-sonnet-5-5', { lang: 'pl', messages: [U('Szukam pracy w Dewsbury')] });
check('language: Polish note added to the last system block', /LANGUAGE: The page is shown in Polish/.test(sent.system[2].text));
await call('claude-sonnet-5-5', { lang: 'ur', messages: [U('مجھے نوکری چاہیے')] });
check('language: Urdu note added to the last system block', /LANGUAGE: The page is shown in Urdu/.test(sent.system[2].text));
await call('claude-sonnet-5-5', { lang: 'fr', messages: [U('I want help with my CV')] });
check('language: unknown language ignored (English, no note)', !/LANGUAGE:/.test(sent.system[2].text));
await call('claude-sonnet-5-5', { lang: 'toString', messages: [U('I want help with my CV')] });
check('language: odd values ignored', !/LANGUAGE:/.test(sent.system[2].text));
for (const [name, text] of [
  ['Polish', 'Nie chcę już żyć'],
  ['Polish without accents', 'mysle o samobojstwie'],
  ['Polish self-harm', 'Robię sobie krzywdę'],
  ['Urdu', 'میں خودکشی کے بارے میں سوچ رہا ہوں'],
  ['Urdu (want to die)', 'میں مرنا چاہتی ہوں'],
  ['Roman Urdu', 'khudkushi ke khayal aate hain'],
]) {
  reply = tool(reply0());
  r = await call('claude-sonnet-5-5', { lang: 'pl', messages: [U(text)] });
  check('crisis backstop: ' + name + ' wording caught', r.body.safety_concern === true && r.body.recommendations.length === 0, JSON.stringify(r.body));
}
reply = tool(reply0());
r = await call('claude-sonnet-5-5', { lang: 'pl', messages: [U('Chcę wrócić do pracy po zwolnieniu lekarskim')] });
check('crisis backstop: ordinary Polish message not flagged', r.body.safety_concern === false && r.body.recommendations.length > 0, JSON.stringify(r.body));
reply = tool(reply0({ matches: [m('ips-cgl'), m('wellness-to-work')] }));
r = await call('claude-sonnet-5-5', { lang: 'pl', messages: [U('Jestem w trakcie leczenia uzależnienia od alkoholu')] });
check('guard: ips-cgl kept when mentioned in Polish', ids(r.body) === 'ips-cgl,wellness-to-work', ids(r.body));
r = await call('claude-sonnet-5-5', { lang: 'ur', messages: [U('میں منشیات چھوڑنے کی کوشش کر رہا ہوں')] });
check('guard: ips-cgl kept when mentioned in Urdu', ids(r.body) === 'ips-cgl,wellness-to-work', ids(r.body));

// ----- Team issues log -----
const mkStore = () => {
  const mem = new Map();
  const storage = {
    get: async (k) => mem.get(k),
    put: async (k, v) => { mem.set(k, v); },
    delete: async (k) => mem.delete(k),
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

// ----- Listing decisions (MVP team) -----
check('live list: only services with listing decision include reach the Worker', svc.every((s) => s.listing && s.listing.decision === 'include'));
const allSvc = JSON.parse(fs.readFileSync(path.join(root, 'data/services-all.json'), 'utf8')).services;
check('all-services file holds every service, live or not', allSvc.length > svc.length && allSvc.some((s) => s.listing.decision === 'review'), allSvc.length + ' vs ' + svc.length);
check('AI can never pick a service waiting for review', !props.matches.items.properties.service_id.enum.includes('kbop') && !props.matches.items.properties.service_id.enum.includes('samaritans-helpline'));

store = mkStore();
r = await logCall('GET', '/log/decisions');
check('decisions: empty to start', r.status === 200 && Object.keys(r.body.decisions).length === 0, JSON.stringify(r.body));
r = await logCall('PUT', '/log/decisions/kbop', { decision: 'exclude', note: 'Retendered; not taking referrals', by: 'PL' });
check('decisions: set one', r.status === 200 && r.body.item.decision === 'exclude' && r.body.item.by === 'PL', JSON.stringify(r.body));
r = await logCall('PUT', '/log/decisions/kbop', { decision: 'include', by: 'AB' });
check('decisions: change keeps the earlier one in history', r.status === 200 && r.body.item.decision === 'include' && r.body.item.history.length === 1 && r.body.item.history[0].decision === 'exclude');
r = await logCall('PUT', '/log/decisions/kbop', { decision: 'maybe', by: 'AB' });
check('decisions: unknown decision -> 400', r.status === 400);
r = await logCall('PUT', '/log/decisions/kbop', { decision: 'review', by: 'AB', note: '' });
check('decisions: review or exclude needs a reason -> 400', r.status === 400);
r = await logCall('PUT', '/log/decisions/kbop', { decision: 'include', by: '' });
check('decisions: needs a name -> 400', r.status === 400);
r = await logCall('PUT', '/log/decisions/Bad_Id', { decision: 'include', by: 'AB' });
check('decisions: bad service id -> 404', r.status === 404);
r = await logCall('PUT', '/log/decisions/kbop', { decision: 'include', by: 'AB' }, { pass: 'nope' });
check('decisions: wrong passcode -> 401', r.status === 401);
r = await logCall('GET', '/log/decisions', null, { origin: null });
check('decisions: a script (no Origin) can read them with the passcode', r.status === 200 && r.body.decisions.kbop.decision === 'include');
r = await logCall('PUT', '/log/decisions/kbop', { decision: 'include', by: 'AB' }, { origin: null });
check('decisions: but not change them without the page origin', r.status === 403);
r = await logCall('GET', '/log/decisions', null, { origin: 'https://evil.example' });
check('decisions: wrong Origin -> 403', r.status === 403);
const pre3 = await worker.fetch(new Request('https://w/log/decisions/kbop', { method: 'OPTIONS', headers: { Origin: O } }), logEnv());
check('decisions: preflight allows PUT', pre3.headers.get('Access-Control-Allow-Methods').includes('PUT'));

// edits to a service's details
r = await logCall('GET', '/log/edits');
check('edits: empty to start', r.status === 200 && Object.keys(r.body.edits).length === 0);
const goodEdit = { changes: { phone: '01484 000000', whoFor: 'Adults in Kirklees looking for work.', areas: ['Huddersfield', 'Kirklees-wide'], webpage: null }, before: { phone: null, whoFor: 'old', areas: ['Kirklees-wide'], webpage: 'https://a.example' }, note: 'Phoned them', by: 'PL', checked: true, checkedUrl: 'https://kbop.example/contact' };
r = await logCall('PUT', '/log/edits/kbop', goodEdit);
check('edits: saved with the cleaned changes, before values and who', r.status === 200 && r.body.item.changes.phone === '01484 000000' && r.body.item.changes.webpage === null && r.body.item.before.areas.length === 1 && r.body.item.by === 'PL' && r.body.item.checked === true, JSON.stringify(r.body));
const editErr = async (changes, extra = {}) => (await logCall('PUT', '/log/edits/kbop', { ...goodEdit, changes, ...extra })).body.error || '';
check('edits: unknown area refused', /isn't allowed/.test(await editErr({ areas: ['Leeds'] })));
check('edits: id and listing can\'t be changed here', /can't be changed/.test(await editErr({ id: 'x' })) && /can't be changed/.test(await editErr({ listing: { decision: 'include' } })));
check('edits: bad web page refused', /web page/i.test(await editErr({ webpage: 'www.example.org' })));
check('edits: bad email refused', /email/i.test(await editErr({ email: 'nope' })));
check('edits: empty name refused', /can't be empty/.test(await editErr({ name: '  ' })));
check('edits: categories need at least one', /at least one/.test(await editErr({ categories: [] })));
check('edits: activities need a name and summary', /name and a summary/.test(await editErr({ activities: [{ name: 'x', summary: '' }] })));
check('edits: a reason is needed', /what changed/.test(await editErr(goodEdit.changes, { note: '' })));
check('edits: where you checked must be a web address', /web address/.test(await editErr(goodEdit.changes, { checkedUrl: 'the website' })));
r = await logCall('PUT', '/log/edits/kbop', { ...goodEdit, changes: { ...goodEdit.changes, phone: '01484 111111' }, by: 'AB' });
check('edits: a second change replaces the first and keeps it in history', r.body.item.changes.phone === '01484 111111' && r.body.item.history.length === 1);
r = await logCall('GET', '/log/edits', null, { origin: null });
check('edits: a script (no Origin) can read them', r.status === 200 && r.body.edits.kbop);
r = await logCall('PUT', '/log/edits/kbop', goodEdit, { origin: null });
check('edits: but not change them without the page origin', r.status === 403);
r = await logCall('DELETE', '/log/edits/kbop', { by: 'PL' });
check('edits: discard', r.status === 200 && Object.keys((await logCall('GET', '/log/edits')).body.edits).length === 0);
r = await logCall('DELETE', '/log/edits/kbop', { by: 'PL' });
check('edits: discarding twice -> 404', r.status === 404);

// apply-decisions.mjs, on a copy of a few scheme files
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-'));
  for (const id of ['kbop', 'samaritans-helpline', 'acas-helpline', 'hopeline247-papyrus']) fs.copyFileSync(path.join(root, 'data/services', id + '.json'), path.join(d, id + '.json'));
  const inp = path.join(d, 'decisions.json');
  fs.writeFileSync(inp, JSON.stringify({ decisions: {
    kbop: { decision: 'include', by: 'PL', t: '2026-10-16T10:00:00Z' },
    'samaritans-helpline': { decision: 'include', note: 'Keep alongside the crisis panel', by: 'PL', t: '2026-10-16T10:00:00Z' },
    'acas-helpline': { decision: 'review', note: 'Check the phone number', by: 'AB', t: '2026-10-16T11:00:00Z' },
    'hopeline247-papyrus': { decision: 'exclude', note: 'Closed', by: 'AB', t: '2026-10-16T11:00:00Z' },
    'not-a-service': { decision: 'exclude', note: 'x', by: 'AB', t: '2026-10-16T11:00:00Z' },
  } }));
  const run = () => execFileSync(process.execPath, [path.join(root, 'scripts/apply-decisions.mjs'), '--input', inp, '--dir', d], { encoding: 'utf8' });
  const out = run();
  const read = (id) => JSON.parse(fs.readFileSync(path.join(d, id + '.json'), 'utf8')).listing;
  check('apply: writes include, with who and when', read('samaritans-helpline').decision === 'include' && read('samaritans-helpline').by === 'PL' && read('samaritans-helpline').date === '2026-10-16' && read('samaritans-helpline').reason === 'Keep alongside the crisis panel', JSON.stringify(read('samaritans-helpline')));
  check('apply: takes a live service off for review', read('acas-helpline').decision === 'review');
  check('apply: excludes', read('hopeline247-papyrus').decision === 'exclude');
  check('apply: never puts an incomplete service live, and says so', read('kbop').decision === 'review' && /details still to be completed[\s\S]*kbop/.test(out), out);
  check('apply: reports unknown services', out.includes('not-a-service'));
  check('apply: running again changes nothing', /0 listing decisions applied, 3 already up to date/.test(run()), run());

  // edits: fill in kbop's missing details, then the include decision goes through
  const kb = JSON.parse(fs.readFileSync(path.join(d, 'kbop.json'), 'utf8'));
  const filled = {
    whoFor: 'Adults in Kirklees with complex needs.', referralRoutes: ['Referral from a support worker'], selfReferral: { allowed: 'no', note: 'Needs a referral' },
    activities: [{ name: 'Key worker support', summary: 'One-to-one help.', duration: '' }], phone: '01484 000000', notes: null,
  };
  const before = Object.fromEntries(Object.keys(filled).map((k) => [k, kb[k] === undefined ? null : kb[k]]));
  const acas = JSON.parse(fs.readFileSync(path.join(d, 'acas-helpline.json'), 'utf8'));
  fs.writeFileSync(inp, JSON.stringify({
    decisions: { kbop: { decision: 'include', by: 'PL', t: '2026-10-17T10:00:00Z' } },
    edits: {
      kbop: { changes: filled, before, note: 'Phoned the provider', by: 'PL', checked: true, checkedUrl: 'https://kbop.example/', t: '2026-10-17T09:00:00Z' },
      'acas-helpline': { changes: { phone: '0300 999 9999' }, before: { phone: '0300 000 0000' }, note: 'New number', by: 'AB', t: '2026-10-17T09:00:00Z' },
      'samaritans-helpline': { changes: { areas: ['Leeds'] }, before: {}, note: 'Bad', by: 'AB', t: '2026-10-17T09:00:00Z' },
    },
  }));
  const out2 = run();
  const kb2 = JSON.parse(fs.readFileSync(path.join(d, 'kbop.json'), 'utf8'));
  check('apply edits: details written, removed note dropped', kb2.phone === '01484 000000' && kb2.whoFor === filled.whoFor && !('notes' in kb2), JSON.stringify(kb2).slice(0, 300));
  check('apply edits: "checked" sets the last-checked date and where', kb2.lastUpdated === '2026-10-17' && kb2.provenance.checkedUrl === 'https://kbop.example/' && kb2.provenance.evidence.includes('Phoned the provider'));
  check('apply edits: once filled in, the include decision goes through', kb2.listing.decision === 'include' && kb2.listing.by === 'PL', JSON.stringify(kb2.listing));
  check('apply edits: a field changed in the data since is not overwritten', JSON.parse(fs.readFileSync(path.join(d, 'acas-helpline.json'), 'utf8')).phone === acas.phone && /data has changed since[\s\S]*acas-helpline[\s\S]*phone/.test(out2), out2);
  check('apply edits: an edit that fails the schema is reported, not written', !JSON.parse(fs.readFileSync(path.join(d, 'samaritans-helpline.json'), 'utf8')).areas.includes('Leeds') && /wouldn't pass the data check[\s\S]*samaritans/.test(out2), out2);
  check('apply edits: summary shows old and new values', /phone: \(none\) → 01484 000000/.test(out2), out2);
  fs.rmSync(d, { recursive: true, force: true });
}

// ----- User feedback -----
const FB_PASS = 'feedback passcode for tests';
const mkFbStore = () => {
  const mem = new Map();
  const storage = {
    mem,
    get: async (k) => mem.get(k),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) mem.set(a, b); else mem.set(k, v); },
    delete: async (ks) => { for (const k of [].concat(ks)) mem.delete(k); },
    list: async ({ prefix, limit = Infinity }) => new Map([...mem.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
  };
  return new mod.FeedbackStore({ storage });
};
let fbStore = mkFbStore();
let limiterHits = 0;
const fbEnv = (extra = {}) => ({
  ...env('claude-sonnet-5-5'),
  FEEDBACK_PASSCODE: FB_PASS,
  FEEDBACK_STORE: { idFromName: () => 'x', get: () => ({ fetch: (u, init) => fbStore.fetch(new Request(u, init)) }) },
  ...extra,
});
const fbCall = async (method, p, body, { pass = null, e = fbEnv(), origin = O, raw = null } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.Origin = origin;
  if (pass !== null) headers['x-feedback-passcode'] = pass;
  const res = await worker.fetch(new Request('https://w' + p, { method, headers, body: raw !== null ? raw : body ? JSON.stringify(body) : undefined }), e);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
};
const send = (body, opts) => fbCall('POST', '/feedback', body, opts);
const items = async () => (await fbCall('GET', '/feedback/items', null, { pass: FB_PASS })).body.items;
const cardFb = (o = {}) => ({ kind: 'card', schemeIds: ['wellness-to-work'], recordLastUpdated: '2026-10-01', reasons: ['contact-wrong'], text: 'The phone number rings out.', lang: 'en', mode: 'public', ...o });
const replyFb = (o = {}) => ({ kind: 'reply', schemeIds: ['wellness-to-work', 'fitness-for-work'], helpful: true, lang: 'pl', mode: 'staff', ...o });
const gapFb = (o = {}) => ({ kind: 'gap', reasons: ['missing-service'], missedService: { name: 'Batley Job Club', website: 'https://example.org/job-club', area: 'Batley' }, lang: 'en', mode: 'staff', ...o });

// /health flag
let h = await (await worker.fetch(new Request('https://w/health', { headers: { Origin: O } }), fbEnv())).json();
check('feedback: /health says feedback is on by default', h.feedback === true, JSON.stringify(h));
h = await (await worker.fetch(new Request('https://w/health'), fbEnv({ FEEDBACK_ENABLED: 'false' }))).json();
check('feedback: /health says off when FEEDBACK_ENABLED is "false"', h.feedback === false);
h = await (await worker.fetch(new Request('https://w/health'), fbEnv({ FEEDBACK_ENABLED: 'true' }))).json();
check('feedback: /health says on when FEEDBACK_ENABLED is "true"', h.feedback === true);
h = await (await worker.fetch(new Request('https://w/health'), env('x'))).json();
check('feedback: /health says off when the store is not bound', h.feedback === false);
r = await send(cardFb(), { e: fbEnv({ FEEDBACK_ENABLED: 'false' }) });
check('feedback: POST /feedback is 404 when switched off', r.status === 404);

// Valid entries are stored with only what is needed
r = await send(cardFb());
check('feedback: card entry accepted (201)', r.status === 201 && r.body.ok === true, JSON.stringify(r.body));
r = await send(replyFb());
check('feedback: "helpful: yes" entry accepted', r.status === 201, JSON.stringify(r.body));
r = await send(replyFb({ helpful: false, reasons: ['info-wrong', 'missed-service'], text: 'Two of these looked out of date.' }));
check('feedback: "helpful: no" entry with reasons accepted', r.status === 201, JSON.stringify(r.body));
r = await send(gapFb({ reasons: ['missing-service', 'missing-support'], gapCategories: ['Carers', 'Something else'], gapArea: 'Dewsbury', text: 'Nothing for carers in Dewsbury.' }));
check('feedback: gap entry accepted', r.status === 201, JSON.stringify(r.body));
let all = await items();
const today = new Date().toISOString().slice(0, 10);
const KEYS = ['id', 'kind', 'date', 'schemeIds', 'recordLastUpdated', 'helpful', 'reasons', 'text', 'missedService', 'gapCategories', 'gapArea', 'lang', 'mode', 'redacted', 'status', 'note'].sort().join();
check('feedback: four entries stored, all New, dated today with no time', all.length === 4 && all.every((x) => x.status === 'New' && x.date === today), JSON.stringify(all));
check('feedback: entries hold only the agreed fields (no IP, user agent or time)', all.every((x) => Object.keys(x).sort().join() === KEYS), Object.keys(all[0]).sort().join());
check('feedback: card entry keeps the scheme id and the date of the record shown', all[0].kind === 'card' && all[0].schemeIds.join() === 'wellness-to-work' && all[0].recordLastUpdated === '2026-10-01' && all[0].helpful === null);
check('feedback: reply entries keep ids, helpful, mode and language', all[1].helpful === true && all[1].schemeIds.length === 2 && all[1].mode === 'staff' && all[1].lang === 'pl' && all[2].helpful === false && all[2].reasons.join() === 'info-wrong,missed-service');
check('feedback: gap entry keeps the missed service, categories and area', all[3].missedService.name === 'Batley Job Club' && all[3].missedService.area === 'Batley' && all[3].gapCategories.join() === 'Carers,Something else' && all[3].gapArea === 'Dewsbury', JSON.stringify(all[3]));

// Validation: everything else is rejected with a plain-English error
const bad = [
  ['unknown kind', { ...cardFb(), kind: 'complaint' }],
  ['unknown scheme id', cardFb({ schemeIds: ['not-a-scheme'] })],
  ['two ids on a card', cardFb({ schemeIds: ['wellness-to-work', 'fitness-for-work'] })],
  ['unknown id in a reply', replyFb({ schemeIds: ['wellness-to-work', 'nope'] })],
  ['more than five ids in a reply', replyFb({ schemeIds: ['wellness-to-work', 'fitness-for-work', 'elevate', 'flippin-pain', 'get-set-goal', 'employment-kirklees'] })],
  ['reply with no ids', replyFb({ schemeIds: [] })],
  ['bad reason', cardFb({ reasons: ['rude-staff'] })],
  ['reply reason on a card', cardFb({ reasons: ['none-fit'] })],
  ['card with no reason', cardFb({ reasons: [] })],
  ['gap with no reason', gapFb({ reasons: [] })],
  ['oversized text', cardFb({ text: 'x'.repeat(301) })],
  ['text that is not text', cardFb({ text: { a: 1 } })],
  ['bad date of the record', cardFb({ recordLastUpdated: 'yesterday' })],
  ['missing helpful', replyFb({ helpful: undefined })],
  ['reasons with "yes"', replyFb({ helpful: true, reasons: ['none-fit'] })],
  ['bad language', cardFb({ lang: 'fr' })],
  ['bad mode', cardFb({ mode: 'admin' })],
  ['extra field', cardFb({ messages: [{ role: 'user', content: 'hi' }] })],
  ['conversation sneaked into a reply', replyFb({ understood_needs: ['anxious'] })],
  ['website not http(s)', gapFb({ missedService: { name: 'x', website: 'javascript:alert(1)' } })],
  ['website without a scheme', gapFb({ missedService: { name: 'x', website: 'example.org' } })],
  ['website too long', gapFb({ missedService: { website: 'https://example.org/' + 'a'.repeat(200) } })],
  ['service name too long', gapFb({ missedService: { name: 'n'.repeat(101) } })],
  ['unknown area', gapFb({ missedService: { area: 'Leeds' } })],
  ['unknown category', gapFb({ reasons: ['missing-support'], gapCategories: ['Astrology'] })],
  ['category without "kind of support"', gapFb({ gapCategories: ['Carers'] })],
  ['unknown support area', gapFb({ reasons: ['missing-support'], gapCategories: ['Carers'], gapArea: 'Narnia' })],
  ['service details without "a service"', gapFb({ reasons: ['missing-other'] })],
  ['extra service field', gapFb({ missedService: { name: 'x', phone: '01484 123456' } })],
];
for (const [name, body] of bad) {
  r = await send(body);
  check('feedback: rejected - ' + name, r.status === 400 && typeof r.body.error === 'string' && r.body.error.length > 5, r.status + ' ' + JSON.stringify(r.body));
}
r = await send(null, { raw: 'not json' });
check('feedback: rejected - not JSON', r.status === 400);
r = await send(cardFb(), { origin: 'https://evil.example' });
check('feedback: rejected - wrong origin (403)', r.status === 403);
r = await send(cardFb(), { origin: null });
check('feedback: rejected - no origin (403)', r.status === 403);
r = await send(null, { raw: JSON.stringify(cardFb({ text: 'x'.repeat(200) })) + ' '.repeat(4000) });
check('feedback: rejected - over 4 KB before parsing (413)', r.status === 413);
r = await fbCall('GET', '/feedback', null);
check('feedback: GET /feedback is not a route (404)', r.status === 404);
check('feedback: nothing stored from rejected requests', (await items()).length === 4);
r = await send(gapFb({ missedService: { name: '  Spaced out  ', website: 'http://example.org' } }));
all = await items();
check('feedback: text fields are trimmed', all[4].missedService.name === 'Spaced out' && all[4].missedService.area === '', JSON.stringify(all[4]));

// Removing personal details
const red = (t) => fb.redact(t).text;
const removes = [
  ['email', 'email me at jane.smith+work@example.co.uk please'],
  ['mobile with a space', 'call 07700 900123'],
  ['mobile run together', 'call 07700900123'],
  ['mobile with +44', 'call +44 7700 900123'],
  ['mobile with +44 and no spaces', 'call +447700900123'],
  ['landline 01484', 'ring 01484 123456'],
  ['landline in brackets', 'ring (01484) 123456'],
  ['Leeds number', 'ring 0113 496 0000'],
  ['London number', 'ring 020 7946 0000'],
  ['freephone with dashes', 'ring 0800-123-4567'],
  ['+44 (0) form', 'ring +44 (0)1484 123456'],
  ['0044 form', 'ring 0044 1484 123456'],
  ['postcode with a space', 'I live at HD1 4EW'],
  ['postcode run together, lower case', 'near wf135ab'],
  ['London postcode', 'SW1A 1AA'],
  ['NI number with spaces', 'my NI is QQ 12 34 56 C'],
  ['NI number run together', 'ab123456c'],
];
for (const [name, text] of removes) {
  const out = red(text);
  check('redaction: removes ' + name, out.includes('[removed]') && !/\d{4}|@|4EW|5AB|1AA|56 ?C/i.test(out), out);
}
const keeps = ['Open to people aged 16+', 'Based in HD1, near the bus station', 'Runs 9:30 to 4:30, Monday to Friday', 'It cost £5 per 28 days in 2026', 'Open 2025-2026', 'Ages 18-25 and 50+', 'Call 999 or NHS 111', 'Room 101, floor 2', 'They said it closed on 01/09/2026', 'WF13 area', 'Ofsted ref 123456'];
for (const text of keeps) check('redaction: leaves alone "' + text + '"', red(text) === text, red(text));
check('redaction: says when it removed something', fb.redact('x@y.com').redacted === true && fb.redact('hello').redacted === false);
r = await send(cardFb({ text: 'Ring me on 07700 900123 or email a@b.com, I live in HD1 4EW' }));
all = await items();
check('redaction: applied before storing, and the entry marked redacted', all[5].text === 'Ring me on [removed] or email [removed], I live in [removed]' && all[5].redacted === true && all[4].redacted === false, JSON.stringify(all[5]));
r = await send(gapFb({ missedService: { name: 'Call Sue on 07700900123', website: 'https://example.org' } }));
all = await items();
check('redaction: also applied to the service name', all[6].missedService.name === 'Call Sue on [removed]' && all[6].redacted === true);
r = await send(cardFb({ text: 'Number was [removed]' }));
all = await items();
check('redaction: text the page already redacted is marked redacted', all[7].redacted === true);
const pageSrc = fs.readFileSync(path.join(root, 'site/feedback.js'), 'utf8');
check('redaction: the page uses the same patterns as the Worker', fb.REDACT_PATTERNS.every((re) => pageSrc.includes(String(re))), fb.REDACT_PATTERNS.filter((re) => !pageSrc.includes(String(re))).join(' '));

// Rate limit and daily cap
let lim = 0;
const limiter = { limit: async () => ({ success: ++lim <= 5 }) };
fbStore = mkFbStore();
const limited = [];
for (let i = 0; i < 6; i++) limited.push((await send(cardFb(), { e: fbEnv({ FEEDBACK_LIMITER: limiter }) })).status);
check('feedback: per-IP limit - the sixth in a minute gets 429', limited.join() === '201,201,201,201,201,429', limited.join());
fbStore = mkFbStore();
const capped = [];
for (let i = 0; i < 4; i++) capped.push((await send(cardFb(), { e: fbEnv({ MAX_FEEDBACK_PER_DAY: '3' }) })).status);
check('feedback: daily cap - the fourth of 3 a day gets 503', capped.join() === '201,201,201,503', capped.join());
check('feedback: nothing stored past the cap', (await items()).length === 3);
fbStore.ctx.storage.mem.set('day', '2020-01-01');
r = await send(cardFb(), { e: fbEnv({ MAX_FEEDBACK_PER_DAY: '3' }) });
check('feedback: daily cap resets on a new day', r.status === 201);

// Read routes
r = await fbCall('GET', '/feedback/items', null, { pass: FB_PASS, e: fbEnv({ FEEDBACK_PASSCODE: undefined }) });
check('feedback: read routes 404 with no FEEDBACK_PASSCODE set', r.status === 404);
r = await fbCall('GET', '/feedback/export.csv', null, { pass: 'x', e: fbEnv({ FEEDBACK_PASSCODE: undefined }) });
check('feedback: CSV 404 with no FEEDBACK_PASSCODE set', r.status === 404);
r = await fbCall('PATCH', '/feedback/items/1', { status: 'Reviewed' }, { pass: 'x', e: fbEnv({ FEEDBACK_PASSCODE: undefined }) });
check('feedback: PATCH 404 with no FEEDBACK_PASSCODE set', r.status === 404);
r = await send(cardFb(), { e: fbEnv({ FEEDBACK_PASSCODE: undefined }) });
check('feedback: sending still works with no FEEDBACK_PASSCODE set', r.status === 201);
r = await fbCall('GET', '/feedback/items', null, { pass: 'wrong' });
check('feedback: wrong passcode -> 401', r.status === 401);
r = await fbCall('GET', '/feedback/items', null);
check('feedback: missing passcode -> 401', r.status === 401);
r = await fbCall('GET', '/feedback/export.csv', null, { pass: 'wrong' });
check('feedback: CSV with the wrong passcode -> 401', r.status === 401);
r = await fbCall('PATCH', '/feedback/items/1', { status: 'Reviewed' }, { pass: 'wrong' });
check('feedback: PATCH with the wrong passcode -> 401', r.status === 401);
r = await fbCall('GET', '/feedback/items', null, { pass: FB_PASS, origin: 'https://evil.example' });
check('feedback: read from another website refused (403)', r.status === 403);
r = await fbCall('GET', '/feedback/items', null, { pass: FB_PASS, origin: null });
check('feedback: read with the passcode and no Origin (the digest script) works', r.status === 200 && r.body.items.length === 5, JSON.stringify(r.body).slice(0, 200));
r = await fbCall('PATCH', '/feedback/items/2', { status: 'Actioned', note: 'Fixed in PR 20. Spoke to Sue on 07700 900123.' }, { pass: FB_PASS });
check('feedback: PATCH changes status and adds a note (with details removed)', r.status === 200 && r.body.item.status === 'Actioned' && r.body.item.note === 'Fixed in PR 20. Spoke to Sue on [removed].', JSON.stringify(r.body));
r = await fbCall('PATCH', '/feedback/items/2', { status: 'Done' }, { pass: FB_PASS });
check('feedback: PATCH with an unknown status -> 400', r.status === 400);
r = await fbCall('PATCH', '/feedback/items/2', {}, { pass: FB_PASS });
check('feedback: PATCH with nothing to change -> 400', r.status === 400);
r = await fbCall('PATCH', '/feedback/items/99', { status: 'Reviewed' }, { pass: FB_PASS });
check('feedback: PATCH an unknown id -> 404', r.status === 404);
r = await fbCall('GET', '/feedback/items?status=New', null, { pass: FB_PASS });
check('feedback: filter by status', r.body.items.length === 4 && r.body.items.every((x) => x.status === 'New'));
r = await fbCall('GET', '/feedback/items?status=Bogus', null, { pass: FB_PASS });
check('feedback: unknown status filter -> 400', r.status === 400);
r = await fbCall('GET', '/feedback/items?since=' + today, null, { pass: FB_PASS });
const r2 = await fbCall('GET', '/feedback/items?since=2999-01-01', null, { pass: FB_PASS });
check('feedback: filter by since', r.body.items.length === 5 && r2.body.items.length === 0);
r = await fbCall('GET', '/feedback/items?since=last-week', null, { pass: FB_PASS });
check('feedback: bad since -> 400', r.status === 400);
await send(cardFb({ text: '=HYPERLINK("http://x")' }));
r = await fbCall('GET', '/feedback/export.csv', null, { pass: FB_PASS });
check('feedback: CSV export has a header, one row per entry and a download name', r.status === 200 && r.body.startsWith('"id","date","kind"') && r.body.trim().split('\r\n').length === 7 && /attachment; filename="service-finder-feedback-\d{4}-\d{2}-\d{2}\.csv"/.test(r.headers.get('content-disposition')), r.body.slice(0, 200));
check('feedback: CSV neutralises a leading "=" (formula injection)', r.body.includes("\"'=HYPERLINK"));
const pre2 = await worker.fetch(new Request('https://w/feedback/items', { method: 'OPTIONS', headers: { Origin: O } }), fbEnv());
check('feedback: preflight allows x-feedback-passcode', pre2.status === 204 && pre2.headers.get('Access-Control-Allow-Headers').includes('x-feedback-passcode'));

// Retention: entries older than 12 months are deleted on the next write (and never returned)
fbStore = mkFbStore();
const old = (y, m, d) => { const x = new Date(); x.setUTCFullYear(x.getUTCFullYear() - y, x.getUTCMonth() - m, x.getUTCDate() - d); return x.toISOString().slice(0, 10); };
const memFb = fbStore.ctx.storage.mem;
memFb.set('fb:0000001', { id: 1, kind: 'card', date: old(2, 0, 0), status: 'New' });
memFb.set('fb:0000002', { id: 2, kind: 'card', date: old(1, 0, 1), status: 'Actioned' });
memFb.set('fb:0000003', { id: 3, kind: 'card', date: old(0, 11, 0), status: 'New' });
memFb.set('seq', 3);
check('retention: the cutoff is 12 months ago', fb.retentionCutoff(new Date('2026-10-16T12:00:00Z')) === '2025-10-16');
await send(cardFb());
check('retention: entries older than 12 months deleted on write, newer kept', [...memFb.keys()].filter((k) => k.startsWith('fb:')).join() === 'fb:0000003,fb:0000004', [...memFb.keys()].join());
memFb.set('fb:0000000', { id: 0, kind: 'gap', date: old(1, 1, 0), status: 'New' });
check('retention: old entries are never returned by a read', (await items()).every((x) => x.id !== 0) && !memFb.has('fb:0000000'));
fbStore = mkFbStore();
for (let i = 1; i <= 230; i++) fbStore.ctx.storage.mem.set('fb:' + String(i).padStart(7, '0'), { id: i, date: old(2, 0, 0) });
fbStore.ctx.storage.mem.set('seq', 230);
await send(cardFb());
check('retention: clears a large backlog in batches', (await items()).length === 1);

// The digest script (read-only, from a saved list of entries)
fbStore = mkFbStore();
for (const b of [
  cardFb(), cardFb({ reasons: ['closed', 'contact-wrong'], text: 'Phone is dead' }), cardFb({ schemeIds: ['fitness-for-work'], reasons: ['missing-details'], text: 'No opening times' }),
  replyFb(), replyFb({ helpful: false, reasons: ['none-fit'] }),
  gapFb(), gapFb({ missedService: { name: 'batley job club', website: '' } }), gapFb({ missedService: { name: 'Wellness to Work', website: 'https://www.locala.org.uk/services/wellness-to-work' } }),
  gapFb({ reasons: ['missing-support'], missedService: undefined, gapCategories: ['Carers'], gapArea: 'Dewsbury' }),
]) await send(b);
const dump = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-')), 'entries.json');
fs.writeFileSync(dump, JSON.stringify({ items: await items() }));
const digest = execFileSync(process.execPath, [path.join(root, 'scripts/feedback-digest.mjs'), '--input', dump], { encoding: 'utf8' });
fs.rmSync(dump, { force: true });
check('digest: has the two main parts and the summary', digest.includes("## What's wrong") && digest.includes("## What's missing") && digest.includes('## Helpful or not'), digest.slice(0, 300));
check('digest: flags a scheme with 2+ reports in 30 days, with its data file', /Wellness to Work.*2 reports/.test(digest) && digest.includes('data/services/wellness-to-work.json'), digest);
check('digest: groups repeated suggestions and counts them', /Batley Job Club.*suggested 2 times/i.test(digest), digest);
check('digest: marks a suggestion that is probably already listed', /Wellness to Work.*likely duplicate of `wellness-to-work`/i.test(digest), digest);
check('digest: lists listings missing useful details', /missing useful details[\s\S]*Fitness for Work/i.test(digest), digest);
check('digest: counts kinds of support by category and compares with the data', /\| Carers \| 1 \| Dewsbury \(1\) \| \d+ \|/.test(digest), digest);
check('digest: helpful counts by mode and language', /\| staff \| pl \| 1 \| 1 \|/.test(digest), digest);

console.log(`passed=${pass} failed=${fail}`);
process.exit(fail ? 1 : 0);
