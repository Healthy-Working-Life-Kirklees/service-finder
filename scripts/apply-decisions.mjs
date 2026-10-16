// Writes the MVP team's changes from the All services page into the scheme files, so they can go into a pull
// request: first new services the team has added (each becomes data/services/<id>.json), then edits to a
// service's details, then the listing decisions (include, review or exclude). A new service starts as "review"
// and only goes on the live list if the team has also decided to include it.
// Nothing reaches the live site until that pull request is merged.
//
// Usually run from GitHub: Actions > Apply team changes > Run workflow (.github/workflows/apply-team-changes.yml),
// which opens the pull request itself. By hand:
//
//   WORKER_URL=https://hwl-service-finder.<subdomain>.workers.dev TEAM_PASSCODE='...' npm run apply-decisions
//   npm run apply-decisions -- --input team-changes.json   (the file saved from the All services page)
//   add --dry-run to see what would change without changing anything
//
// It prints a Markdown summary of what changed, ready to paste into the pull request.
//
// Safety:
// - An edit is skipped if someone has changed the same field in the data since the edit was made (it says which),
//   or if the result wouldn't pass data/schema.json. Either way it's reported, and nothing is half-applied.
// - A service still marked "To be completed" is never put on the live list: it is reported instead, so a person
//   can fill in its details first (npm run check-data would fail otherwise).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const PLACEHOLDER = 'To be completed';
const DECISIONS = ['include', 'review', 'exclude'];
const WORD = { include: 'Include on the live list', review: 'Needs further review', exclude: 'Exclude completely' };
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'data', 'schema.json'), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const REQUIRED = new Set(schema.required);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes('--dry-run');
const dir = path.resolve(opt('--dir') || path.join(root, 'data', 'services'));
const input = opt('--input');

async function load() {
  if (input) {
    const d = JSON.parse(fs.readFileSync(input, 'utf8'));
    return { decisions: d.decisions || {}, edits: d.edits || {}, added: d.added || {} };
  }
  const url = String(process.env.WORKER_URL || '').replace(/\/$/, '');
  const pass = process.env.TEAM_PASSCODE || '';
  if (!url || !pass) {
    console.error('Give --input <file>, or set WORKER_URL and TEAM_PASSCODE.');
    process.exit(2);
  }
  const get = async (p) => {
    const res = await fetch(url + p, { headers: { 'x-team-passcode': pass } });
    if (!res.ok) {
      console.error(`The Worker said ${res.status} for ${p}: ${(await res.text()).slice(0, 200)}`);
      process.exit(1);
    }
    return res.json();
  };
  return { decisions: (await get('/log/decisions')).decisions || {}, edits: (await get('/log/edits')).edits || {}, added: (await get('/log/new')).added || {} };
}

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const show = (v) => (v == null || v === '' ? '(none)' : Array.isArray(v) ? (v.length ? v.map((x) => (typeof x === 'object' ? x.name : x)).join('; ') : '(none)') : typeof v === 'object' ? JSON.stringify(v) : String(v));
const cut = (t) => (t.length > 120 ? t.slice(0, 117) + '...' : t);

// The scheme files, read once. Edits change them in memory first, so the decisions see the edited details.
const files = new Map();
function open(id) {
  if (!ID_RE.test(id)) return null;
  if (!files.has(id)) {
    const file = path.join(dir, id + '.json');
    files.set(id, fs.existsSync(file) ? { file, s: JSON.parse(fs.readFileSync(file, 'utf8')), dirty: false } : null);
  }
  return files.get(id);
}

const { decisions, edits, added } = await load();
const unknown = new Set();

// ---------- 1. new services ----------
// Every other service's name and organisation, to catch an obvious duplicate.
const taken = new Map();
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    taken.set((s.name + ' | ' + s.organisation).toLowerCase(), s.id);
  } catch {}
}
const created = [];
const newProblems = [];
let addedSame = 0;
for (const [id, a] of Object.entries(added).sort(([x], [y]) => x.localeCompare(y))) {
  if (!a || !a.service || typeof a.service !== 'object') continue;
  if (!ID_RE.test(id) || id.length > 50) {
    newProblems.push({ id, name: a.service.name, by: a.by, why: 'the id is not valid' });
    continue;
  }
  const file = path.join(dir, id + '.json');
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Already applied by an earlier run: the file came from this entry.
    if (existing.provenance && String(existing.provenance.source || '').startsWith('Added on the All services page')) addedSame += 1;
    else newProblems.push({ id, name: a.service.name, by: a.by, why: 'a service with this id is already in the data; change the id' });
    continue;
  }
  const dupe = taken.get((a.service.name + ' | ' + a.service.organisation).toLowerCase());
  if (dupe) {
    newProblems.push({ id, name: a.service.name, by: a.by, why: `it has the same name and organisation as \`${dupe}\`` });
    continue;
  }
  const date = String(a.created || a.t || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const lastDate = String(a.t || '').slice(0, 10) || date;
  const s = { id, ...a.service, hwlFunded: false };
  for (const k of Object.keys(s)) if (s[k] === null && !REQUIRED.has(k)) delete s[k];
  s.lastUpdated = lastDate;
  s.reviewCycle = s.reviewCycle || 'Quarterly';
  s.provenance = { source: `Added on the All services page by ${a.createdBy || a.by} (${date})`, evidence: a.note };
  if (a.checkedUrl) s.provenance.checkedUrl = a.checkedUrl;
  s.listing = { decision: 'review', reason: `New service added by ${a.createdBy || a.by}, waiting for the team to review it.` };
  // Keep the field order the same as the other files.
  const order = [...Object.keys(schema.properties)];
  const ordered = Object.fromEntries(order.filter((k) => k in s).map((k) => [k, s[k]]));
  if (!validate(ordered)) {
    newProblems.push({ id, name: s.name, by: a.by, why: "it wouldn't pass the data check: " + validate.errors.map((x) => `${x.instancePath || '(top)'} ${x.message}`).slice(0, 3).join('; ') });
    continue;
  }
  files.set(id, { file, s: ordered, dirty: true });
  taken.set((s.name + ' | ' + s.organisation).toLowerCase(), id);
  created.push({ id, name: s.name, organisation: s.organisation, by: a.createdBy || a.by, date, note: a.note });
}

// ---------- 2. edits to details ----------
const edited = [];
const conflicts = [];
const invalid = [];
let editsSame = 0;
for (const [id, e] of Object.entries(edits).sort(([a], [b]) => a.localeCompare(b))) {
  if (!e || !e.changes || typeof e.changes !== 'object') continue;
  const f = open(id);
  if (!f) {
    unknown.add(id);
    continue;
  }
  const cur = f.s;
  const keys = Object.keys(e.changes);
  if (keys.every((k) => same(cur[k], e.changes[k]))) {
    editsSame += 1;
    continue;
  }
  // Someone changed the same field in the data since this edit was made: don't overwrite their change.
  const clash = keys.filter((k) => e.before && k in e.before && !same(cur[k], e.before[k]) && !same(cur[k], e.changes[k]));
  if (clash.length) {
    conflicts.push({ id, name: cur.name, by: e.by, fields: clash });
    continue;
  }
  const next = structuredClone(cur);
  for (const k of keys) {
    const v = e.changes[k];
    if (v === null && !REQUIRED.has(k)) delete next[k];
    else next[k] = v;
  }
  const date = String(e.t || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  if (e.checked) {
    next.lastUpdated = date;
    next.provenance = { ...next.provenance, evidence: `Checked by ${e.by} on ${date}: ${e.note}` };
    if (e.checkedUrl) next.provenance.checkedUrl = e.checkedUrl;
  }
  if (!validate(next)) {
    invalid.push({ id, name: cur.name, by: e.by, errors: validate.errors.map((x) => `${x.instancePath || '(top)'} ${x.message}`).slice(0, 3) });
    continue;
  }
  const changes = keys.filter((k) => !same(cur[k], next[k])).map((k) => `${k}: ${cut(show(cur[k]))} → ${cut(show(next[k]))}`);
  f.s = next;
  f.dirty = true;
  edited.push({ id, name: next.name, by: e.by, date, note: e.note, checked: Boolean(e.checked), changes });
}

// ---------- 3. listing decisions ----------
const changed = [];
const blocked = [];
let decisionsSame = 0;
for (const [id, d] of Object.entries(decisions).sort(([a], [b]) => a.localeCompare(b))) {
  if (!d || !DECISIONS.includes(d.decision)) continue;
  const f = open(id);
  if (!f) {
    unknown.add(id);
    continue;
  }
  const s = f.s;
  const date = String(d.t || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const before = s.listing || {};
  // Already applied: same decision, recorded on the same day by the same person.
  if (before.decision === d.decision && before.date === date && before.by === d.by) {
    decisionsSame += 1;
    continue;
  }
  if (d.decision === 'include' && JSON.stringify(s).includes(PLACEHOLDER)) {
    blocked.push({ id, name: s.name, by: d.by });
    continue;
  }
  s.listing = {
    decision: d.decision,
    reason: (d.note || '').trim() || (d.decision === 'include' ? 'Included by the MVP team.' : 'Decided by the MVP team.'),
    by: String(d.by || 'MVP team').trim(),
    date,
  };
  f.dirty = true;
  changed.push({ id, name: s.name, from: before.decision, to: d.decision, by: s.listing.by, date, reason: s.listing.reason });
}

if (!dryRun) for (const f of files.values()) if (f && f.dirty) fs.writeFileSync(f.file, JSON.stringify(f.s, null, 2) + '\n');

// ---------- summary ----------
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const out = [`# MVP team changes${dryRun ? ' (dry run: nothing changed)' : ''}`, ''];
out.push(`${n(created.length, 'new service', 'new services')} added, ${addedSame} already added. ${n(edited.length, 'service', 'services')} with edited details, ${editsSame} already up to date. ${n(changed.length, 'listing decision', 'listing decisions')} applied, ${decisionsSame} already up to date.`, '');
if (created.length) {
  out.push(`## New services (${created.length})`, '');
  out.push('Each starts as "waiting for review" unless the team has also decided to include or exclude it (below).', '');
  for (const c of created) out.push(`- **${c.name}**, ${c.organisation} (\`data/services/${c.id}.json\`). Added by ${c.by}, ${c.date}: ${c.note}`);
  out.push('');
}
if (newProblems.length) {
  out.push(`## New services not added (${newProblems.length})`, '');
  for (const c of newProblems) out.push(`- **${c.name || c.id}** (\`${c.id}\`), added by ${c.by}: ${c.why}.`);
  out.push('');
}
if (edited.length) {
  out.push(`## Details changed (${edited.length})`, '');
  for (const x of edited) {
    out.push(`- **${x.name}** (\`data/services/${x.id}.json\`). ${x.by}, ${x.date}${x.checked ? ', checked as current' : ''}: ${x.note}`);
    for (const c of x.changes) out.push(`  - ${c}`);
  }
  out.push('');
}
for (const to of DECISIONS) {
  const rows = changed.filter((c) => c.to === to);
  if (!rows.length) continue;
  out.push(`## ${WORD[to]} (${rows.length})`, '');
  for (const c of rows) out.push(`- **${c.name}** (\`data/services/${c.id}.json\`)${c.from && c.from !== c.to ? `, was ${c.from}` : ''}. ${c.by}, ${c.date}: ${c.reason}`);
  out.push('');
}
if (conflicts.length) {
  out.push(`## Edits not applied: the data has changed since (${conflicts.length})`, '');
  out.push('Someone changed these fields in the data after the edit was made. Look at both, then edit the service again on the All services page.', '');
  for (const c of conflicts) out.push(`- **${c.name}** (\`data/services/${c.id}.json\`), edited by ${c.by}: ${c.fields.join(', ')}`);
  out.push('');
}
if (invalid.length) {
  out.push(`## Edits not applied: wouldn't pass the data check (${invalid.length})`, '');
  for (const c of invalid) out.push(`- **${c.name}** (\`data/services/${c.id}.json\`), edited by ${c.by}: ${c.errors.join('; ')}`);
  out.push('');
}
if (blocked.length) {
  out.push(`## Not applied: details still to be completed (${blocked.length})`, '');
  out.push(`The team chose to include these, but their files still say "${PLACEHOLDER}". Fill in the details (they can be edited on the All services page), then run this again.`, '');
  for (const b of blocked) out.push(`- **${b.name}** (\`data/services/${b.id}.json\`), chosen by ${b.by}`);
  out.push('');
}
if (unknown.size) out.push(`Changes for services that aren't in the data (renamed or removed?): ${[...unknown].join(', ')}`, '');
console.log(out.join('\n'));
