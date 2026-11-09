// One-off conversion (November 2026) from the old listing shape to organisation > service > project > cohort.
// Kept in the repository as a record of exactly what was done; it isn't run by any workflow.
//
//   node scripts/convert-structure.mjs            convert data/services/*.json in place and write data/organisations.json
//   node scripts/convert-structure.mjs --check    only report what it would do
//
// What it does, for every listing:
//   - "activities" become "projects" (name, overview, duration), each with an id made from its name.
//   - A listing with one project moves its "locations" into that project's "where". With several projects the
//     places stay on the service ("places used by every project"), as nothing says which place is whose.
//   - "status" is kept word for word: for Healthy Working Life schemes in team "notes", for everything else
//     (the October 2026 web research verdict) in "provenance.status".
//   - "notes" stay as team notes (they are research and admin notes today), and are no longer sent to the AI.
//   - Dates written in text for four schemes, and Raise Your Game's two age cohorts, are set by hand below.
//     The original wording is kept in the project's "duration" or in the team notes.
//   - Each distinct organisation name becomes one record in data/organisations.json, with no overview yet.
//     Names that look like the same organisation are listed for the team to combine; nothing is merged here.
//     Organisation records carry no Healthy Working Life marker: that stays on each service.
//
// Then it checks that no text was lost: every piece of text in each old listing must still appear in the new one,
// apart from the hand-made changes listed in TRANSFORMED, which are reported.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data', 'services');
const checkOnly = process.argv.includes('--check');

const slug = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');

// Dates and cohorts taken from the wording already in the listings. The wording itself stays in "duration".
const HAND = {
  'audio-boost': (p) => { p.runsFrom = '2027-01-04'; },
  'p2p-fusion-housing': (p) => { p.runsFrom = '2026-09-01'; p.referralsUntil = '2027-03-01'; },
  'p2p-proper-job': (p) => { p.runsFrom = '2026-09-01'; p.referralsUntil = '2027-03-01'; },
  'shared-goods-shared-hope': (p) => { p.runsFrom = '2026-10-01'; p.runsTo = '2027-03-31'; p.places = '10 places'; },
  'raise-your-game': (p, s) => {
    p.cohorts = [
      { id: 'cohort-1', name: 'Cohort 1: ages 18 to 24', age: '18 to 24', eligibility: ['Aged 18 to 24'] },
      { id: 'cohort-2', name: 'Cohort 2: ages 50 and over', age: '50+', eligibility: ['Aged 50+'] },
    ];
    s.eligibility = s.eligibility.filter((e) => e !== 'Aged 18 to 24 (cohort 1) or aged 50+ (cohort 2)');
  },
};
// Text deliberately reworded by HAND, so the no-text-lost check knows about it.
const TRANSFORMED = { 'raise-your-game': ['Aged 18 to 24 (cohort 1) or aged 50+ (cohort 2)'] };

const ORDER = ['id', 'name', 'organisation', 'logo', 'mapLinks', 'open', 'hwlFunded', 'level', 'audience', 'categories', 'whoFor', 'age', 'webpage', 'email', 'phone', 'social',
  'locations', 'areas', 'eligibility', 'exclusions', 'gate', 'healthFocus', 'requiresMention', 'referralRoutes', 'selfReferral', 'projects', 'workExperience', 'cost', 'languages',
  'coachNotes', 'notes', 'lastUpdated', 'reviewCycle', 'provenance', 'listing'];

function convert(old) {
  const s = structuredClone(old);
  const acts = s.activities || [];
  delete s.activities;
  const used = new Set();
  s.projects = acts.map((a) => {
    let id = slug(a.name) || 'project';
    for (let n = 2; used.has(id); n++) id = slug(a.name).slice(0, 46) + '-' + n;
    used.add(id);
    const p = { id, name: a.name, overview: a.summary };
    if (a.duration && a.duration.trim()) p.duration = a.duration;
    return p;
  });
  if (s.projects.length === 1 && s.locations.length) {
    s.projects[0].where = s.locations;
    s.locations = [];
  }
  if (HAND[s.id]) HAND[s.id](s.projects[0], s);
  // Status, kept word for word.
  if (s.status) {
    if (s.hwlFunded) s.notes = (s.notes ? s.notes + '\n\n' : '') + 'Status before November 2026: ' + s.status;
    else s.provenance = { ...s.provenance, status: s.status };
  }
  delete s.status;
  return Object.fromEntries(ORDER.filter((k) => k in s).map((k) => [k, s[k]]));
}

// Every piece of text in a listing, for the no-text-lost check.
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const orgs = new Map(); // name -> { id, name }
const lost = [];
const reworded = [];
let converted = 0;
for (const f of files) {
  const old = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (old.projects) continue; // already converted
  const s = convert(old);
  const after = new Set(strings(s));
  const afterText = JSON.stringify(s);
  for (const t of strings(old)) {
    if (after.has(t) || afterText.includes(JSON.stringify(t).slice(1, -1))) continue;
    if ((TRANSFORMED[old.id] || []).includes(t)) reworded.push(`${old.id}: "${t}"`);
    else lost.push(`${old.id}: "${t}"`);
  }
  if (!orgs.has(s.organisation)) orgs.set(s.organisation, { id: '', name: s.organisation });
  if (!checkOnly) fs.writeFileSync(path.join(dir, f), JSON.stringify(s, null, 2) + '\n');
  converted += 1;
}

// One record per organisation name. Ids from the name, made unique.
const taken = new Set();
const list = [...orgs.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
for (const o of list) {
  let id = slug(o.name) || 'organisation';
  for (let n = 2; taken.has(id); n++) id = slug(o.name).slice(0, 46) + '-' + n;
  taken.add(id);
  o.id = id;
}
// Names that look like the same organisation: the same once "Ltd", "CIC", "The" and punctuation are ignored, or one
// starting with the other. Listed for the team; never merged here.
const simple = (t) => t.toLowerCase().replace(/\b(the|ltd|limited|cic|plc|charity|trust)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const maybeSame = [];
for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
  const a = simple(list[i].name);
  const b = simple(list[j].name);
  if (a && b && (a === b || (a.length > 5 && b.startsWith(a + ' ')) || (b.length > 5 && a.startsWith(b + ' ')))) maybeSame.push(`${list[i].name}  |  ${list[j].name}`);
}
const orgFile = path.join(root, 'data', 'organisations.json');
if (!checkOnly && !fs.existsSync(orgFile)) fs.writeFileSync(orgFile, JSON.stringify({ organisations: list }, null, 2) + '\n');

console.log(`Converted ${converted} listings${checkOnly ? ' (check only: nothing written)' : ''}. ${list.length} organisations.`);
console.log(`Text lost: ${lost.length}${lost.length ? '\n  ' + lost.join('\n  ') : ''}`);
console.log(`Reworded by hand (${reworded.length}):${reworded.length ? '\n  ' + reworded.join('\n  ') : ''}`);
console.log(`Organisation names that may be the same (${maybeSame.length}), for the team to check and combine in Admin:${maybeSame.length ? '\n  ' + maybeSame.join('\n  ') : ''}`);
if (lost.length) process.exitCode = 1;
