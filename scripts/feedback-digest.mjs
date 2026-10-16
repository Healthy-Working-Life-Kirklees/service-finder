// Prints a Markdown digest of new user feedback, for the weekly triage (and later for the maintenance agent).
//
//   WORKER_URL=https://hwl-service-finder.<subdomain>.workers.dev FEEDBACK_PASSCODE=... npm run feedback-digest > digest.md
//
// It fetches the entries with status "New" from the Worker and compares them with the scheme files in
// data/services/. It is read-only: it changes nothing on the Worker or in the data. Mark entries Reviewed,
// Actioned or Not actioned separately (see "User feedback" in the README).
//
// To work from a saved copy instead (for example a download of /feedback/items), pass --input <file>.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAG_DAYS = 30;
const FLAG_AT = 2; // reports about one scheme in FLAG_DAYS that put it at the top
const THIN_AT = 2; // a category with this many open schemes or fewer is "thin"

const LABELS = {
  closed: "It has closed or isn't running",
  'contact-wrong': 'Phone, email or website is wrong',
  'eligibility-wrong': "Who it's for or eligibility is wrong",
  'no-reply': "Couldn't get through or got no reply",
  'not-in-area': "Isn't available in my area",
  'missing-details': 'Something useful is missing from the listing',
  other: 'Something else',
  'none-fit': 'None of these fit',
  'info-wrong': 'The information looked wrong',
  'hard-to-understand': 'It was hard to understand',
  'missed-service': 'It missed a service I know about',
  'missing-service': 'A service that isn\'t listed',
  'missing-support': "A kind of support they couldn't find",
  'missing-other': 'Something else missing',
};

// ---------- input ----------
async function load() {
  const i = process.argv.indexOf('--input');
  if (i > 0) {
    const d = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
    return (Array.isArray(d) ? d : d.items || []).filter((x) => x.status === 'New');
  }
  const base = String(process.env.WORKER_URL || '').replace(/\/$/, '');
  const pass = process.env.FEEDBACK_PASSCODE || '';
  if (!base || !pass) {
    console.error('Set WORKER_URL and FEEDBACK_PASSCODE, or pass --input <file>.');
    process.exit(1);
  }
  const r = await fetch(base + '/feedback/items?status=New', { headers: { 'x-feedback-passcode': pass } });
  if (r.status === 401) throw new Error('The passcode was not accepted.');
  if (r.status === 404) throw new Error('The feedback read routes are off (is the FEEDBACK_PASSCODE secret set on the Worker?).');
  if (!r.ok) throw new Error('The Worker said ' + r.status + '.');
  return (await r.json()).items || [];
}

const dir = path.join(root, 'data', 'services');
const services = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const byId = new Map(services.map((s) => [s.id, s]));

// ---------- helpers ----------
const fileOf = (id) => '`data/services/' + id + '.json`';
const nameOf = (id) => (byId.has(id) ? byId.get(id).name : id + ' (no longer in the data)');
const count = (xs) => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))); };
const counted = (xs, label = (x) => x) => count(xs).map(([k, n]) => label(k) + ' (' + n + ')').join(', ');
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);
const quote = (x) => '"' + String(x.text).replace(/\s+/g, ' ') + '" (' + [x.date, x.mode, x.lang].join(', ') + ')';
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(the|ltd|limited|cic|uk)\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
function url(u) {
  try {
    const x = new URL(u);
    return { host: x.hostname.replace(/^www\./, ''), full: x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') };
  } catch {
    return null;
  }
}

// Possible matches for a suggested service among the schemes we already have.
function lookAlikes(name, website) {
  const n = norm(name);
  const u = url(website);
  const found = [];
  for (const s of services) {
    const how = [];
    const sn = norm(s.name);
    if (n && sn && (n === sn || (n.length >= 6 && (sn.includes(n) || n.includes(sn))))) how.push('name');
    const su = url(s.webpage);
    if (u && su && u.full === su.full) how.push('website');
    if (how.length) found.push({ id: s.id, how, strong: true });
    else if (n && norm(s.organisation) && n === norm(s.organisation)) found.push({ id: s.id, how: ['organisation'], strong: false });
    else if (u && su && u.host === su.host) found.push({ id: s.id, how: ['same web domain'], strong: false });
  }
  return found;
}

// ---------- the digest ----------
function digest(items) {
  const out = [];
  const say = (...lines) => out.push(...lines);
  const cards = items.filter((x) => x.kind === 'card');
  const replies = items.filter((x) => x.kind === 'reply');
  const gaps = items.filter((x) => x.kind === 'gap');

  say('# Service Finder feedback digest', '');
  say(`Made on ${new Date().toISOString().slice(0, 10)} from ${plural(items.length, 'new entry', 'new entries')}: ${plural(cards.length, 'listing report')}, ${plural(replies.length, '"was this helpful?" answer')} and ${plural(gaps.length, '"what\'s missing" report')}.`);
  say('Nothing has been changed. Decide what to do with each one, make any change to the data through a pull request, then mark the entries Actioned or Not actioned.', '');

  // ===== What's wrong =====
  say("## What's wrong", '');
  const problems = cards.filter((x) => !(x.reasons.length === 1 && x.reasons[0] === 'missing-details'));
  const bySchemes = new Map();
  for (const x of problems) for (const id of x.schemeIds) bySchemes.set(id, [...(bySchemes.get(id) || []), x]);
  const ranked = [...bySchemes.entries()].sort((a, b) => b[1].length - a[1].length || nameOf(a[0]).localeCompare(nameOf(b[0])));

  say(`### Flagged: ${FLAG_AT} or more reports in the last ${FLAG_DAYS} days`, '');
  const since = daysAgo(FLAG_DAYS);
  const flagged = ranked.map(([id, xs]) => [id, xs.filter((x) => x.date >= since).length]).filter(([, n]) => n >= FLAG_AT);
  if (flagged.length) for (const [id, n] of flagged) say(`- **${nameOf(id)}** (\`${id}\`): ${n} reports. ${fileOf(id)}`);
  else say('None.');
  say('');

  say('### Reports by scheme, most reported first', '');
  if (!ranked.length) say('No reports about listings.', '');
  for (const [id, xs] of ranked) {
    const s = byId.get(id);
    say(`#### ${nameOf(id)} (\`${id}\`): ${plural(xs.length, 'report')}`, '');
    say(`- File: ${fileOf(id)}${s ? `, last checked ${s.lastUpdated}${s.open ? '' : ', marked not open'}` : ''}`);
    say(`- The version people saw was last checked: ${counted(xs.map((x) => x.recordLastUpdated || 'unknown'))}`);
    say(`- Reasons: ${counted(xs.flatMap((x) => x.reasons), (r) => LABELS[r] || r)}`);
    const said = xs.filter((x) => x.text);
    if (said.length) {
      say('- What people said:');
      for (const x of said) say('  - ' + quote(x));
    }
    say('');
  }

  const wrongReplies = replies.filter((x) => x.helpful === false && x.reasons.includes('info-wrong'));
  if (wrongReplies.length) {
    say('### Replies where "the information looked wrong"', '');
    say('These say which schemes were shown, not which one was wrong. Worth a look if a scheme also appears above.', '');
    for (const [id, n] of count(wrongReplies.flatMap((x) => x.schemeIds))) say(`- ${nameOf(id)} (\`${id}\`): shown in ${plural(n, 'reply', 'replies')}`);
    say('');
  }

  // ===== What's missing =====
  say("## What's missing", '');

  say('### Suggested services', '');
  const suggestions = gaps.filter((x) => x.reasons.includes('missing-service'));
  const groups = [];
  for (const x of suggestions) {
    const ms = x.missedService || {};
    const key = norm(ms.name);
    const u = url(ms.website);
    let g = groups.find((g) => (key && g.keys.has(key)) || (u && g.urls.has(u.full)));
    if (!g) groups.push((g = { keys: new Set(), urls: new Set(), items: [] }));
    if (key) g.keys.add(key);
    if (u) g.urls.add(u.full);
    g.items.push(x);
  }
  groups.sort((a, b) => b.items.length - a.items.length);
  if (!groups.length) say('None.', '');
  for (const g of groups) {
    const names = g.items.map((x) => (x.missedService || {}).name).filter(Boolean);
    const sites = [...new Set(g.items.map((x) => (x.missedService || {}).website).filter(Boolean))];
    // The name given most often (the first one given, if it's a tie).
    const top = names.length ? count(names)[0][1] : 0;
    const title = names.find((x) => names.filter((y) => y === x).length === top) || sites[0] || 'No name given';
    const likes = [];
    for (const x of g.items) for (const l of lookAlikes((x.missedService || {}).name, (x.missedService || {}).website)) if (!likes.some((y) => y.id === l.id)) likes.push(l);
    const strong = likes.filter((l) => l.strong);
    const verdict = strong.length ? ` - likely duplicate of ${strong.map((l) => `\`${l.id}\` (matched on ${l.how.join(' and ')})`).join(', ')}` : '';
    say(`#### ${title}: suggested ${g.items.length === 1 ? 'once' : g.items.length + ' times'}${verdict}`, '');
    if (names.length > 1) say(`- Names given: ${counted(names)}`);
    say(`- Website: ${sites.length ? sites.join(', ') : 'not given'}`);
    const areas = g.items.map((x) => (x.missedService || {}).area).filter(Boolean);
    say(`- Area: ${areas.length ? counted(areas) : 'not given'}`);
    const weak = likes.filter((l) => !l.strong);
    if (weak.length) say(`- Check against: ${weak.slice(0, 5).map((l) => `\`${l.id}\` (${l.how.join(', ')})`).join(', ')}${weak.length > 5 ? ` and ${weak.length - 5} more` : ''}`);
    if (!likes.length) say('- Not found in the data. Research it, and if it checks out add a new scheme file.');
    const said = g.items.filter((x) => x.text);
    if (said.length) {
      say('- What people said:');
      for (const x of said) say('  - ' + quote(x));
    }
    say('');
  }

  say('### Listings missing useful details', '');
  const details = cards.filter((x) => x.reasons.includes('missing-details'));
  if (!details.length) say('None.');
  for (const [id, n] of count(details.flatMap((x) => x.schemeIds))) {
    say(`- **${nameOf(id)}** (\`${id}\`): ${plural(n, 'report')}. ${fileOf(id)}`);
    for (const x of details.filter((x) => x.schemeIds.includes(id) && x.text)) say('  - ' + quote(x));
  }
  say('');

  say("### Kinds of support people couldn't find", '');
  const support = gaps.filter((x) => x.reasons.includes('missing-support'));
  const cats = count(support.flatMap((x) => (x.gapCategories.length ? x.gapCategories : ['Not given'])));
  if (!cats.length) say('None.', '');
  else {
    say(`Compared with the open schemes in the data for each category. "Thin" means ${THIN_AT} or fewer.`, '');
    say('| Category | Requests | Areas | Open schemes in the data | |', '|---|---|---|---|---|');
    for (const [c, n] of cats) {
      const areas = support.filter((x) => x.gapCategories.includes(c) || (c === 'Not given' && !x.gapCategories.length)).map((x) => x.gapArea).filter(Boolean);
      const have = services.filter((s) => s.open && (s.categories || []).includes(c)).length;
      const known = services.some((s) => (s.categories || []).includes(c));
      say(`| ${c} | ${n} | ${areas.length ? counted(areas) : 'not given'} | ${known ? have : '-'} | ${known && have <= THIN_AT ? '**thin**' : ''} |`);
    }
    say('');
    const said = support.filter((x) => x.text);
    if (said.length) {
      say('What people said:');
      for (const x of said) say('- ' + quote(x));
      say('');
    }
  }

  const other = gaps.filter((x) => x.reasons.includes('missing-other') && x.text);
  if (other.length) {
    say('### Something else missing', '');
    for (const x of other) say('- ' + quote(x));
    say('');
  }
  const missed = replies.filter((x) => x.helpful === false && x.reasons.includes('missed-service')).length;
  if (missed) say(`"It missed a service I know about" was ticked under ${plural(missed, 'reply', 'replies')}. Any details people gave are in the suggestions above.`, '');

  // ===== Helpful or not =====
  say('## Helpful or not', '');
  const answered = replies.filter((x) => typeof x.helpful === 'boolean');
  if (!answered.length) say('No answers.', '');
  else {
    say('| Mode | Language | Yes | No |', '|---|---|---|---|');
    for (const mode of ['public', 'staff']) for (const lang of ['en', 'pl', 'ur']) {
      const xs = answered.filter((x) => x.mode === mode && x.lang === lang);
      if (xs.length) say(`| ${mode} | ${lang} | ${xs.filter((x) => x.helpful).length} | ${xs.filter((x) => !x.helpful).length} |`);
    }
    say('');
    const no = answered.filter((x) => !x.helpful);
    if (no.length) say(`Reasons given with "No": ${counted(no.flatMap((x) => x.reasons), (r) => LABELS[r] || r) || 'none'}.`, '');
    const said = no.filter((x) => x.text);
    if (said.length) {
      say('What people said with "No":');
      for (const x of said) say('- ' + quote(x));
      say('');
    }
  }
  const redacted = items.filter((x) => x.redacted).length;
  if (redacted) say(`Personal details were removed from ${plural(redacted, 'entry', 'entries')} before they were saved.`, '');
  return out.join('\n');
}

load()
  .then((items) => process.stdout.write(digest(items) + '\n'))
  .catch((e) => {
    console.error('Could not make the digest: ' + e.message);
    process.exit(1);
  });
