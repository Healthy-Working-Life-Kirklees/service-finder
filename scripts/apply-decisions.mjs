// Writes the development team's changes from the All services page into the scheme files, so they can go into a pull
// request: first changes to organisations (data/organisations.json: rename, overview, website, combine) and venues
// (data/venues.json: rename, address, postcode, combine), then new
// services the team has added (each becomes data/services/<id>.json), then edits to a service's details, then the
// listing decisions (include, review or exclude). A new service starts as "review" and only goes on the live list
// if the team has also decided to include it.
//
// Organisations: a service names its organisation. A name that isn't an organisation yet becomes a new one. An
// "organisationOverview" in a service's change is written to its organisation (once, for all its services).
// Combining moves every service to the other organisation; the old name is kept there as an alias, and nothing in
// its overview or website is lost (it goes into that organisation's notes if the other already has its own).
// Organisations never carry the Healthy Working Life marker: that stays on each service.
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
// The organisations file: data/organisations.json, or with --dir, an organisations.json next to the scheme files
// (if there is one), so a test on a copy never touches the real one.
const orgPath = opt('--orgs') ? path.resolve(opt('--orgs')) : opt('--dir') ? path.join(dir, 'organisations.json') : path.join(root, 'data', 'organisations.json');
// The venues file, chosen the same way.
const venuePath = opt('--venues') ? path.resolve(opt('--venues')) : opt('--dir') ? path.join(dir, 'venues.json') : path.join(root, 'data', 'venues.json');

async function load() {
  if (input) {
    const d = JSON.parse(fs.readFileSync(input, 'utf8'));
    return { decisions: d.decisions || {}, edits: d.edits || {}, added: d.added || {}, orgEdits: d.orgs || {}, venueEdits: d.venues || {} };
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
  return {
    decisions: (await get('/log/decisions')).decisions || {}, edits: (await get('/log/edits')).edits || {}, added: (await get('/log/new')).added || {},
    orgEdits: (await get('/log/orgs').catch(() => ({ orgs: {} }))).orgs || {},
    venueEdits: (await get('/log/venues').catch(() => ({ venues: {} }))).venues || {},
  };
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

const { decisions, edits, added, orgEdits, venueEdits } = await load();
const unknown = new Set();

// ---------- 0. organisations ----------
const slug = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
const orgFile = fs.existsSync(orgPath) ? JSON.parse(fs.readFileSync(orgPath, 'utf8')) : null;
const orgs = orgFile ? orgFile.organisations : [];
let orgsDirty = false;
const orgByName = (name) => orgs.find((o) => o.name === name);
const orgById = (id) => orgs.find((o) => o.id === id);
// The organisation with this name, made if it isn't there yet.
const orgsMade = [];
function ensureOrg(name) {
  if (!orgFile || !name) return null;
  let o = orgByName(name);
  if (o) return o;
  let id = slug(name) || 'organisation';
  for (let n = 2; orgById(id); n++) id = slug(name).slice(0, 46) + '-' + n;
  o = { id, name };
  orgs.push(o);
  orgs.sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
  orgsDirty = true;
  orgsMade.push(name);
  return o;
}
// Every scheme file, read once (organisation changes can touch many services).
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !['organisations.json', 'venues.json', 'decisions.json'].includes(x))) open(f.slice(0, -5));
const servicesOf = (name) => [...files.values()].filter((f) => f && f.s && f.s.organisation === name);

const orgChanged = [];
const orgProblems = [];
let orgsSame = 0;
for (const [id, e] of Object.entries(orgEdits).sort(([a], [b]) => a.localeCompare(b))) {
  if (!orgFile || !e || !e.changes) continue;
  const o = orgById(id);
  const c = e.changes;
  if (!o) {
    if (c.mergeInto && orgById(c.mergeInto)) orgsSame += 1; // already combined by an earlier run
    else orgProblems.push({ id, by: e.by, why: "there's no organisation with this id (renamed or combined already?)" });
    continue;
  }
  const clash = Object.keys(c).filter((k) => e.before && k in e.before && !same(o[k], e.before[k]) && !same(o[k], c[k]));
  if (clash.length) {
    orgProblems.push({ id, name: o.name, by: e.by, why: 'it has changed in the data since (' + clash.join(', ') + ')' });
    continue;
  }
  const notes = [];
  if (c.mergeInto) {
    const into = orgById(c.mergeInto);
    if (!into) { orgProblems.push({ id, name: o.name, by: e.by, why: `the organisation to combine it into (${c.mergeInto}) isn't there` }); continue; }
    const moved = servicesOf(o.name);
    for (const f of moved) { f.s.organisation = into.name; f.dirty = true; }
    into.aliases = [...new Set([...(into.aliases || []), o.name, ...(o.aliases || [])])].filter((a) => a !== into.name);
    for (const k of ['overview', 'website']) {
      if (!o[k] || o[k] === into[k]) continue;
      if (!into[k]) into[k] = o[k];
      else into.notes = (into.notes ? into.notes + '\n\n' : '') + `${k === 'overview' ? 'Overview' : 'Website'} of ${o.name} before it was combined into this organisation: ${o[k]}`;
    }
    if (o.notes) into.notes = (into.notes ? into.notes + '\n\n' : '') + `Notes from ${o.name}: ${o.notes}`;
    orgs.splice(orgs.indexOf(o), 1);
    notes.push(`combined into ${into.name}; ${moved.length} service${moved.length === 1 ? '' : 's'} moved; "${o.name}" kept as another name`);
  } else {
    if (c.name && c.name !== o.name) {
      if (orgByName(c.name)) { orgProblems.push({ id, name: o.name, by: e.by, why: `another organisation is already called "${c.name}" (combine them instead)` }); continue; }
      for (const f of servicesOf(o.name)) { f.s.organisation = c.name; f.dirty = true; }
      o.aliases = [...new Set([...(o.aliases || []), o.name])].filter((a) => a !== c.name);
      notes.push(`renamed from "${o.name}" to "${c.name}"`);
      o.name = c.name;
    }
    for (const k of ['overview', 'website']) {
      if (!(k in c) || same(o[k], c[k])) continue;
      if (c[k] === null) delete o[k];
      else o[k] = c[k];
      notes.push(`${k} ${c[k] === null ? 'removed' : 'set'}`);
    }
  }
  if (!notes.length) { orgsSame += 1; continue; }
  orgsDirty = true;
  orgChanged.push({ id, name: o.name, by: e.by, note: e.note, what: notes.join('; ') });
}
// ---------- 0b. venues ----------
// One record per place (data/venues.json). The team can rename a venue, correct its address or postcode (which
// clears its ward, so it is looked up again), or combine it into another: every session moves across and the old
// name is kept as an alias. A session's venue in a change is either a venue id or a new venue written out
// ({ name, address, postcode }): a new one is matched to a venue with the same address, or added.
const venueFile = fs.existsSync(venuePath) ? JSON.parse(fs.readFileSync(venuePath, 'utf8')) : null;
const venues = venueFile ? venueFile.venues : [];
let venuesDirty = false;
const venueById = (id) => venues.find((v) => v.id === id);
const sameAddress = (a, b) => String(a).toLowerCase().replace(/[^a-z0-9]/g, '') === String(b).toLowerCase().replace(/[^a-z0-9]/g, '');
const venuesMade = [];
// The id for a venue in a change: an id as it is, a written-out one matched or (when make is true) added.
function venueId(v, make) {
  if (typeof v === 'string' || !v || typeof v !== 'object') return v;
  const found = venues.find((x) => x.postcode === v.postcode && (sameAddress(x.address, v.address) || x.name.toLowerCase() === v.name.toLowerCase()));
  if (found) return found.id;
  if (!make || !venueFile) return v;
  let id = slug(v.name) || 'venue';
  for (let n = 2; venueById(id); n++) id = slug(v.name).slice(0, 46) + '-' + n;
  venues.push({ id, name: v.name, address: v.address, postcode: v.postcode });
  venues.sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
  venuesDirty = true;
  venuesMade.push(`${v.name} (${v.postcode})`);
  return id;
}
// A copy of a service (or change) with every written-out venue turned into an id.
function settleVenues(x, make) {
  const out = structuredClone(x);
  if (Array.isArray(out.venues)) out.venues = [...new Set(out.venues.map((v) => venueId(v, make)))];
  if (Array.isArray(out.projects)) for (const p of out.projects) for (const se of p.sessions || []) if (se.venue) se.venue = venueId(se.venue, make);
  return out;
}
const sessionsAt = (id) => [...files.values()].filter((f) => f && f.s);
const venueChanged = [];
const venueProblems = [];
let venuesSame = 0;
for (const [id, e] of Object.entries(venueEdits).sort(([a], [b]) => a.localeCompare(b))) {
  if (!venueFile || !e || !e.changes) continue;
  const v = venueById(id);
  const c = e.changes;
  if (!v) {
    if (c.mergeInto && venueById(c.mergeInto)) venuesSame += 1;
    else venueProblems.push({ id, by: e.by, why: "there's no venue with this id (combined already?)" });
    continue;
  }
  const clash = Object.keys(c).filter((k) => e.before && k in e.before && !same(v[k], e.before[k]) && !same(v[k], c[k]));
  if (clash.length) {
    venueProblems.push({ id, name: v.name, by: e.by, why: 'it has changed in the data since (' + clash.join(', ') + ')' });
    continue;
  }
  const notes = [];
  if (c.mergeInto) {
    const into = venueById(c.mergeInto);
    if (!into) { venueProblems.push({ id, name: v.name, by: e.by, why: `the venue to combine it into (${c.mergeInto}) isn't there` }); continue; }
    let moved = 0;
    for (const f of sessionsAt(id)) {
      let touched = false;
      if (Array.isArray(f.s.venues) && f.s.venues.includes(id)) { f.s.venues = [...new Set(f.s.venues.map((x) => (x === id ? into.id : x)))]; touched = true; }
      for (const p of f.s.projects || []) for (const se of p.sessions || []) if (se.venue === id) { se.venue = into.id; touched = true; moved += 1; }
      if (touched) f.dirty = true;
    }
    into.aliases = [...new Set([...(into.aliases || []), v.name, ...(v.aliases || [])])].filter((a) => a !== into.name);
    if (v.notes) into.notes = (into.notes ? into.notes + '\n\n' : '') + `Notes from ${v.name}: ${v.notes}`;
    if (!sameAddress(v.address, into.address)) into.notes = (into.notes ? into.notes + '\n\n' : '') + `Also written as: ${v.address}`;
    venues.splice(venues.indexOf(v), 1);
    notes.push(`combined into ${into.name}; ${moved} session${moved === 1 ? '' : 's'} moved; "${v.name}" kept as another name`);
  } else {
    for (const k of ['name', 'address', 'postcode', 'notes']) {
      if (!(k in c) || same(v[k], c[k])) continue;
      if (k === 'name') v.aliases = [...new Set([...(v.aliases || []), v.name])].filter((a) => a !== c.name);
      if (c[k] === null) delete v[k];
      else v[k] = c[k];
      if (k === 'postcode') for (const x of ['ward', 'wardCode', 'lat', 'lng']) delete v[x];
      notes.push(`${k} ${c[k] === null ? 'removed' : 'set'}`);
    }
  }
  if (!notes.length) { venuesSame += 1; continue; }
  venuesDirty = true;
  venueChanged.push({ id, name: v.name, by: e.by, note: e.note, what: notes.join('; ') });
}

// A service's view, with its organisation's overview, as the forms showed it.
const view = (s) => {
  const o = orgByName(s.organisation);
  return o && o.overview ? { ...s, organisationOverview: o.overview } : { ...s };
};
// Writes a service's organisation details (name and overview) to the organisations file, and takes the
// overview off the service itself.
function settleOrg(s, overview, hasOverview) {
  const o = ensureOrg(s.organisation);
  if (o && hasOverview && !same(o.overview, overview)) {
    if (overview) o.overview = overview;
    else delete o.overview;
    orgsDirty = true;
  }
  delete s.organisationOverview;
}

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
  const s = settleVenues({ id, hwlFunded: false, ...a.service }, false);
  const hasOv = 'organisationOverview' in s;
  const ov = s.organisationOverview;
  delete s.organisationOverview;
  for (const k of Object.keys(s)) if (s[k] === null && !REQUIRED.has(k)) delete s[k];
  s.lastUpdated = lastDate;
  s.reviewCycle = s.reviewCycle || 'Quarterly';
  s.provenance = { source: `Added on the All services page by ${a.createdBy || a.by} (${date})`, evidence: a.note };
  if (a.checkedUrl) s.provenance.checkedUrl = a.checkedUrl;
  s.listing = { decision: 'review', reason: `New service added by ${a.createdBy || a.by}, waiting for the team to review it.` };
  // Keep the field order the same as the other files.
  const order = [...Object.keys(schema.properties)];
  const ordered = Object.fromEntries(order.filter((k) => k in s).map((k) => [k, s[k]]));
  Object.assign(ordered, settleVenues(ordered, true));
  if (!validate(ordered)) {
    newProblems.push({ id, name: s.name, by: a.by, why: "it wouldn't pass the data check: " + validate.errors.map((x) => `${x.instancePath || '(top)'} ${x.message}`).slice(0, 3).join('; ') });
    continue;
  }
  settleOrg(ordered, ov, hasOv);
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
  const cur = view(f.s);
  // Written-out venues matched to ones already there, so an edit applied before reads as the same.
  const want = settleVenues(e.changes, false);
  const keys = Object.keys(e.changes);
  const date0 = String(e.t || '').slice(0, 10);
  // No changes, only "checked and still right" (for example a provider said it's all correct): applied by moving
  // the last-checked date on, unless the data has been checked since.
  if (!keys.length ? !e.checked || String(cur.lastUpdated || '') >= date0 : keys.every((k) => same(cur[k], want[k]))) {
    editsSame += 1;
    continue;
  }
  // Someone changed the same field in the data since this edit was made: don't overwrite their change.
  const clash = keys.filter((k) => e.before && k in e.before && !same(cur[k], e.before[k]) && !same(cur[k], want[k]));
  if (clash.length) {
    conflicts.push({ id, name: cur.name, by: e.by, fields: clash });
    continue;
  }
  const next = structuredClone(cur);
  const made = settleVenues(e.changes, true);
  for (const k of keys) {
    const v = made[k];
    if (v === null && !REQUIRED.has(k)) delete next[k];
    else next[k] = v;
  }
  const hasOv = 'organisationOverview' in e.changes;
  const ov = next.organisationOverview;
  delete next.organisationOverview;
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
  const changes = keys.filter((k) => !same(cur[k], k === 'organisationOverview' ? ov : next[k])).map((k) => `${k}: ${cut(show(cur[k]))} → ${cut(show(k === 'organisationOverview' ? ov : next[k]))}`);
  settleOrg(next, ov, hasOv);
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
    reason: (d.note || '').trim() || (d.decision === 'include' ? 'Included by the development team.' : 'Decided by the development team.'),
    by: String(d.by || 'Development team').trim(),
    date,
  };
  f.dirty = true;
  changed.push({ id, name: s.name, from: before.decision, to: d.decision, by: s.listing.by, date, reason: s.listing.reason });
}

if (!dryRun) {
  for (const f of files.values()) if (f && f.dirty) fs.writeFileSync(f.file, JSON.stringify(f.s, null, 2) + '\n');
  if (orgFile && orgsDirty) fs.writeFileSync(orgPath, JSON.stringify(orgFile, null, 2) + '\n');
  if (venueFile && venuesDirty) fs.writeFileSync(venuePath, JSON.stringify(venueFile, null, 2) + '\n');
}

// ---------- summary ----------
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const out = [`# Development team changes${dryRun ? ' (dry run: nothing changed)' : ''}`, ''];
if (orgChanged.length || orgProblems.length || orgsSame) out.push(`${n(orgChanged.length, 'organisation', 'organisations')} changed, ${orgsSame} already up to date.`, '');
if (orgChanged.length) {
  out.push(`## Organisations changed (${orgChanged.length})`, '');
  for (const c of orgChanged) out.push(`- **${c.name}** (\`${c.id}\`): ${c.what}. ${c.by}: ${c.note}`);
  out.push('');
}
if (orgProblems.length) {
  out.push(`## Organisation changes not applied (${orgProblems.length})`, '');
  for (const c of orgProblems) out.push(`- **${c.name || c.id}**, changed by ${c.by}: ${c.why}.`);
  out.push('');
}
if (orgsMade.length) out.push(`New organisations: ${orgsMade.join(', ')}.`, '');
if (venueChanged.length || venueProblems.length || venuesSame) out.push(`${n(venueChanged.length, 'venue', 'venues')} changed, ${venuesSame} already up to date.`, '');
if (venueChanged.length) {
  out.push(`## Venues changed (${venueChanged.length})`, '');
  for (const c of venueChanged) out.push(`- **${c.name}** (\`${c.id}\`): ${c.what}. ${c.by}: ${c.note}`);
  out.push('');
}
if (venueProblems.length) {
  out.push(`## Venue changes not applied (${venueProblems.length})`, '');
  for (const c of venueProblems) out.push(`- **${c.name || c.id}**, changed by ${c.by}: ${c.why}.`);
  out.push('');
}
if (venuesMade.length) out.push(`New venues (their wards are looked up from the postcode next): ${venuesMade.join(', ')}.`, '');
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
