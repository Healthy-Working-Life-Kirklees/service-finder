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
// The four HWL schemes with their own entry requirement, plus every grant-funded scheme, which all need the person
// to live in Kirklees, be economically inactive and have the right to work in the UK (programme team, 2 Nov 2026).
const GRANT_SCHEMES = ['audio-boost', 'edens-forest-woodland-pathways', 'empowerher-imws', 'growing-together-volunteering', 'happymoments-pathway-to-employment', 'lbt-future-creative', 'pathways-to-potential', 'pathways-to-potential-2', 'proper-progress', 'raise-your-game', 'shaping-healthy-working-life', 'shared-goods-shared-hope', 'sound-steps-2', 'tcd-healthy-futures', 'wellness-navigators'];
check('data: HWL schemes with a gate are the four expected plus the 15 grant schemes', svc.filter((x) => x.hwlFunded && x.gate.length).map((x) => x.id).sort().join() === ['health-wellbeing-hub', 'ips-cgl', 'ips-smi', 'talking-therapies-employment', ...GRANT_SCHEMES].sort().join(), svc.filter((x) => x.hwlFunded && x.gate.length).map((x) => x.id).join());
check('data: every grant scheme requires Kirklees, economically inactive, right to work and a health condition or disability', GRANT_SCHEMES.every((id) => { const x = svc.find((y) => y.id === id); return x && ['Lives in Kirklees', 'Is economically inactive (not working and not looking for work)', 'Has the right to work in the UK'].every((g) => x.gate.includes(g)) && x.healthFocus.join() === 'any' && x.eligibility.includes('Has a health condition or disability') && x.eligibility.includes('Has the right to work in the UK'); }), GRANT_SCHEMES.filter((id) => { const x = svc.find((y) => y.id === id); return !x || x.healthFocus.join() !== 'any'; }).join());
check('data: every substance-use or severe mental illness scheme needs the person to mention it', svc.filter((x) => x.healthFocus.includes('substance-use') || x.healthFocus.includes('severe-mental-illness')).every((x) => x.requiresMention), svc.filter((x) => (x.healthFocus.includes('substance-use') || x.healthFocus.includes('severe-mental-illness')) && !x.requiresMention).map((x) => x.id).join());
check('data: the 32 HWL schemes are all marked hwlFunded and local', svc.filter((x) => x.hwlFunded).length === 32 && svc.filter((x) => x.hwlFunded).every((x) => x.level === 'local'));

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

// ----- preview Worker: accepts its own address only when ALLOW_SELF_ORIGIN is set -----
{
  const PV = 'https://hwl-service-finder-preview.example.workers.dev';
  const pvChat = async (e, headers) => (await worker.fetch(new Request(PV + '/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ messages: [U('hello')] }) }), { ...env('claude-sonnet-5-5'), ...e })).status;
  reply = tool(reply0());
  check('preview: the live Worker refuses a request from its own address', (await pvChat({}, { Origin: PV })) === 403);
  check('preview: with ALLOW_SELF_ORIGIN, its own address is accepted', (await pvChat({ ALLOWED_ORIGIN: '', ALLOW_SELF_ORIGIN: 'true' }, { Origin: PV })) === 200);
  check('preview: other sites are still refused', (await pvChat({ ALLOWED_ORIGIN: '', ALLOW_SELF_ORIGIN: 'true' }, { Origin: 'https://evil.example' })) === 403);
  check('preview: the GitHub Pages site is refused by the preview (ALLOWED_ORIGIN empty)', (await pvChat({ ALLOWED_ORIGIN: '', ALLOW_SELF_ORIGIN: 'true' }, { Origin: O })) === 403);
  check('preview: a same-site request with no Origin is accepted (Sec-Fetch-Site)', (await pvChat({ ALLOWED_ORIGIN: '', ALLOW_SELF_ORIGIN: 'true' }, { 'Sec-Fetch-Site': 'same-origin' })) === 200);
  check('preview: no Origin and a cross-site marker is refused', (await pvChat({ ALLOWED_ORIGIN: '', ALLOW_SELF_ORIGIN: 'true' }, { 'Sec-Fetch-Site': 'cross-site' })) === 403);
  check('preview: the live Worker ignores Sec-Fetch-Site', (await pvChat({}, { 'Sec-Fetch-Site': 'same-origin' })) === 403);
}

// ----- tap-to-answer options on follow-up questions -----
reply = tool(reply0({ status: 'results', follow_up_questions: [] }));
r = await call('claude-sonnet-5-5');
{
  const fq = sent.tools[0].input_schema.properties.follow_up_questions;
  check('options: schema asks for { question, options } with 2-4 options', fq.items.type === 'object' && fq.items.required.join() === 'question,options' && fq.items.properties.options.minItems === 2 && fq.items.properties.options.maxItems === 4, JSON.stringify(fq.items));
}
reply = tool(reply0({ status: 'needs_more_info', message: 'Which town are you nearest to? Are you working at the moment?', matches: [], follow_up_questions: [
  { question: 'Which town are you nearest to?', options: ['Batley', 'Dewsbury', ' batley ', 'Huddersfield', 'Prefer not to say', 'Somewhere else in Kirklees', 'Holmfirth'] },
  { question: 'Are you working at the moment?', options: ['Working', 'x'.repeat(200), 'Other'] },
] }));
r = await call('claude-sonnet-5-5');
{
  const qo = r.body.question_options || [];
  check('options: plain question list still returned for the page', r.body.follow_up_questions.join('|') === 'Which town are you nearest to?|Are you working at the moment?', JSON.stringify(r.body.follow_up_questions));
  check('options: duplicates and "Prefer not to say" dropped, capped at 4', qo[0] && qo[0].options.join('|') === 'Batley|Dewsbury|Huddersfield|Somewhere else in Kirklees', JSON.stringify(qo[0]));
  check('options: long options cut to 80 characters, "Other" dropped', qo[1] && qo[1].options.length === 2 && qo[1].options[1].length === 80 && !qo[1].options.includes('Other'), JSON.stringify(qo[1]));
}
reply = tool(reply0({ status: 'needs_more_info', message: 'Which town?', matches: [], follow_up_questions: [{ question: 'Which town?', options: ['Batley'] }] }));
r = await call('claude-sonnet-5-5');
check('options: a single option is not enough -> question kept, no buttons', r.body.status === 'needs_more_info' && r.body.question_options[0].options.length === 0, JSON.stringify(r.body.question_options));
reply = tool(reply0({ status: 'needs_more_info', message: 'Which town?', matches: [], follow_up_questions: ['Which town?'] }));
r = await call('claude-sonnet-5-5');
check('options: a plain-text question from the model still works', r.body.status === 'needs_more_info' && r.body.follow_up_questions[0] === 'Which town?' && r.body.question_options[0].options.length === 0, JSON.stringify(r.body));
reply = tool(reply0({ urgent_support: true, urgent_types: ['medical'], status: 'needs_more_info', matches: [], follow_up_questions: [{ question: 'Where are you?', options: ['Batley', 'Dewsbury'] }] }));
r = await call('claude-sonnet-5-5');
check('options: urgent support -> no questions and no options', r.body.status === 'results' && r.body.question_options.length === 0 && r.body.follow_up_questions.length === 0, JSON.stringify(r.body));

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

// ----- Projects, sessions, venues and dates (site/listing-logic.js, shared with the page and the directory) -----
await import(pathToFileURL(path.join(root, 'site/listing-logic.js')).href);
const LS = globalThis.LISTING;
{
  const T = '2026-11-09';
  const s1 = { open: true, projects: [
    { id: 'a', name: 'A', overview: 'x' },
    { id: 'b', name: 'B', overview: 'x', referralsUntil: '2026-11-01' },
    { id: 'c', name: 'C', overview: 'x', referralsFrom: '2026-11-20' },
    { id: 'd', name: 'D', overview: 'x', referralsFrom: '2027-02-01' },
    { id: 'e', name: 'E', overview: 'x', runsTo: '2026-12-01', sessions: [{ id: 'e1', name: 'E1', age: '18 to 24' }, { id: 'e2', name: 'E2', runsTo: '2026-10-01' }, { id: 'e3', name: 'E3', age: '50+' }] },
    { id: 'f', name: 'F', overview: 'x', sessions: [{ id: 'f1', venue: 'v1', days: ['tue'], start: '13:00', end: '15:00' }, { id: 'f2', venue: 'v2', days: ['wed'], start: '13:00', end: '15:30' }] },
  ] };
  const st = Object.fromEntries(LS.parts(s1, T).map((x) => [x.project.id, x.state]));
  check('dates: blank is open, past close is closed, soon and later', st.a === 'open' && st.b === 'closed' && st.c === 'soon' && st.d === 'later' && st.e === 'open', JSON.stringify(st));
  check('dates: visible today is open and opening soon only', LS.visible(s1, T).map((x) => x.project.id).join() === 'a,c,e,f');
  check('dates: a session uses its project\'s date, or its own', LS.visible(s1, T).find((x) => x.project.id === 'e').sessions.map((c) => c.session.id).join() === 'e1,e3');
  check('dates: the service shows while anything is open', LS.isShown(s1, T) && !LS.isShown({ ...s1, open: false }, T) && !LS.isShown({ open: true, projects: [s1.projects[1]] }, T));
  check('dates: closed on the day after the date, not on it', LS.state({ runsTo: T }, T) === 'open' && LS.state({ runsTo: T }, '2026-11-10') === 'closed');
  check('sessions: picking a session for a group shows just that group (a 20-year-old sees no 50+ group)', JSON.stringify(LS.pick(s1, ['e1'], T).map((x) => [x.project.id, x.sessions.map((c) => c.session.id)])) === '[["e",["e1"]]]');
  check('sessions: picking a time and place puts it first and keeps the others', JSON.stringify(LS.pick(s1, ['f2'], T).map((x) => x.sessions.map((c) => c.session.id + (c.named ? '*' : '')))) === '[["f2*","f1"]]');
  check('dates: picking nothing (or nothing real) shows everything visible', LS.pick(s1, [], T).length === 4 && LS.pick(s1, ['zzz'], T).length === 4);
  check('dates: picking a project shows all its open sessions', LS.pick(s1, ['e'], T)[0].sessions.length === 2);
  const ends = LS.endingSoon(s1, T).map((x) => x.project.id + (x.session ? '/' + x.session.id : '') + ':' + x.kind + ':' + x.daysLeft);
  check('dates: ending in the next 30 days (a project once, not again for each session)', ends.join() === 'e:ends:22', ends.join());
  check('dates: closed parts listed for Admin', LS.closedParts(s1, T).map((x) => x.project.id + (x.session ? '/' + x.session.id : '')).join() === 'b,e/e2');
  check('dates: plain words', LS.dateWords({ referralsFrom: '2026-11-20', referralsUntil: '2027-03-01' }, T).join('; ') === 'Referrals open from 20 November 2026; Taking referrals until 1 March 2027');
  check('dates: checks catch duplicates and wrong order', LS.checkParts([{ id: 'a', name: 'A', runsFrom: '2027-01-02', runsTo: '2027-01-01' }, { id: 'a', name: 'B' }]).length === 2);
  check('sessions: days and times in words', LS.timeWords({ days: ['tue', 'thu'], start: '13:00', end: '15:30', frequency: 'fortnightly' }) === 'Tuesdays and Thursdays, 1pm to 3.30pm, every other week' && LS.timeWords({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:30', end: '15:00' }) === 'Monday to Friday, 9.30am to 3pm' && LS.timeWords({}) === '');
  check('sessions: finishing before starting is caught', /finishes before it starts/.test(LS.checkParts([{ id: 'p', name: 'P', sessions: [{ id: 's', start: '15:00', end: '13:00' }] }]).join()));
  check('venues: one line with the postcode once', LS.venueLine({ name: 'Jo Cox House', address: 'Jo Cox House, Market Square, Batley', postcode: 'WF17 5DR' }) === 'Jo Cox House, Market Square, Batley, WF17 5DR' && LS.venueLine({ name: 'Hall', address: 'Hall, Road, HD1 1AA', postcode: 'HD1 1AA' }) === 'Hall, Road, HD1 1AA');
  check('groups: the agreed list, with "everyone"', LS.GROUPS.everyone === 'Everyone (no restriction)' && ['children', 'young-people', 'adults', 'older-people', 'families', 'parents', 'mothers', 'fathers', 'lgbtq', 'students'].every((g) => LS.GROUPS[g]));
}
check('data: every live service has at least one project', svc.every((x) => Array.isArray(x.projects) && x.projects.length));
check('data: no status, activities or cohorts left', svc.every((x) => !('status' in x) && !('activities' in x) && x.projects.every((p) => !('cohorts' in p))));
check('data: Raise Your Game is one project with two age-group sessions at one venue', (() => { const p = svc.find((x) => x.id === 'raise-your-game').projects; return p.length === 1 && JSON.stringify(p[0].sessions.map((c) => [c.age, c.venue])) === '[["18 to 24","leeds-road-sports-complex"],["50+","leeds-road-sports-complex"]]'; })());
check('data: the P2P projects stop taking referrals on 1 March 2027', ['p2p-fusion-housing', 'p2p-proper-job'].every((id) => svc.find((x) => x.id === id).projects[0].referralsUntil === '2027-03-01'));
check('data: organisations carry no Healthy Working Life marker', JSON.parse(fs.readFileSync(path.join(root, 'data/organisations.json'), 'utf8')).organisations.every((o) => !('hwlFunded' in o) && !/healthy working life/i.test(o.overview || '')));
check('data: every venue a live service uses is in services.json', (() => { const ids = new Set(JSON.parse(fs.readFileSync(path.join(root, 'data/services.json'), 'utf8')).venues.map((v) => v.id)); return svc.every((x) => LS.venueIds(x).every((v) => ids.has(v))); })());
{
  // What the AI is sent today: no team notes, closed projects left out, a status on each project, venues in words.
  reply = tool(reply0());
  await call('claude-sonnet-5-5');
  const dataText = sent.system[1].text;
  const sentData = JSON.parse(dataText.slice(dataText.indexOf('\n') + 1));
  const ryg = sentData.find((x) => x.id === 'raise-your-game');
  check('ai data: projects and sessions sent with a status', ryg.projects[0].status === 'open' && ryg.projects[0].sessions.length === 2 && ryg.projects[0].sessions.every((c) => c.status === 'open'), JSON.stringify(ryg.projects).slice(0, 300));
  check('ai data: a session\'s venue is sent in words, not as an id', /Leeds Road Sports Complex.*HD2 1YY/.test(ryg.projects[0].sessions[0].venue), ryg.projects[0].sessions[0].venue);
  check('ai data: no team notes, map buttons, listing decision or organisation overview', sentData.every((x) => !('notes' in x) && !('mapLinks' in x) && !('listing' in x) && !('organisationOverview' in x)));
  check('ai data: the date is in the data heading', dataText.startsWith('SERVICE DATA (JSON) for ' + new Date().toISOString().slice(0, 10)));
  check('ai data: the reply tool asks which projects or sessions fit', Boolean(sent.tools[0].input_schema.properties.matches.items.properties.parts));
  check('prompt: explains projects, sessions and parts', /"parts"/.test(sent.system[0].text) && /"sessions"/.test(sent.system[0].text) && /referrals open later/.test(sent.system[0].text));
}
reply = tool(reply0({ matches: [{ ...m('raise-your-game'), parts: ['cohort-1', 'nonsense', 'cohort-1'] }] }));
r = await call('claude-sonnet-5-5', { messages: [{ role: 'user', content: 'I am 20, not working, with a health condition, in Huddersfield' }] });
check('parts: only real, open project or session ids are passed on, once each', JSON.stringify(r.body.recommendations[0].parts) === '["cohort-1"]', JSON.stringify(r.body.recommendations));
check('parts: the reply says which day it was worked out for', r.body.date === new Date().toISOString().slice(0, 10));
reply = tool(reply0({ matches: [m('raise-your-game')] }));
r = await call('claude-sonnet-5-5');
check('parts: none given is an empty list (the page shows everything open)', Array.isArray(r.body.recommendations[0].parts) && !r.body.recommendations[0].parts.length);

// ----- Team issues log -----
const mkStore = () => {
  const mem = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => mem.has(x)).map((x) => [x, mem.get(x)])) : mem.get(k)),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) mem.set(a, b); else mem.set(k, v); },
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

// ----- Listing decisions (development team) -----
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
check('edits: bad website refused', /website/i.test(await editErr({ webpage: 'www.example.org' })));
check('edits: bad email refused', /email/i.test(await editErr({ email: 'nope' })));
check('edits: empty name refused', /can't be empty/.test(await editErr({ name: '  ' })));
check('edits: categories need at least one', /at least one/.test(await editErr({ categories: [] })));
check('edits: each project needs an overview', /overview/.test(await editErr({ projects: [{ id: 'x', name: 'x', overview: '' }] })));
// Projects, sessions, venues and dates.
const proj = (o = {}) => ({ id: 'job-club', name: 'Job club', overview: 'CV help.', ...o });
check('edits: a project with sessions for groups and dates is accepted', !(await editErr({ projects: [proj({ referralsUntil: '2027-03-01', sessions: [{ id: 'cohort-1', name: 'Cohort 1', age: '18 to 24', eligibility: ['Aged 18 to 24'] }] })] })));
check('edits: a session at a venue with days, times and how often is accepted, including a new venue written out', !(await editErr({ projects: [proj({ runs: ['set', 'appointment'], area: 'All of Kirklees', sessions: [{ id: 'tue', venue: 'leeds-road-sports-complex', days: ['tue'], start: '13:00', end: '15:00', frequency: 'weekly' }, { id: 'wed', venue: { name: 'New Hall', address: '1 New Road, Batley', postcode: 'wf17 5dr' }, days: ['wed'], start: '10:00', end: '12:00', note: 'Bring a packed lunch' }] })] })));
check('edits: a new venue needs a full postcode', /postcode/.test(await editErr({ projects: [proj({ sessions: [{ id: 's', venue: { name: 'Hall', address: 'Road', postcode: 'WF17' } }] })] })));
check('edits: times must be like 13:30, and finish after they start', /like 13:30/.test(await editErr({ projects: [proj({ sessions: [{ id: 's', start: '1pm' }] })] })) && /finishes before it starts/.test(await editErr({ projects: [proj({ sessions: [{ id: 's', start: '15:00', end: '13:00' }] })] })));
check('edits: days, how often and how it runs must be from the lists', /days/.test(await editErr({ projects: [proj({ sessions: [{ id: 's', days: ['tuesday'] }] })] })) && /How often/.test(await editErr({ projects: [proj({ sessions: [{ id: 's', frequency: 'daily' }] })] })) && /runs/.test(await editErr({ projects: [proj({ runs: ['sometimes'] })] })));
check('edits: who it\'s for groups must be from the list', !(await editErr({ groups: ['women', 'everyone'] })) && /isn't allowed/.test(await editErr({ groups: ['aliens'] })));
check('edits: venues used by every project can be ids or new ones', !(await editErr({ venues: ['leeds-road-sports-complex', { name: 'Hall', address: '1 Road, Dewsbury', postcode: 'WF12 8DJ' }] })));
check('edits: a date must be real', /real date/.test(await editErr({ projects: [proj({ runsTo: '2027-02-31x' })] })));
check('edits: a project can\'t end before it starts', /ends before it starts/.test(await editErr({ projects: [proj({ runsFrom: '2027-03-01', runsTo: '2027-01-01' })] })));
check('edits: a session uses its project\'s dates when checking the order', /stops taking referrals before it starts/.test(await editErr({ projects: [proj({ referralsFrom: '2027-03-01', sessions: [{ id: 'c1', name: 'C1', referralsUntil: '2027-01-01' }] })] })));
check('edits: project and session ids are unique in a service', /used twice/.test(await editErr({ projects: [proj(), proj({ name: 'Other' })] })));
check('edits: a project can\'t carry other details', /can't be set/.test(await editErr({ projects: [proj({ status: 'Live' })] })));
check('edits: a session can\'t carry other details', /can't be set/.test(await editErr({ projects: [proj({ sessions: [{ id: 'c1', name: 'C1', overview: 'x' }] })] })));
check('edits: a new project overview over 400 characters is refused', /too long/.test(await editErr({ projects: [proj({ overview: 'x'.repeat(401) })] })));
{
  // Text already in the data over the limit can be sent back unchanged (wellness-to-work's overview is 420).
  const w2w = svc.find((x) => x.id === 'wellness-to-work');
  const r2 = await logCall('PUT', '/log/edits/wellness-to-work', { changes: { projects: w2w.projects, phone: '01484 999999' }, before: {}, note: 'New phone', by: 'PL' });
  check('edits: an overview already over the limit can be kept as it is', r2.status === 200 && w2w.projects[0].overview.length > 400, JSON.stringify(r2.body));
  await logCall('DELETE', '/log/edits/wellness-to-work', { by: 'PL' });
}
check('edits: who it\'s for over 300 characters is refused when changed', /too long/.test(await editErr({ whoFor: 'x'.repeat(301) })));
check('edits: an organisation overview over 300 characters is refused', /too long/.test(await editErr({ organisationOverview: 'x'.repeat(301) })));
check('edits: an organisation overview may not say Healthy Working Life (that is marked on each service)', /Healthy Working Life/.test(await editErr({ organisationOverview: 'A charity delivering Healthy Working Life projects.' })) && /Healthy Working Life/.test(await editErr({ organisationOverview: 'Part of HWL.' })));
check('edits: the team can set team-only details', !(await editErr({ hwlFunded: true, mapLinks: false, notes: 'Team note', coachNotes: 'Bring ID' })));
check('edits: a reason is needed', /what changed/.test(await editErr(goodEdit.changes, { note: '' })));
check('edits: where you checked must be a web address', /web address/.test(await editErr(goodEdit.changes, { checkedUrl: 'the website' })));
r = await logCall('PUT', '/log/edits/kbop', { ...goodEdit, changes: { ...goodEdit.changes, phone: '01484 111111' }, by: 'AB' });
check('edits: a second change replaces the first and keeps it in history', r.body.item.changes.phone === '01484 111111' && r.body.item.history.length >= 1);
r = await logCall('GET', '/log/edits', null, { origin: null });
check('edits: a script (no Origin) can read them', r.status === 200 && r.body.edits.kbop);
r = await logCall('PUT', '/log/edits/kbop', goodEdit, { origin: null });
check('edits: but not change them without the page origin', r.status === 403);
r = await logCall('DELETE', '/log/edits/kbop', { by: 'PL' });
check('edits: discard', r.status === 200 && Object.keys((await logCall('GET', '/log/edits')).body.edits).length === 0);
r = await logCall('DELETE', '/log/edits/kbop', { by: 'PL' });
check('edits: discarding twice -> 404', r.status === 404);

// "checked and still right", with no changes (for example a provider said it's all correct)
r = await logCall('PUT', '/log/edits/kbop', { changes: {}, before: {}, note: 'Provider said all correct', by: 'PL', checked: true });
check('edits: no changes allowed when recording a check', r.status === 200 && Object.keys(r.body.item.changes).length === 0 && r.body.item.checked === true, JSON.stringify(r.body));
r = await logCall('PUT', '/log/edits/kbop', { changes: {}, before: {}, note: 'Nothing', by: 'PL', checked: false });
check('edits: no changes refused when not recording a check', r.status === 400);
await logCall('DELETE', '/log/edits/kbop', { by: 'PL' });

// ----- Provider review links -----
const liveSvc = JSON.parse(fs.readFileSync(path.join(root, 'data/services.json'), 'utf8')).services.find((x) => x.hwlFunded) ;
const provCall = async (method, token, body, { e = logEnv(), origin = O } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.Origin = origin;
  const res = await worker.fetch(new Request('https://w/provider/' + token, { method, headers, body: body ? JSON.stringify(body) : undefined }), e);
  return { status: res.status, body: await res.json() };
};
r = await logCall('POST', '/log/provider-links', { id: liveSvc.id, contact: 'Sam Provider', days: 30, by: 'PL' });
check('plinks: team can make a link for a live service', r.status === 201 && /^[A-Za-z0-9_-]{32}$/.test(r.body.link.token) && r.body.link.contact === 'Sam Provider', JSON.stringify(r.body));
const tok = r.body.link.token;
check('plinks: link expires in about 30 days', Math.abs(Date.parse(r.body.link.expires) - Date.now() - 30 * 86400000) < 60000);
r = await logCall('POST', '/log/provider-links', { id: 'not-a-service', contact: 'Sam', by: 'PL' });
check('plinks: not for a service that is not live', r.status === 400);
r = await logCall('POST', '/log/provider-links', { id: liveSvc.id, contact: '', by: 'PL' });
check('plinks: needs the contact name', r.status === 400);
r = await logCall('POST', '/log/provider-links', { id: liveSvc.id, contact: 'Sam' }, { pass: 'nope' });
check('plinks: making one needs the passcode', r.status === 401);
r = await provCall('GET', tok);
check('plinks: provider sees the service, the contact name and the choices', r.status === 200 && r.body.service.id === liveSvc.id && r.body.contact === 'Sam Provider' && r.body.choices.healthFocus.includes('any') && r.body.organisations.length > 100 && r.body.lastReply === null, JSON.stringify(r.body).slice(0, 200));
check('plinks: provider doesn\'t see provenance, listing, trigger words or team notes', !('provenance' in r.body.service) && !('listing' in r.body.service) && !('requiresMention' in r.body.service) && !('notes' in r.body.service) && !('categories' in r.body.service));
r = await provCall('GET', tok, null, { origin: null });
check('plinks: needs the page origin', r.status === 403);
r = await provCall('GET', 'x'.repeat(32));
check('plinks: unknown code -> 404', r.status === 404);
r = await provCall('GET', 'short');
check('plinks: malformed code -> 404', r.status === 404);
r = await provCall('GET', tok, null, { e: { ...logEnv(), TEAM_PASSCODE: undefined } });
check('plinks: off when no TEAM_PASSCODE', r.status === 404);
r = await provCall('POST', tok, { allCorrect: true, note: 'All fine', name: 'Sam P' });
check('plinks: provider can say all correct', r.status === 200 && r.body.ok);
r = await provCall('POST', tok, { changes: { phone: '01484 222222', eligibility: ['Lives in Kirklees'] }, note: 'New number', name: 'Sam P' });
check('plinks: provider can send changes', r.status === 200);
r = await provCall('POST', tok, { changes: { level: 'national' } });
check('plinks: provider can\'t change team-only fields', r.status === 400 && /can't be changed/.test(r.body.error));
for (const k of ['areas', 'categories', 'notes', 'hwlFunded']) {
  r = await provCall('POST', tok, { changes: { [k]: k === 'hwlFunded' ? true : k === 'notes' ? 'x' : ['Batley'] } });
  check('plinks: provider can\'t change ' + k, r.status === 400 && /can't be changed/.test(r.body.error));
}
r = await provCall('POST', tok, { changes: { organisationOverview: 'We run community projects across Kirklees.', projects: [{ id: 'p1', name: 'Project one', overview: 'Weekly sessions.', referralsUntil: '2027-03-01' }] }, note: 'Updated', name: 'Sam P' });
check('plinks: provider can change the organisation overview and projects', r.status === 200, JSON.stringify(r.body));
r = await provCall('POST', tok, { changes: { email: 'nope' } });
check('plinks: provider changes checked like team edits', r.status === 400 && /email/i.test(r.body.error));
r = await provCall('POST', tok, { changes: {}, note: '' });
check('plinks: nothing changed and no comment refused', r.status === 400);
r = await provCall('POST', tok, { changes: {}, note: 'The venue is wrong but I am not sure what to put' });
check('plinks: a comment alone is accepted', r.status === 200);
r = await logCall('GET', '/log/provider-links');
const gotLink = r.body.links.find((l) => l.token === tok);
check('plinks: team sees the replies, with old values', r.status === 200 && gotLink.replies.length === 4 && gotLink.replies[0].allCorrect === true && gotLink.replies[1].changes.phone === '01484 222222' && 'phone' in gotLink.replies[1].before && gotLink.replies[1].name === 'Sam P', JSON.stringify(gotLink).slice(0, 300));
r = await provCall('GET', tok);
check('plinks: provider sees their last reply', r.body.lastReply && r.body.lastReply.allCorrect === false);
r = await logCall('POST', '/log/provider-links/' + tok + '/cancel', { by: 'PL' });
check('plinks: team can cancel a link', r.status === 200 && r.body.link.cancelled.by === 'PL');
r = await provCall('GET', tok);
check('plinks: cancelled link stops working', r.status === 404);
r = await provCall('POST', tok, { allCorrect: true });
check('plinks: and can\'t be replied to', r.status === 404);
r = await logCall('POST', '/log/provider-links', { id: liveSvc.id, contact: 'Old', days: 7, by: 'PL' });
const oldLink = r.body.link;
await store.ctx.storage.put('plink:' + oldLink.token, { ...oldLink, expires: new Date(Date.now() - 1000).toISOString() });
r = await provCall('GET', oldLink.token);
check('plinks: expired link stops working', r.status === 404);

// new services added by the team
const newSvc = () => ({
  name: 'Batley Job Club', organisation: 'Batley Community Centre', open: true, level: 'local', audience: ['individual'],
  categories: ['Finding work'], whoFor: 'Anyone in Batley looking for work.', age: null, webpage: 'https://batleyjobclub.example', email: null, phone: '01924 000000',
  social: [], locations: ['Batley Community Centre, Tuesdays 10am to 12pm'], areas: ['Batley'], eligibility: [], exclusions: [], gate: [], healthFocus: [],
  referralRoutes: ['Drop in'], selfReferral: { allowed: 'yes', note: 'Just turn up' }, projects: [{ id: 'job-club', name: 'Job club', overview: 'CV help and job search.', duration: 'Weekly' }],
  workExperience: 'No', cost: 'Free', languages: null, notes: null, reviewCycle: 'Quarterly',
});
r = await logCall('GET', '/log/new');
check('new: empty to start', r.status === 200 && Object.keys(r.body.added).length === 0);
r = await logCall('PUT', '/log/new/batley-job-club', { service: newSvc(), note: 'Suggested by a work coach', by: 'PL', checkedUrl: 'https://batleyjobclub.example' });
check('new: saved, with who added it', r.status === 200 && r.body.item.service.name === 'Batley Job Club' && r.body.item.createdBy === 'PL', JSON.stringify(r.body).slice(0, 300));
r = await logCall('PUT', '/log/new/batley-job-club', { service: { ...newSvc(), phone: '01924 111111' }, note: 'Phone corrected', by: 'AB' });
check('new: saving again updates it but keeps who first added it', r.body.item.service.phone === '01924 111111' && r.body.item.createdBy === 'PL' && r.body.item.by === 'AB' && r.body.item.history.length === 1);
const missing = newSvc(); delete missing.referralRoutes;
r = await logCall('PUT', '/log/new/batley-job-club', { service: missing, note: 'x y z', by: 'PL' });
check('new: every required field must be there', r.status === 400 && /How people are referred/.test(r.body.error), JSON.stringify(r.body));
r = await logCall('PUT', '/log/new/batley-job-club', { service: { ...newSvc(), listing: { decision: 'include' } }, note: 'x y z', by: 'PL' });
check('new: can\'t set its own listing decision', r.status === 400);
r = await logCall('PUT', '/log/new/acas-helpline', { service: newSvc(), note: 'x y z', by: 'PL' });
check('new: an id already used by a live service is refused', r.status === 409);
r = await logCall('PUT', '/log/new/batley-job-club', { service: newSvc(), note: '', by: 'PL' });
check('new: needs to say where it came from', r.status === 400);
r = await logCall('GET', '/log/new', null, { origin: null });
check('new: a script (no Origin) can read them', r.status === 200 && r.body.added['batley-job-club']);
r = await logCall('DELETE', '/log/new/batley-job-club', { by: 'PL' });
check('new: discard', r.status === 200 && Object.keys((await logCall('GET', '/log/new')).body.added).length === 0);

// apply-decisions.mjs, on a copy of a few scheme files
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-'));
  for (const id of ['kbop', 'samaritans-helpline', 'acas-helpline', 'hopeline247-papyrus']) fs.copyFileSync(path.join(root, 'data/services', id + '.json'), path.join(d, id + '.json'));
  fs.copyFileSync(path.join(root, 'data/organisations.json'), path.join(d, 'organisations.json'));
  const realOrgs = fs.readFileSync(path.join(root, 'data/organisations.json'), 'utf8');
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
    projects: [{ id: 'key-worker-support', name: 'Key worker support', overview: 'One-to-one help.' }], phone: '01484 000000', notes: null,
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
  // new services: created as files, waiting for review unless the team also decided
  const newOne = { ...newSvc(), cost: 'Free', notes: null };
  fs.writeFileSync(inp, JSON.stringify({
    added: {
      'batley-job-club': { service: newOne, note: 'Suggested by a work coach', by: 'AB', createdBy: 'PL', created: '2026-10-17T09:00:00Z', t: '2026-10-17T10:00:00Z', checkedUrl: 'https://batleyjobclub.example' },
      'kbop-copy': { service: { ...newOne, name: kb2.name, organisation: kb2.organisation }, note: 'Dupe', by: 'AB', createdBy: 'AB', t: '2026-10-17T10:00:00Z' },
      kbop: { service: newOne, note: 'Id clash', by: 'AB', createdBy: 'AB', t: '2026-10-17T10:00:00Z' },
      'bad-new': { service: { ...newOne, name: 'Bad one', areas: ['Leeds'] }, note: 'Bad', by: 'AB', createdBy: 'AB', t: '2026-10-17T10:00:00Z' },
      'second-new': { service: { ...newOne, name: 'Second new club' }, note: 'Another', by: 'AB', createdBy: 'AB', t: '2026-10-17T10:00:00Z' },
    },
    decisions: { 'second-new': { decision: 'include', by: 'PL', t: '2026-10-17T11:00:00Z' } },
  }));
  const out3 = run();
  const bj = JSON.parse(fs.readFileSync(path.join(d, 'batley-job-club.json'), 'utf8'));
  check('apply new: file created, waiting for review, with provenance', bj.id === 'batley-job-club' && bj.listing.decision === 'review' && bj.hwlFunded === false && bj.provenance.source.includes('PL') && bj.provenance.checkedUrl === 'https://batleyjobclub.example' && !('notes' in bj) && bj.lastUpdated === '2026-10-17', JSON.stringify(bj).slice(0, 400));
  check('apply new: fields in the usual order', Object.keys(bj).slice(0, 4).join() === 'id,name,organisation,open', Object.keys(bj).join());
  check('apply new: a team decision to include applies straight away', JSON.parse(fs.readFileSync(path.join(d, 'second-new.json'), 'utf8')).listing.decision === 'include');
  check('apply new: duplicate name, id clash and schema failure reported, not created', !fs.existsSync(path.join(d, 'kbop-copy.json')) && !fs.existsSync(path.join(d, 'bad-new.json')) && out3.includes('same name and organisation') && out3.includes('already in the data') && out3.includes('Bad one'), out3);
  check('apply new: running again doesn\'t create it twice', /0 new services added, 2 already added/.test(run()), run());
  fs.rmSync(d, { recursive: true, force: true });
}

// ----- User feedback -----
const FB_PASS = PASS; // one team passcode for every Admin area
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
  TEAM_PASSCODE: FB_PASS,
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
const gapFb = (o = {}) => ({ kind: 'gap', reasons: ['missing-service'], missedService: { name: 'Batley Job Club', website: 'https://example.org/job-club', area: 'Batley', role: 'suggester', organisation: 'Batley Trust' }, lang: 'en', mode: 'staff', ...o });

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
const KEYS = ['id', 'kind', 'date', 'schemeIds', 'recordLastUpdated', 'helpful', 'reasons', 'text', 'missedService', 'gapCategories', 'gapArea', 'contacted', 'ease', 'contact', 'lang', 'mode', 'site', 'redacted', 'status', 'note'].sort().join();
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
  ['extra service field', gapFb({ missedService: { name: 'x', secret: 'not a field' } })],
  ['a service with no name', gapFb({ missedService: { website: 'https://example.org' } })],
  ['"a service" ticked with no details at all', gapFb({ missedService: undefined })],
  ['unknown role', gapFb({ missedService: { name: 'x', role: 'boss' } })],
  ['no "from the service or suggesting it"', gapFb({ missedService: { name: 'Batley Job Club', organisation: 'Batley Trust' } })],
  ['no organisation', gapFb({ missedService: { name: 'Batley Job Club', role: 'suggester' } })],
  ['conditions without "a specific condition"', gapFb({ missedService: { name: 'x', organisation: 'y', role: 'provider', healthNeed: 'any', conditions: 'Back pain' } })],
  ['conditions too long', gapFb({ missedService: { name: 'x', organisation: 'y', role: 'provider', healthNeed: 'specific', conditions: 'c'.repeat(301) } })],
  ['unknown health need', gapFb({ missedService: { name: 'x', healthNeed: 'some' } })],
  ['unknown audience', gapFb({ missedService: { name: 'x', audience: ['everyone'] } })],
  ['unknown category in service details', gapFb({ missedService: { name: 'x', categories: ['Juggling'] } })],
  ['bad service email', gapFb({ missedService: { name: 'x', email: 'not an email' } })],
  ['description too long', gapFb({ missedService: { name: 'x', description: 'd'.repeat(801) } })],
  ['noMap not true/false', gapFb({ missedService: { name: 'x', noMap: 'yes' } })],
  ['a date that is not a date', gapFb({ missedService: { name: 'x', organisation: 'y', role: 'provider', runsFrom: 'next week' } })],
  ['an end date before the start date', gapFb({ missedService: { name: 'x', organisation: 'y', role: 'provider', runsFrom: '2027-03-01', runsTo: '2027-01-01' } })],
  ['referrals closing before they open', gapFb({ missedService: { name: 'x', organisation: 'y', role: 'provider', referralsFrom: '2027-03-01', referralsUntil: '2027-01-01' } })],
  ['"a new project of" a service not in the data', gapFb({ missedService: { name: 'x', organisation: 'y', role: 'provider', addTo: 'not-a-scheme' } })],
  ['taking referrals not yes or no', gapFb({ missedService: { name: 'x', organisation: 'y', role: 'provider', open: 'maybe' } })],
  ['project overview too long', gapFb({ missedService: { name: 'x', organisation: 'y', role: 'provider', projectOverview: 'p'.repeat(401) } })],
  ['organisation overview too long', gapFb({ missedService: { name: 'x', organisation: 'y', role: 'provider', organisationOverview: 'o'.repeat(301) } })],
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
r = await send(gapFb({ missedService: { name: '  Spaced out  ', website: 'http://example.org', role: 'suggester', organisation: 'Org' } }));
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
r = await send(gapFb({ missedService: { name: 'Call Sue on 07700900123', website: 'https://example.org', role: 'suggester', organisation: 'Org' } }));
all = await items();
check('redaction: also applied to the service name', all[6].missedService.name === 'Call Sue on [removed]' && all[6].redacted === true);
// A full suggestion from a service: every detail kept, its own contact details as written.
const fullService = { name: 'Shared Hope', role: 'provider', organisation: 'Shared Goods Charity', website: 'https://example.org', area: 'Huddersfield', description: 'Support for refugees.', activities: 'Weekly sessions for six months.', running: 'now', dates: '1 Oct 2026 to 31 Mar 2027, 10 places', age: '18+', eligibility: 'Refugees living in Kirklees', exclusions: 'None', healthNeed: 'specific', conditions: 'Back, neck or joint pain', audience: ['individual'], categories: ['Refugees and new arrivals', 'Wellbeing'], addresses: 'Packhorse Shopping Centre, Huddersfield HD1 2RT', noMap: true, level: 'local', phone: '07825 547938', email: 'hello@example.org', social: '@sharedgoods', referral: 'Phone or email us', selfReferral: 'yes', cost: 'Free', languages: 'English, Arabic', workExperience: 'Volunteering', logoOk: true, contactName: 'Christina' };
r = await send(gapFb({ missedService: fullService, text: 'Thanks' }));
all = await items();
const got = all[all.length - 1].missedService;
check('suggestion: a full service suggestion is accepted (201)', r.status === 201, JSON.stringify(r.body));
check('suggestion: every detail stored', Object.keys(fullService).every((k) => JSON.stringify(got[k]) === JSON.stringify(fullService[k])), JSON.stringify(got));
check('suggestion: the service\'s own phone, email and address are kept, not removed', got.phone === '07825 547938' && got.email === 'hello@example.org' && got.addresses.includes('HD1 2RT') && all[all.length - 1].redacted === false);
r = await send(gapFb({ missedService: { ...fullService, description: 'x'.repeat(800), activities: 'y'.repeat(1200), eligibility: 'z'.repeat(800) } }));
check('suggestion: a long suggestion (over 4 KB) is allowed', r.status === 201, String(r.status));
r = await fbCall('POST', '/feedback', null, { raw: JSON.stringify(cardFb({ text: 'x'.repeat(5000) })) });
check('suggestion: other feedback is still limited to 4 KB', r.status === 413);
// A full suggestion in the listing's shape: organisation, service, project, dates, and "a new project of".
r = await send(gapFb({ missedService: { name: 'Raise Your Game', organisation: 'Huddersfield Town Foundation', role: 'provider', addTo: 'raise-your-game', organisationOverview: 'The charity of the football club.', whoFor: 'Adults out of work.', open: 'yes',
  projectName: 'Cohort 3', projectOverview: 'Ten weeks of sessions.', where: 'Leeds Road, HD1 6PX', when: 'Mondays 10am', duration: '10 weeks', places: '15 places', runsFrom: '2027-01-11', runsTo: '2027-03-15', referralsUntil: '2027-01-04',
  gate: 'Lives in Kirklees', coachNotes: 'Bring trainers.' } }));
all = await items();
const full = all[all.length - 1].missedService;
check('feedback: a suggestion in the listing shape is kept as written (project, dates, new project of a listed service)', r.status === 201 && full && full.addTo === 'raise-your-game' && full.projectName === 'Cohort 3' && full.runsFrom === '2027-01-11' && full.referralsUntil === '2027-01-04' && full.open === 'yes' && full.gate === 'Lives in Kirklees' && full.coachNotes === 'Bring trainers.' && full.organisationOverview === 'The charity of the football club.', JSON.stringify(full));
check('feedback: a suggestion from an older page (description, activities, running) is still accepted', (await send(gapFb({ missedService: { name: 'Old page', organisation: 'Org', role: 'suggester', description: 'Helps people.', activities: 'Weekly club', running: 'now', dates: 'From March', addresses: 'Batley' } }))).status === 201);
const csvAll = (await fbCall('GET', '/feedback/export.csv', null, { pass: FB_PASS })).body;
check('suggestion: CSV has the extra details column', csvAll.includes('"missedServiceDetails"') && csvAll.includes('organisation: Shared Goods Charity'), csvAll.slice(0, 300));
r = await send(cardFb({ text: 'Number was [removed]' }));
all = await items();
check('redaction: text the page already redacted is marked redacted', all[all.length - 1].redacted === true && all[all.length - 1].text === 'Number was [removed]');
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
r = await fbCall('GET', '/feedback/items', null, { pass: FB_PASS, e: fbEnv({ TEAM_PASSCODE: undefined }) });
check('feedback: read routes 404 with no TEAM_PASSCODE set', r.status === 404);
r = await fbCall('GET', '/feedback/export.csv', null, { pass: 'x', e: fbEnv({ TEAM_PASSCODE: undefined }) });
check('feedback: CSV 404 with no TEAM_PASSCODE set', r.status === 404);
r = await fbCall('PATCH', '/feedback/items/1', { status: 'Reviewed' }, { pass: 'x', e: fbEnv({ TEAM_PASSCODE: undefined }) });
check('feedback: PATCH 404 with no TEAM_PASSCODE set', r.status === 404);
r = await send(cardFb(), { e: fbEnv({ TEAM_PASSCODE: undefined }) });
check('feedback: sending still works with no TEAM_PASSCODE set', r.status === 201);
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
check('feedback: CSV export has a header, one row per entry and a download name', r.status === 200 && r.body.startsWith('"id","date","kind"') && r.body.trim().split('\r\n').length === 7 && /attachment; filename="support-finder-feedback-\d{4}-\d{2}-\d{2}\.csv"/.test(r.headers.get('content-disposition')), r.body.slice(0, 200));
check('feedback: CSV neutralises a leading "=" (formula injection)', r.body.includes("\"'=HYPERLINK"));
const pre2 = await worker.fetch(new Request('https://w/feedback/items', { method: 'OPTIONS', headers: { Origin: O } }), fbEnv());
check('feedback: preflight allows x-feedback-passcode', pre2.status === 204 && pre2.headers.get('Access-Control-Allow-Headers').includes('x-feedback-passcode'));
// one passcode: the team passcode opens feedback and usage, with either header name; an old separate one doesn't
r = await fbCall('GET', '/feedback/items', null, { pass: PASS });
check('one passcode: the team passcode reads feedback', r.status === 200);
{
  const res = await worker.fetch(new Request('https://w/feedback/items', { headers: { Origin: O, 'x-team-passcode': PASS } }), fbEnv());
  check('one passcode: x-team-passcode header works for feedback', res.status === 200);
  const old = await worker.fetch(new Request('https://w/feedback/items', { headers: { Origin: O, 'x-feedback-passcode': 'the old feedback passcode' } }), fbEnv({ FEEDBACK_PASSCODE: 'the old feedback passcode' }));
  check('one passcode: a leftover FEEDBACK_PASSCODE no longer opens anything', old.status === 401);
}

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
  gapFb(), gapFb({ missedService: { name: 'batley job club', website: '', role: 'suggester', organisation: 'Batley Trust' } }), gapFb({ missedService: { name: 'Wellness to Work', website: 'https://www.locala.org.uk/services/wellness-to-work', role: 'provider', organisation: 'Locala' } }),
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

// ----- Allowed origins: the site's own domain and GitHub Pages -----
{
  const toml = fs.readFileSync(path.join(root, 'worker/wrangler.toml'), 'utf8');
  const live = toml.match(/^ALLOWED_ORIGIN = "([^"]*)"/m)[1];
  const at = async (origin, list = live) => worker.fetch(new Request('https://w/health', { headers: { Origin: origin } }), { ...env('claude-sonnet-5-5'), ALLOWED_ORIGIN: list });
  for (const o of ['https://hwlsupportfinder.org.uk', 'https://www.hwlsupportfinder.org.uk', 'http://hwlsupportfinder.org.uk', O]) {
    const r = await at(o);
    check('origins: live config accepts ' + o, r.headers.get('Access-Control-Allow-Origin') === o);
  }
  for (const o of ['https://example.com', 'https://hwlsupportfinder.org.uk.evil.com', 'https://hwlsupportfinder.org.uk/', '']) {
    const r = await at(o);
    check('origins: refuses ' + JSON.stringify(o), r.headers.get('Access-Control-Allow-Origin') === null);
  }
  const r = await at('https://b.example', ' https://a.example , https://b.example ');
  check('origins: list is comma-separated and spaces are ignored', r.headers.get('Access-Control-Allow-Origin') === 'https://b.example');
  const pre = await worker.fetch(new Request('https://w/feedback', { method: 'OPTIONS', headers: { Origin: 'https://hwlsupportfinder.org.uk' } }), { ...env('claude-sonnet-5-5'), ALLOWED_ORIGIN: live });
  check('origins: preflight from the new domain is allowed (204)', pre.status === 204);
  const none = await at('https://hwlsupportfinder.org.uk', '');
  check('origins: nothing accepted when ALLOWED_ORIGIN is empty', none.headers.get('Access-Control-Allow-Origin') === null);
}

// ----- Pilot feedback form and feedback emails -----
{
  const notify = await import(pathToFileURL(path.join(root, 'worker/src/notify.js')).href);
  const sent = [];
  const mailer = (fail = false) => ({ send: async (m) => { if (fail) throw Object.assign(new Error('no'), { code: 'E_SENDER_NOT_VERIFIED' }); sent.push(m); return { messageId: 'm' + sent.length }; } });
  const pEnv = (extra = {}) => fbEnv({ PILOT_FEEDBACK: 'true', FEEDBACK_EMAIL: mailer(), FEEDBACK_EMAIL_TO: 'admin@hwlsupportfinder.org.uk', FEEDBACK_EMAIL_FROM: 'feedback@hwlsupportfinder.org.uk', ...extra });
  const pilotFb = (o = {}) => ({ kind: 'pilot', reasons: ['missed-service'], text: 'It missed the Batley job club for a man looking for work.', schemeIds: ['wellness-to-work'], contacted: 'not-yet', ease: 4, lang: 'en', mode: 'staff', ...o });
  const ws = (await import(pathToFileURL(path.join(root, 'data/services.json')).href, { with: { type: 'json' } })).default.services.find((x) => x.id === 'wellness-to-work');

  // Switch
  let hp = await (await worker.fetch(new Request('https://w/health', { headers: { Origin: O } }), pEnv())).json();
  check('pilot: /health says pilot is on when PILOT_FEEDBACK is "true"', hp.pilot === true, JSON.stringify(hp));
  hp = await (await worker.fetch(new Request('https://w/health', { headers: { Origin: O } }), fbEnv())).json();
  check('pilot: /health says pilot is off by default (the live site)', hp.pilot === false);
  hp = await (await worker.fetch(new Request('https://w/health', { headers: { Origin: O } }), pEnv({ FEEDBACK_ENABLED: 'false' }))).json();
  check('pilot: off when feedback as a whole is off', hp.pilot === false);
  fbStore = mkFbStore();
  r = await send(pilotFb(), { e: fbEnv() });
  check('pilot: pilot entries refused when the form is switched off', r.status === 400);

  // Accepted and stored
  r = await send(pilotFb({ contact: { name: 'Sam Coach', email: 'sam.coach@example.org.uk' } }), { e: pEnv() });
  check('pilot: entry accepted (201)', r.status === 201, JSON.stringify(r.body));
  r = await send(pilotFb({ reasons: ['idea'], schemeIds: undefined, contacted: undefined, ease: undefined, text: 'Could it print a list to hand over?' }), { e: pEnv() });
  check('pilot: minimal entry (one choice and a comment) accepted', r.status === 201, JSON.stringify(r.body));
  let pall = await (await fbCall('GET', '/feedback/items', null, { pass: FB_PASS, e: pEnv() })).body.items;
  check('pilot: stored with the agreed fields only', pall.every((x) => Object.keys(x).sort().join() === KEYS), Object.keys(pall[0]).sort().join());
  check('pilot: keeps choice, comment, schemes, contacted and ease', pall[0].kind === 'pilot' && pall[0].reasons.join() === 'missed-service' && pall[0].schemeIds.join() === 'wellness-to-work' && pall[0].contacted === 'not-yet' && pall[0].ease === 4, JSON.stringify(pall[0]));
  check('pilot: keeps the tester\'s own contact details when given (not redacted)', pall[0].contact && pall[0].contact.email === 'sam.coach@example.org.uk' && pall[0].contact.name === 'Sam Coach' && pall[0].redacted === false, JSON.stringify(pall[0].contact));
  check('pilot: no contact details unless given', pall[1].contact === null && pall[1].schemeIds.length === 0 && pall[1].ease === null && pall[1].contacted === null);
  check('pilot: entries say which site they came from', pall[0].site === 'live');
  fbStore = mkFbStore();
  await send(pilotFb(), { e: pEnv({ ALLOW_SELF_ORIGIN: 'true' }) });
  pall = await (await fbCall('GET', '/feedback/items', null, { pass: FB_PASS, e: pEnv() })).body.items;
  check('pilot: preview entries are marked preview', pall[0].site === 'preview', JSON.stringify(pall[0]));
  r = await send(pilotFb({ text: 'Client on 07700 900123 at HD1 4EW, email jo@x.com' }), { e: pEnv() });
  pall = await (await fbCall('GET', '/feedback/items', null, { pass: FB_PASS, e: pEnv() })).body.items;
  check('pilot: personal details still removed from the comment', pall[1].text === 'Client on [removed] at [removed], email [removed]' && pall[1].redacted === true, pall[1].text);
  r = await send(pilotFb({ text: 'x'.repeat(1400) }), { e: pEnv() });
  check('pilot: longer comments allowed than the quick forms', r.status === 201);

  const pbad = [
    ['no choice', pilotFb({ reasons: [] })],
    ['two choices', pilotFb({ reasons: ['idea', 'broken'] })],
    ['unknown choice', pilotFb({ reasons: ['none-fit'] })],
    ['no comment', pilotFb({ text: '' })],
    ['comment too long', pilotFb({ text: 'x'.repeat(1501) })],
    ['unknown scheme', pilotFb({ schemeIds: ['made-up'] })],
    ['too many schemes', pilotFb({ schemeIds: Array(6).fill('wellness-to-work') })],
    ['bad contacted', pilotFb({ contacted: 'maybe' })],
    ['ease out of range', pilotFb({ ease: 6 })],
    ['ease not a whole number', pilotFb({ ease: 3.5 })],
    ['contact without an email', pilotFb({ contact: { name: 'Sam' } })],
    ['contact with a bad email', pilotFb({ contact: { name: 'Sam', email: 'not an email' } })],
    ['contact with an extra field', pilotFb({ contact: { email: 'a@b.com', phone: '07700900123' } })],
    ['search text sneaked in', pilotFb({ search: 'man in his 50s with back pain' })],
  ];
  for (const [name, body] of pbad) {
    r = await send(body, { e: pEnv() });
    check('pilot: rejected - ' + name, r.status === 400 && typeof r.body.error === 'string', r.status + ' ' + JSON.stringify(r.body));
  }

  // Emails
  sent.length = 0;
  fbStore = mkFbStore();
  await send(pilotFb({ contact: { name: 'Sam Coach', email: 'sam.coach@example.org.uk' } }), { e: pEnv() });
  check('email: sent for a pilot entry, to the team inbox, from the feedback address', sent.length === 1 && sent[0].to === 'admin@hwlsupportfinder.org.uk' && sent[0].from.email === 'feedback@hwlsupportfinder.org.uk', JSON.stringify(sent[0]));
  check('email: subject has the number and what it is about', /^Support Finder feedback #1: Pilot feedback – Missed a service$/.test(sent[0].subject), sent[0].subject);
  check('email: body has the comment, scheme name, ease and contact', sent[0].text.includes('It missed the Batley job club') && sent[0].text.includes(ws.name + ' (wellness-to-work)') && sent[0].text.includes('Ease of use this time (1–5): 4') && sent[0].text.includes('sam.coach@example.org.uk'), sent[0].text);
  check('email: reply goes to a tester who asked to be contacted', sent[0].replyTo && sent[0].replyTo.email === 'sam.coach@example.org.uk');
  await send(pilotFb(), { e: pEnv() });
  check('email: no reply-to when the tester did not ask to be contacted', sent.length === 2 && sent[1].replyTo === undefined && sent[1].text.includes('Not asked to be contacted.'));
  await send(cardFb(), { e: pEnv() });
  await send(gapFb(), { e: pEnv() });
  await send(replyFb({ helpful: false, reasons: ['none-fit'] }), { e: pEnv() });
  check('email: sent for listing problems, gaps and "No" replies too', sent.length === 5 && /Problem with a listing/.test(sent[2].subject) && /Something's missing/.test(sent[3].subject) && /Results not helpful/.test(sent[4].subject), sent.map((m) => m.subject).join(' | '));
  check('email: suggested service details are in the email', sent[3].text.includes('Missed service: Batley Job Club, https://example.org/job-club, Batley') && sent[3].text.includes('Sent in by: Someone who knows the service') && sent[3].text.includes('Organisation: Batley Trust'), sent[3].text);
  await send(replyFb(), { e: pEnv() });
  check('email: not sent for a plain "Yes, it was helpful"', sent.length === 5);
  await send(cardFb({ text: 'Ring 07700 900123' }), { e: pEnv() });
  check('email: carries the comment with personal details already removed', sent[5].text.includes('Ring [removed]') && !sent[5].text.includes('07700'), sent[5].text);
  await send(pilotFb(), { e: pEnv({ ALLOW_SELF_ORIGIN: 'true' }) });
  check('email: preview entries say so, with a link to the review page', sent[6].subject.includes('[preview]') && sent[6].text.includes('https://w/admin/feedback.html'), sent[6].subject + ' ' + sent[6].text);
  const before = (await items()).length;
  r = await send(pilotFb(), { e: pEnv({ FEEDBACK_EMAIL: mailer(true) }) });
  check('email: a failed email still stores the feedback (201)', r.status === 201 && (await items()).length === before + 1);
  sent.length = 0;
  r = await send(pilotFb(), { e: pEnv({ FEEDBACK_EMAIL: undefined }) });
  check('email: nothing sent, and feedback stored, when the email binding is missing', r.status === 201 && sent.length === 0);
  r = await send(pilotFb(), { e: pEnv({ FEEDBACK_EMAIL_TO: undefined }) });
  check('email: nothing sent when there is no inbox set', r.status === 201 && sent.length === 0);
  r = await send(pilotFb(), { e: pEnv({ FEEDBACK_EMAIL_TO: ' , ' }) });
  check('email: nothing sent when the address list is blank', r.status === 201 && sent.length === 0);
  await send(pilotFb(), { e: pEnv({ FEEDBACK_EMAIL_TO: 'one@example.org, two@example.org.uk ' }) });
  check('email: one email to several admins when the secret lists more than one', sent.length === 1 && Array.isArray(sent[0].to) && sent[0].to.join() === 'one@example.org,two@example.org.uk', JSON.stringify(sent[0] && sent[0].to));
  const tomlNow = fs.readFileSync(path.join(root, 'worker/wrangler.toml'), 'utf8');
  check('email: no recipient addresses in the public config', !/^FEEDBACK_EMAIL_TO\s*=/m.test(tomlNow) && !/allowed_destination_addresses/.test(tomlNow));
  let waited = null;
  r = await worker.fetch(new Request('https://w/feedback', { method: 'POST', headers: { 'content-type': 'application/json', Origin: O }, body: JSON.stringify(pilotFb()) }), pEnv(), { waitUntil: (p) => { waited = p; } });
  check('email: sent after the reply, using waitUntil', r.status === 201 && waited instanceof Promise && (await waited) === true);
  r = await fbCall('GET', '/feedback/export.csv', null, { pass: FB_PASS, e: pEnv() });
  check('pilot: CSV has the pilot columns', r.body.split('\r\n')[0].includes('"contacted","ease","contactName","contactEmail","lang","mode","site"') && r.body.includes('"sam.coach@example.org.uk"'), r.body.split('\r\n')[0]);
  check('email: notify.js labels cover every reason the Worker accepts', Object.values(fb.REASONS).flat().every((x) => notify.LABELS[x]), Object.values(fb.REASONS).flat().filter((x) => !notify.LABELS[x]).join());
}

// ----- Anonymous usage counts -----
const mkUsageStore = () => {
  const mem = new Map();
  const storage = {
    get: async (k) => mem.get(k),
    put: async (k, v) => { mem.set(k, v); },
    delete: async (ks) => { for (const k of [].concat(ks)) mem.delete(k); },
    list: async ({ prefix }) => new Map([...mem.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))),
  };
  return new mod.UsageStore({ storage });
};
let usageStore = mkUsageStore();
const usEnv = (extra = {}) => ({
  ...fbEnv(),
  USAGE_STORE: { idFromName: () => 'u', get: () => ({ fetch: (u, init) => usageStore.fetch(new Request(u, init)) }) },
  ...extra,
});
const usPost = async (body, { e = usEnv(), origin = O, raw = null } = {}) => {
  const headers = { 'content-type': 'text/plain;charset=UTF-8' };
  if (origin) headers.Origin = origin;
  const res = await worker.fetch(new Request('https://w/usage', { method: 'POST', headers, body: raw !== null ? raw : JSON.stringify(body) }), e);
  return res.status;
};
const usDays = async (pass = FB_PASS, q = '') => {
  const res = await worker.fetch(new Request('https://w/usage/days' + q, { headers: { Origin: O, 'x-feedback-passcode': pass } }), usEnv());
  return { status: res.status, body: await res.json() };
};
const todayCounts = async () => ((await usDays()).body.days.find((d) => d.date === new Date().toISOString().slice(0, 10)) || { counts: {} }).counts;
const openId = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'data/services.json'), 'utf8')).services.filter((x) => x.open && !x.requiresMention).map((x) => x.id))][0];

h = await (await worker.fetch(new Request('https://w/health'), usEnv())).json();
check('usage: /health says usage is on by default', h.usage === true, JSON.stringify(h));
h = await (await worker.fetch(new Request('https://w/health'), usEnv({ USAGE_ENABLED: 'false' }))).json();
check('usage: /health says off when USAGE_ENABLED is "false"', h.usage === false);

// A search is counted by the Worker itself, with the services shown, and nothing from the conversation.
reply = ok([{ type: 'tool_use', id: 'tu1', name: 'respond', input: { status: 'results', message: 'Here you go.', urgent_support: false, matches: [{ service_id: openId, fit: 'strong', reason: 'r', check_first: '' }] } }]);
await worker.fetch(new Request('https://w/chat', { method: 'POST', headers: { Origin: O, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'staff', lang: 'pl', messages: [{ role: 'user', content: 'Secret words about my health' }] }) }), usEnv());
let uc = await todayCounts();
check('usage: a search counts search, conversation, results and services shown', uc['search|pl|staff'] === 1 && uc['conversation|pl|staff'] === 1 && uc['results|pl|staff'] === 1 && uc['shown|' + openId + '|pl|staff'] === 1, JSON.stringify(uc));
check('usage: nothing typed is stored', !JSON.stringify(uc).includes('Secret') && !JSON.stringify(uc).includes('health'));
reply = ok([{ type: 'tool_use', id: 'tu2', name: 'respond', input: { status: 'results', message: 'Nothing fits, sorry.', urgent_support: false, matches: [] } }]);
await worker.fetch(new Request('https://w/chat', { method: 'POST', headers: { Origin: O, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'public', lang: 'en', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] }) }), usEnv());
uc = await todayCounts();
check('usage: a later message is a search but not a new conversation; no results counted', uc['search|en|public'] === 1 && !uc['conversation|en|public'] && uc['no-results|en|public'] === 1, JSON.stringify(uc));

// AI token totals: added up per day and model from Anthropic's usage numbers, nothing else.
const todayRec = async () => (await usDays()).body.days.find((d) => d.date === new Date().toISOString().slice(0, 10)) || {};
let tk = (await todayRec()).tokens || {};
check('tokens: each answer counts one AI call for the model', tk['claude-sonnet-5-5'] && tk['claude-sonnet-5-5'].calls === 2, JSON.stringify(tk));
reply = () => new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'tu3', name: 'respond', input: { status: 'results', message: 'Here.', urgent_support: false, matches: [] } }], usage: { input_tokens: 120, output_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 50 } }), { status: 200 });
await worker.fetch(new Request('https://w/chat', { method: 'POST', headers: { Origin: O, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'My name is Sam' }] }) }), usEnv());
tk = (await todayRec()).tokens['claude-sonnet-5-5'];
check('tokens: input, output and cache tokens added up', tk.calls === 3 && tk.input === 120 && tk.output === 300 && tk.cacheRead === 9000 && tk.cacheWrite === 50, JSON.stringify(tk));
check('tokens: nothing typed is stored', !JSON.stringify(await todayRec()).includes('Sam'));
reply = () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 529 });
await worker.fetch(new Request('https://w/chat', { method: 'POST', headers: { Origin: O, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) }), usEnv());
uc = await todayCounts();
check('tokens: a failed AI call is counted as an AI error', uc['ai-error|en|public'] === 1, JSON.stringify(uc));
const usageMod = await import(pathToFileURL(path.join(root, 'worker/src/usage.js')).href);
check('tokens: bad token data is ignored by the store', usageMod.cleanTokens({ model: 'Bad Model!', calls: 1 }) === null && usageMod.cleanTokens({ model: 'claude-x', calls: 1, input: -5 }).input === 0);

// Events from the page
check('usage: link event accepted (204)', (await usPost({ e: 'link', s: openId, k: 'referral', lang: 'en', mode: 'public' })) === 204);
check('usage: visit event accepted', (await usPost({ e: 'visit', lang: 'ur' })) === 204);
check('usage: contacted answer accepted', (await usPost({ e: 'contacted', s: openId, k: 'notyet', lang: 'en', mode: 'staff' })) === 204);
check('usage: accessibility event accepted', (await usPost({ e: 'a11y', k: 'contrast', lang: 'en' })) === 204);
uc = await todayCounts();
check('usage: page events counted with fixed values only', uc['link|' + openId + '|referral|en|public'] === 1 && uc['visit|ur|none'] === 1 && uc['contacted|' + openId + '|notyet|en|staff'] === 1 && uc['a11y|contrast|en|none'] === 1, JSON.stringify(uc));
check('usage: summary check and answer kind accepted', (await usPost({ e: 'summary', k: 'changed', lang: 'en', mode: 'public' })) === 204 && (await usPost({ e: 'answers', k: 'tapped', lang: 'pl', mode: 'staff' })) === 204);
uc = await todayCounts();
check('usage: summary and answers counted', uc['summary|changed|en|public'] === 1 && uc['answers|tapped|pl|staff'] === 1, JSON.stringify(uc));
check('usage: unknown summary or answer kind refused', (await usPost({ e: 'summary', k: 'maybe' })) === 400 && (await usPost({ e: 'answers', k: 'Batley' })) === 400);
check('usage: unknown scheme refused', (await usPost({ e: 'link', s: 'not-a-scheme', k: 'referral' })) === 400);
check('usage: unknown event refused', (await usPost({ e: 'typed', text: 'hello' })) === 400);
check('usage: extra field refused', (await usPost({ e: 'visit', text: 'my name is' })) === 400);
check('usage: unknown link kind refused', (await usPost({ e: 'link', s: openId, k: 'facebook' })) === 400);
check('usage: wrong origin refused', (await usPost({ e: 'visit' }, { origin: 'https://evil.example' })) === 403);
check('usage: too large refused', (await usPost(null, { raw: '{"e":"visit","x":"' + 'a'.repeat(900) + '"}' })) === 413);
check('usage: switched off -> 404', (await usPost({ e: 'visit' }, { e: usEnv({ USAGE_ENABLED: 'false' }) })) === 404);

// Reading
check('usage: reading needs the passcode', (await usDays('wrong')).status === 401);
const csvRes = await worker.fetch(new Request('https://w/usage/export.csv', { headers: { 'x-feedback-passcode': FB_PASS } }), usEnv());
const csvText = await csvRes.text();
check('usage: CSV export has a header and a row per count', csvRes.status === 200 && csvText.startsWith('"date","event","scheme","detail","lang","mode","count"') && csvText.includes('"link","' + openId + '","referral","en","public","1"'), csvText.slice(0, 300));
check('tokens: CSV export has the day\'s AI token totals', csvText.includes('"ai-output-tokens","","claude-sonnet-5-5","","","300"') && csvText.includes('"ai-calls","","claude-sonnet-5-5","","","3"'), csvText.slice(-400));
check('usage: bad since date refused', (await usDays(FB_PASS, '?since=yesterday')).status === 400);

// Daily cap
usageStore = mkUsageStore();
const capEnv = usEnv({ MAX_USAGE_PER_DAY: '2' });
await usPost({ e: 'visit' }, { e: capEnv }); await usPost({ e: 'visit' }, { e: capEnv }); await usPost({ e: 'visit' }, { e: capEnv });
uc = await todayCounts();
check('usage: daily cap stops counting', uc['visit|en|none'] === 2, JSON.stringify(uc));

// Retention: old days are deleted
usageStore = mkUsageStore();
const oldDay = '2020-01-01';
await usageStore.ctx.storage.put('d:' + oldDay, { date: oldDay, counts: { 'visit|en|none': 5 }, total: 5 });
check('usage: tallies older than 24 months are deleted', !(await usDays()).body.days.some((d) => d.date === oldDay));

// ----- Admin test mode: counted apart from real use -----
usageStore = mkUsageStore();
const teamDays = async () => (await usDays(FB_PASS, '?source=team')).body.days;
const dayOf = (days) => (days.find((d) => d.date === new Date().toISOString().slice(0, 10)) || { counts: {} });
reply = ok([{ type: 'tool_use', id: 'tt1', name: 'respond', input: { status: 'results', message: 'Here you go.', urgent_support: false, matches: [{ service_id: openId, fit: 'strong', reason: 'r', check_first: '' }] } }]);
await worker.fetch(new Request('https://w/chat', { method: 'POST', headers: { Origin: O, 'content-type': 'application/json', 'x-team-test': FB_PASS }, body: JSON.stringify({ mode: 'staff', lang: 'en', messages: [{ role: 'user', content: 'Test search' }] }) }), usEnv());
check('team test: a test-mode search is not in the real counts', !(await todayCounts())['search|en|staff'], JSON.stringify(await todayCounts()));
let td = dayOf(await teamDays());
check('team test: ...it is in the team test counts, with its AI tokens', td.counts['search|en|staff'] === 1 && td.counts['shown|' + openId + '|en|staff'] === 1 && td.tokens && td.tokens['claude-sonnet-5-5'].calls === 1, JSON.stringify(td));
await worker.fetch(new Request('https://w/chat', { method: 'POST', headers: { Origin: O, 'content-type': 'application/json', 'x-team-test': 'not the passcode' }, body: JSON.stringify({ mode: 'staff', lang: 'en', messages: [{ role: 'user', content: 'Search' }] }) }), usEnv());
check('team test: a wrong passcode is counted as real use', (await todayCounts())['search|en|staff'] === 1 && dayOf(await teamDays()).counts['search|en|staff'] === 1);
check('team test: page event with the passcode accepted (204)', (await usPost({ e: 'link', s: openId, k: 'website', lang: 'en', mode: 'public', t: FB_PASS })) === 204);
check('team test: ...and counted as a test only', dayOf(await teamDays()).counts['link|' + openId + '|website|en|public'] === 1 && !(await todayCounts())['link|' + openId + '|website|en|public']);
check('team test: page event with a wrong passcode counted as real use', (await usPost({ e: 'visit', t: 'guess' })) === 204 && (await todayCounts())['visit|en|none'] === 1 && !dayOf(await teamDays()).counts['visit|en|none']);
check('team test: without TEAM_PASSCODE nothing is a test', (await usPost({ e: 'copy', s: openId, t: '' }, { e: usEnv({ TEAM_PASSCODE: undefined }) })) === 204 && (await todayCounts())['copy|' + openId + '|en|none'] === 1);
check('team test: reading team counts needs the passcode', (await usDays('wrong', '?source=team')).status === 401);
const teamCsv = await worker.fetch(new Request('https://w/usage/export.csv?source=team', { headers: { 'x-feedback-passcode': FB_PASS } }), usEnv());
check('team test: CSV of team counts', teamCsv.status === 200 && (teamCsv.headers.get('content-disposition') || '').includes('team-tests') && (await teamCsv.text()).includes('"search","","","en","staff","1"'));
const oldTeam = '2020-01-01';
await usageStore.ctx.storage.put('purged', 'never');
await usageStore.ctx.storage.put('t:' + oldTeam, { date: oldTeam, counts: { 'visit|en|none': 1 }, total: 1 });
check('team test: old team counts are deleted after 24 months too', !(await teamDays()).some((d) => d.date === oldTeam));
// Feedback sent in test mode is labelled, not hidden or refused.
fbStore = mkFbStore();
const fbTeam = async (pass) => {
  const res = await worker.fetch(new Request('https://w/feedback', { method: 'POST', headers: { Origin: O, 'content-type': 'application/json', 'x-team-test': pass }, body: JSON.stringify(replyFb()) }), fbEnv());
  return res.status;
};
check('team test: feedback in test mode accepted', (await fbTeam(FB_PASS)) === 201 && (await fbTeam('nope')) === 201);
let tItems = await items();
check('team test: test-mode feedback is labelled "team"; a wrong passcode is ordinary feedback', tItems.length === 2 && tItems.filter((x) => x.team === true).length === 1, JSON.stringify(tItems.map((x) => x.team)));
const tCsv = (await fbCall('GET', '/feedback/export.csv', null, { pass: FB_PASS })).body;
check('team test: feedback CSV has a team column', tCsv.split('\r\n')[0].includes('"team"'));
const notifyMod = await import(pathToFileURL(path.join(root, 'worker/src/notify.js')).href);
check('team test: the email subject says [team test]', notifyMod.buildEmail({ id: 9, kind: 'reply', schemeIds: [], reasons: [], team: true }).subject.includes('[team test]'));

// ----- Organisations: rename, overview, combine (teamlog.js /log/orgs, apply-decisions.mjs) -----
store = mkStore();
r = await logCall('GET', '/log/orgs');
check('orgs: empty to start', r.status === 200 && !Object.keys(r.body.orgs).length);
r = await logCall('PUT', '/log/orgs/proper-job-theatre-company-ltd', { changes: { mergeInto: 'proper-job-theatre-company' }, note: 'Same organisation', by: 'PL' });
check('orgs: a combine is saved', r.status === 200 && r.body.item.changes.mergeInto === 'proper-job-theatre-company');
r = await logCall('PUT', '/log/orgs/acas', { changes: { overview: 'x'.repeat(301) }, note: 'Too long', by: 'PL' });
check('orgs: an overview over 300 characters is refused', r.status === 400 && /too long/.test(r.body.error));
r = await logCall('PUT', '/log/orgs/acas', { changes: { overview: 'Runs Healthy Working Life schemes.' }, note: 'HWL', by: 'PL' });
check('orgs: an organisation overview may not carry the Healthy Working Life marker', r.status === 400 && /Healthy Working Life/.test(r.body.error), JSON.stringify(r.body));
r = await logCall('PUT', '/log/orgs/acas', { changes: { mergeInto: 'acas' }, note: 'Self', by: 'PL' });
check('orgs: can\'t be combined into itself', r.status === 400);
r = await logCall('PUT', '/log/orgs/acas', { changes: { hwlFunded: true }, note: 'No', by: 'PL' });
check('orgs: only name, overview, website or combining can be changed', r.status === 400 && /can't be changed/.test(r.body.error));
r = await logCall('PUT', '/log/orgs/acas', { changes: { overview: 'Free advice on workplace rights.' }, note: '', by: 'PL' });
check('orgs: needs a reason', r.status === 400);
r = await logCall('GET', '/log/orgs', null, { origin: null });
check('orgs: the apply script (no Origin) can read them', r.status === 200 && r.body.orgs['proper-job-theatre-company-ltd']);
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'org-'));
  // Its own organisations and organisation names, so the test doesn't depend on what the team has since combined or
  // renamed in the real data.
  const orgOf = { 'p2p-proper-job': 'Proper Job Theatre Company Ltd', 'lab-project-proper-job': 'Proper Job Theatre Company', 'acas-helpline': 'Acas', 'acas-managing-disability': 'Acas' };
  for (const [id, org] of Object.entries(orgOf)) {
    const sv = JSON.parse(fs.readFileSync(path.join(root, 'data/services', id + '.json'), 'utf8'));
    sv.organisation = org;
    fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify(sv, null, 2) + '\n');
  }
  const realOrgs = fs.readFileSync(path.join(root, 'data/organisations.json'), 'utf8');
  fs.writeFileSync(path.join(d, 'organisations.json'), JSON.stringify({ organisations: [
    { id: 'acas', name: 'Acas' },
    { id: 'proper-job-theatre-company', name: 'Proper Job Theatre Company' },
    { id: 'proper-job-theatre-company-ltd', name: 'Proper Job Theatre Company Ltd', overview: 'Theatre company in Huddersfield.' },
  ] }));
  const inp = path.join(d, 'decisions.json');
  const acasNow = JSON.parse(fs.readFileSync(path.join(d, 'acas-helpline.json'), 'utf8'));
  fs.writeFileSync(inp, JSON.stringify({
    orgs: {
      'proper-job-theatre-company-ltd': { changes: { mergeInto: 'proper-job-theatre-company' }, note: 'Same organisation', by: 'PL', t: '2026-11-10T09:00:00Z' },
      acas: { changes: { name: 'Acas (Advisory, Conciliation and Arbitration Service)', website: 'https://www.acas.org.uk' }, before: {}, note: 'Full name', by: 'PL', t: '2026-11-10T09:00:00Z' },
    },
    edits: {
      'acas-helpline': { changes: { organisationOverview: 'Free, impartial advice on workplace rights.' }, before: {}, note: 'Overview from the provider', by: 'PL', t: '2026-11-10T09:00:00Z' },
      'acas-managing-disability': { changes: { organisation: 'Brand New Organisation' }, before: {}, note: 'Moved', by: 'PL', t: '2026-11-10T09:00:00Z' },
    },
  }));
  const out = execFileSync(process.execPath, [path.join(root, 'scripts/apply-decisions.mjs'), '--input', inp, '--dir', d], { encoding: 'utf8' });
  const o2 = JSON.parse(fs.readFileSync(path.join(d, 'organisations.json'), 'utf8')).organisations;
  const svcIn = (id) => JSON.parse(fs.readFileSync(path.join(d, id + '.json'), 'utf8'));
  const pj = o2.find((o) => o.id === 'proper-job-theatre-company');
  check('apply orgs: combining moves the services and keeps the old name as an alias', svcIn('p2p-proper-job').organisation === 'Proper Job Theatre Company' && !o2.find((o) => o.id === 'proper-job-theatre-company-ltd') && pj.aliases.includes('Proper Job Theatre Company Ltd'), out);
  check('apply orgs: the combined organisation\'s overview is kept', pj.overview === 'Theatre company in Huddersfield.');
  check('apply orgs: the services keep their own Healthy Working Life marker', svcIn('p2p-proper-job').hwlFunded === true && !('hwlFunded' in pj));
  const acasOrg = o2.find((o) => o.id === 'acas');
  check('apply orgs: a rename updates every service and keeps the old name', acasOrg.name.startsWith('Acas (') && acasOrg.aliases.includes('Acas') && svcIn('acas-helpline').organisation === acasOrg.name && acasOrg.website === 'https://www.acas.org.uk', JSON.stringify(acasOrg));
  check('apply orgs: an organisation overview sent with a service goes on the organisation, not the service', acasOrg.overview === 'Free, impartial advice on workplace rights.' && !('organisationOverview' in svcIn('acas-helpline')), JSON.stringify(acasOrg));
  check('apply orgs: a new organisation name makes a new organisation', svcIn('acas-managing-disability').organisation === 'Brand New Organisation' && o2.some((o) => o.name === 'Brand New Organisation' && o.id === 'brand-new-organisation') && /New organisations: Brand New Organisation/.test(out), out);
  check('apply orgs: summary says what happened', /Organisations changed \(2\)/.test(out) && /combined into Proper Job Theatre Company/.test(out), out);
  check('apply orgs: running again changes nothing more', /0 organisations changed/.test(execFileSync(process.execPath, [path.join(root, 'scripts/apply-decisions.mjs'), '--input', inp, '--dir', d], { encoding: 'utf8' })));
  check('apply orgs: the real organisations file is untouched by a test run', fs.readFileSync(path.join(root, 'data/organisations.json'), 'utf8') === realOrgs);
  void acasNow;
  fs.rmSync(d, { recursive: true, force: true });
}

// ----- Venues: rename, address, postcode, combine; new venues from edits; wards from postcodes -----
store = mkStore();
r = await logCall('PUT', '/log/venues/empire-house-2', { changes: { mergeInto: 'empire-house' }, note: 'Same building', by: 'PL' });
check('venues: a combine is saved', r.status === 200 && r.body.item.changes.mergeInto === 'empire-house');
r = await logCall('PUT', '/log/venues/empire-house', { changes: { postcode: 'wf128dj' }, note: 'Tidy', by: 'PL' });
check('venues: a postcode is tidied to capitals with one space', r.status === 200 && r.body.item.changes.postcode === 'WF12 8DJ');
r = await logCall('PUT', '/log/venues/empire-house', { changes: { postcode: 'WF12' }, note: 'Bad', by: 'PL' });
check('venues: a part postcode is refused', r.status === 400 && /postcode/.test(r.body.error));
r = await logCall('PUT', '/log/venues/empire-house', { changes: { mergeInto: 'empire-house' }, note: 'Self', by: 'PL' });
check('venues: can\'t be combined into itself', r.status === 400);
r = await logCall('PUT', '/log/venues/empire-house', { changes: { ward: 'Made up' }, note: 'No', by: 'PL' });
check('venues: the ward can\'t be typed in (it comes from the postcode)', r.status === 400 && /can't be changed/.test(r.body.error));
r = await logCall('GET', '/log/venues', null, { origin: null });
check('venues: the apply script (no Origin) can read them', r.status === 200 && r.body.venues['empire-house-2']);
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'venue-'));
  const mk = (id, sessions, extra = {}) => {
    const sv = JSON.parse(fs.readFileSync(path.join(root, 'data/services/acas-helpline.json'), 'utf8'));
    Object.assign(sv, { id, name: id, organisation: 'Org', locations: [], ...extra });
    sv.projects = [{ id: 'p', name: 'P', overview: 'O', sessions }];
    fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify(sv, null, 2) + '\n');
  };
  mk('svc-a', [{ id: 's1', venue: 'hall-a' }]);
  mk('svc-b', [{ id: 's1', venue: 'hall-b', days: ['tue'] }], { venues: ['hall-b'] });
  mk('svc-c', [{ id: 's1', venue: 'hall-a' }]);
  fs.writeFileSync(path.join(d, 'organisations.json'), JSON.stringify({ organisations: [{ id: 'org', name: 'Org' }] }));
  fs.writeFileSync(path.join(d, 'venues.json'), JSON.stringify({ venues: [
    { id: 'hall-a', name: 'Hall A', address: 'Hall A, 1 Road, Batley', postcode: 'WF17 5DR', ward: 'Batley East', lat: 53.7, lng: -1.6 },
    { id: 'hall-b', name: 'Hall B', address: 'Hall B, 1 Road, Batley', postcode: 'WF17 5DR' },
    { id: 'hall-c', name: 'Hall C', address: 'Hall C, Dewsbury', postcode: 'WF12 8DJ', ward: 'Old', lat: 1, lng: 1 },
  ] }));
  const inp = path.join(d, 'decisions.json');
  fs.writeFileSync(inp, JSON.stringify({
    venues: {
      'hall-b': { changes: { mergeInto: 'hall-a' }, note: 'Same hall', by: 'PL', t: '2026-11-12T09:00:00Z' },
      'hall-c': { changes: { postcode: 'WF12 8DS', name: 'Hall C (new)' }, before: {}, note: 'Moved', by: 'PL', t: '2026-11-12T09:00:00Z' },
    },
    edits: {
      'svc-c': { changes: { projects: [{ id: 'p', name: 'P', overview: 'O', sessions: [{ id: 's1', venue: 'hall-a' }, { id: 's2', venue: { name: 'New Centre', address: 'New Centre, 2 Street, Dewsbury', postcode: 'WF13 3AR' }, days: ['wed'], start: '10:00', end: '12:00' }] }] }, before: {}, note: 'From the provider', by: 'PL', t: '2026-11-12T09:00:00Z' },
    },
  }));
  const out = execFileSync(process.execPath, [path.join(root, 'scripts/apply-decisions.mjs'), '--input', inp, '--dir', d], { encoding: 'utf8' });
  const v2 = JSON.parse(fs.readFileSync(path.join(d, 'venues.json'), 'utf8')).venues;
  const svcIn = (id) => JSON.parse(fs.readFileSync(path.join(d, id + '.json'), 'utf8'));
  const a = v2.find((v) => v.id === 'hall-a');
  check('apply venues: combining moves every session (and "every project" venue) and keeps the old name', !v2.find((v) => v.id === 'hall-b') && svcIn('svc-b').projects[0].sessions[0].venue === 'hall-a' && svcIn('svc-b').venues.join() === 'hall-a' && a.aliases.includes('Hall B'), out);
  const c = v2.find((v) => v.id === 'hall-c');
  check('apply venues: a new postcode clears the ward and map position, to be looked up again', c.postcode === 'WF12 8DS' && !('ward' in c) && !('lat' in c) && c.aliases.includes('Hall C'), JSON.stringify(c));
  const nv = v2.find((v) => v.name === 'New Centre');
  check('apply venues: a venue written out in an edit becomes a venue record, and the session points at it', nv && nv.postcode === 'WF13 3AR' && svcIn('svc-c').projects[0].sessions[1].venue === nv.id && /New venues .*New Centre \(WF13 3AR\)/.test(out), out);
  check('apply venues: summary says what happened', /Venues changed \(2\)/.test(out) && /combined into Hall A/.test(out), out);
  const again = execFileSync(process.execPath, [path.join(root, 'scripts/apply-decisions.mjs'), '--input', inp, '--dir', d], { encoding: 'utf8' });
  check('apply venues: running again changes nothing more (the written-out venue is matched, not added twice)', /0 venues changed/.test(again) && /0 services with edited details, 1 already up to date/.test(again) && JSON.parse(fs.readFileSync(path.join(d, 'venues.json'), 'utf8')).venues.filter((v) => v.name === 'New Centre').length === 1, again);
  // Wards and map positions from postcodes (postcodes.io), with a pretend lookup.
  const { lookupVenues } = await import(pathToFileURL(path.join(root, 'scripts/lookup-venues.mjs')).href);
  let asked = null;
  const fakeFetch = async (url, init) => {
    asked = JSON.parse(init.body).postcodes;
    return { ok: true, json: async () => ({ result: asked.map((q) => ({ query: q, result: q === 'WF12 8DS' ? { admin_ward: 'Dewsbury East', codes: { admin_ward: 'E05001370' }, latitude: 53.6912345, longitude: -1.6234567 } : null })) }) };
  };
  const list = JSON.parse(fs.readFileSync(path.join(d, 'venues.json'), 'utf8')).venues;
  const lr = await lookupVenues(list, fakeFetch);
  const c2 = list.find((v) => v.id === 'hall-c');
  check('wards: only venues without a ward are looked up, and only their postcodes are sent', !asked.includes('WF17 5DR') && asked.includes('WF12 8DS') && asked.includes('WF13 3AR'), JSON.stringify(asked));
  check('wards: the ward, its code and the map position are filled in', c2.ward === 'Dewsbury East' && c2.wardCode === 'E05001370' && c2.lat === 53.69123 && c2.lng === -1.62346, JSON.stringify(c2));
  check('wards: a postcode that can\'t be found is listed, not guessed', lr.notFound.some((x) => x.includes('WF13 3AR')) && !list.find((v) => v.name === 'New Centre').ward);
  // A retired postcode still in use (HD1 1QB): placed where it was, with the ward of the nearest current postcode.
  const oldFetch = async (url, init) => {
    if (init && init.method === 'POST') return { ok: true, json: async () => ({ result: JSON.parse(init.body).postcodes.map((q) => ({ query: q, result: null })) }) };
    if (url.includes('/terminated_postcodes/HD11QB')) return { ok: true, json: async () => ({ result: { postcode: 'HD1 1QB', latitude: 53.648023, longitude: -1.780353 } }) };
    if (url.includes('/terminated_postcodes/')) return { ok: false, json: async () => ({}) };
    if (/\/postcodes\?lon=-1\.780353&lat=53\.648023/.test(url)) return { ok: true, json: async () => ({ result: [{ postcode: 'HD1 1QA', admin_ward: 'Newsome', codes: { admin_ward: 'E05001387' } }] }) };
    return { ok: false, json: async () => ({}) };
  };
  const ol = [{ id: '15-lord-street', name: '15 Lord Street', address: '15 Lord Street, Huddersfield HD1 1QB', postcode: 'HD1 1QB' }, { id: 'nowhere', name: 'N', address: 'N', postcode: 'ZZ9 9ZZ' }];
  const or = await lookupVenues(ol, oldFetch);
  check('wards: a retired postcode still in use gets its map position and the nearest ward', ol[0].ward === 'Newsome' && ol[0].wardCode === 'E05001387' && ol[0].lat === 53.64802 && ol[0].lng === -1.78035 && or.retired.length === 1 && !or.notFound.some((x) => x.includes('HD1 1QB')), JSON.stringify({ ol, or }));
  check('wards: a postcode that isn\'t retired either is still listed as not found', or.notFound.some((x) => x.includes('ZZ9 9ZZ')) && !ol[1].ward);
  const down = await lookupVenues([{ id: 'x', name: 'X', address: 'X', postcode: 'HD1 1AA' }], async () => { throw new Error('offline'); });
  check('wards: a lookup that fails changes nothing and doesn\'t stop the run', down.updated === 0 && down.notFound.length === 1);
  fs.rmSync(d, { recursive: true, force: true });
}

// ----- Morning reminders (reminders.js) -----
{
  const rem = await import(pathToFileURL(path.join(root, 'worker/src/reminders.js')).href);
  store = mkStore();
  const sentMail = [];
  const remEnv = (extra = {}) => ({ ...logEnv(), FEEDBACK_EMAIL: { send: async (m) => { sentMail.push(m); } }, FEEDBACK_EMAIL_FROM: 'feedback@example.org', FEEDBACK_EMAIL_TO: 'team@example.org', SITE_URL: 'https://hwlsupportfinder.org.uk', ...extra });
  const T = '2026-11-09';
  const services = [
    { id: 'p2p-proper-job', name: 'Pathways to Possibilities', organisation: 'Proper Job Theatre Company Ltd', open: true, projects: [{ id: 'p2p', name: 'Pathways to Possibilities', overview: 'x', referralsUntil: '2026-11-30' }] },
    { id: 'later', name: 'Later', organisation: 'X', open: true, projects: [{ id: 'l', name: 'L', overview: 'x', runsTo: '2027-06-01' }] },
    { id: 'paused', name: 'Paused', organisation: 'Y', open: false, projects: [{ id: 'q', name: 'Q', overview: 'x', runsTo: '2026-11-20' }] },
  ];
  let res = await rem.sendReminders(remEnv(), services, T);
  const mail = sentMail[0];
  check('reminders: one email to the team for what ends or closes in 30 days', res.sent && sentMail.length === 1 && mail.to === 'team@example.org' && /1 service has projects/.test(mail.subject), JSON.stringify(res));
  check('reminders: says what and when, with a fresh review link and an email to forward', /stops taking referrals 30 November 2026 \(in 21 days\)/.test(mail.text) && /https:\/\/hwlsupportfinder\.org\.uk\/provider-check\.html#[A-Za-z0-9_-]{32}/.test(mail.text) && /projects stop showing in the Support Finder after their end date/i.test(mail.text) && /Suggest a service/.test(mail.text), mail.text);
  check('reminders: nothing for later dates or paused services', !/Later|Paused/.test(mail.text));
  check('reminders: the review link is a real provider link', (await logCall('GET', '/log/provider-links')).body.links.some((l) => l.id === 'p2p-proper-job' && l.by === 'Morning reminder'));
  res = await rem.sendReminders(remEnv(), services, '2026-11-10');
  check('reminders: each date is only reminded about once', !res.sent && sentMail.length === 1, JSON.stringify(res));
  res = await rem.sendReminders(remEnv({ SITE_URL: '' }), services, T);
  check('reminders: off without the email or site settings', !res.sent && res.reason === 'not set up');
  check('reminders: the Worker runs them each morning', typeof worker.scheduled === 'function');
}

// ---------- "Apply changes now" (applynow.js) ----------
{
  const GH = { GH_ACTIONS_TOKEN: 'ghtoken', GH_REPO: 'org/repo' };
  let calls = [];
  let runs = {};       // workflow file -> list of runs (newest first)
  let dispatchStatus = 204;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u);
    if (!url.startsWith('https://api.github.com/')) return realFetch(u, init);
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: (init.headers || {}).Authorization });
    const m = url.match(/workflows\/([^/]+)\/(runs|dispatches)/);
    if (m && m[2] === 'dispatches') return new Response(null, { status: dispatchStatus });
    return Response.json({ workflow_runs: runs[m[1]] || [] });
  };
  const run = (status, conclusion, created) => ({ status, conclusion, created_at: created, updated_at: created, html_url: 'https://github.com/run', display_title: 't' });

  r = await logCall('POST', '/log/apply', { by: 'PL' });
  check('apply: off without GH_ACTIONS_TOKEN (404, off)', r.status === 404 && r.body.off === true && calls.length === 0);
  r = await logCall('POST', '/log/apply', { by: 'PL' }, { e: logEnv(GH), pass: 'nope' });
  check('apply: wrong passcode -> 401, GitHub not called', r.status === 401 && calls.length === 0);
  r = await logCall('POST', '/log/apply', { by: 'PL' }, { e: logEnv(GH), origin: null });
  check('apply: wrong Origin -> 403, GitHub not called', r.status === 403 && calls.length === 0);
  r = await logCall('POST', '/log/apply', { by: '' }, { e: logEnv(GH) });
  check('apply: needs a name', r.status === 400 && calls.length === 0);

  runs = { 'apply-team-changes.yml': [run('completed', 'success', '2026-11-02T09:00:00Z')] };
  r = await logCall('POST', '/log/apply', { by: 'P<script>L' }, { e: logEnv(GH) });
  const d = calls.find((c) => c.method === 'POST');
  check('apply: starts the workflow on main with auto_merge', r.status === 202 && d && d.url === 'https://api.github.com/repos/org/repo/actions/workflows/apply-team-changes.yml/dispatches' && d.body.ref === 'main' && d.body.inputs.auto_merge === 'true', JSON.stringify(d));
  check('apply: name cleaned before it goes to GitHub', d && d.body.inputs.requested_by === 'PscriptL', JSON.stringify(d && d.body));
  check('apply: token sent only as a bearer header', d && d.auth === 'Bearer ghtoken');

  calls = [];
  runs = { 'apply-team-changes.yml': [run('in_progress', null, '2026-11-02T10:00:00Z')] };
  r = await logCall('POST', '/log/apply', { by: 'PL' }, { e: logEnv(GH) });
  check('apply: refuses while a run is still going (409)', r.status === 409 && !calls.some((c) => c.method === 'POST'));

  runs = { 'apply-team-changes.yml': [] };
  dispatchStatus = 422;
  r = await logCall('POST', '/log/apply', { by: 'PL' }, { e: logEnv(GH) });
  check('apply: GitHub refusing is reported (502)', r.status === 502);
  dispatchStatus = 204;

  runs = {
    'apply-team-changes.yml': [run('completed', 'success', '2026-11-02T10:00:00Z')],
    'pages.yml': [run('in_progress', null, '2026-11-02T10:01:30Z'), run('completed', 'success', '2026-11-01T08:00:00Z')],
    'worker.yml': [run('completed', 'success', '2026-11-01T08:00:00Z')],
  };
  r = await logCall('GET', '/log/apply/status', null, { e: logEnv(GH) });
  check('apply status: latest run and the deploys it started', r.status === 200 && r.body.apply.conclusion === 'success' && r.body.site.status === 'in_progress' && r.body.worker === null, JSON.stringify(r.body));
  r = await logCall('GET', '/log/apply/status', null, { e: logEnv(GH), pass: 'nope' });
  check('apply status: needs the passcode', r.status === 401);

  // What the run set aside, sent back by the workflow (no Origin, with the passcode).
  const withId = (x, id) => ({ ...x, id });
  runs['apply-team-changes.yml'] = [withId(run('completed', 'success', '2026-11-02T10:00:00Z'), 555)];
  const report = { run: 555, setAside: [{ kind: 'service', id: 'kbop', name: 'KBOP', by: 'PL', why: 'still to be completed' }, { kind: 'odd<b>', id: 'x', why: 'y' }, { id: '' }] };
  r = await logCall('POST', '/log/apply/report', report, { e: logEnv(GH), origin: null, pass: 'nope' });
  check('apply report: needs the passcode', r.status === 401);
  r = await logCall('POST', '/log/apply/report', { run: 'x', setAside: [] }, { e: logEnv(GH), origin: null });
  check('apply report: a bad report is refused', r.status === 400);
  r = await logCall('POST', '/log/apply/report', report, { e: logEnv(GH), origin: null });
  check('apply report: the workflow can send it with no Origin', r.status === 200 && r.body.ok, JSON.stringify(r.body));
  r = await logCall('GET', '/log/apply/status', null, { e: logEnv(GH) });
  const rep = r.body.report;
  check('apply status: includes what that run set aside, cleaned', rep && rep.run === 555 && rep.setAside.length === 2 && rep.setAside[0].id === 'kbop' && rep.setAside[1].kind === 'service', JSON.stringify(r.body));
  runs['apply-team-changes.yml'] = [withId(run('in_progress', null, '2026-11-02T11:00:00Z'), 556)];
  r = await logCall('GET', '/log/apply/status', null, { e: logEnv(GH) });
  check('apply status: an older run\'s report is left out', r.status === 200 && r.body.report === null, JSON.stringify(r.body));
  globalThis.fetch = realFetch;
}

console.log(`passed=${pass} failed=${fail}`);
process.exit(fail ? 1 : 0);
