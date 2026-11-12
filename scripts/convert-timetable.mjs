// One-off conversion (November 2026): venues and sessions, ready for the Kirklees-wide timetable.
// Kept in the repository as a record of exactly what was done; it isn't run by any workflow.
//
//   node scripts/convert-timetable.mjs            convert data/services/*.json in place and write data/venues.json
//   node scripts/convert-timetable.mjs --check    only report what it would do
//
// What it does, for every listing:
//   - A project's "cohorts" become its "sessions" (same details: a session for a group of its own).
//   - Each place written with a postcode becomes a venue in data/venues.json (one per place: the same name and
//     postcode is one venue), and the project gets a session at that venue. Anything written after the postcode,
//     such as "(Fri 10.30–2.30)", is kept word for word as that session's note, for the service to turn into days
//     and times when it checks its listing. Nothing is guessed: no days or times are worked out from the text.
//   - Raise Your Game-style projects (sessions for groups, and one place): the place goes on each session.
//   - Places used by every project (the service's "locations") with a postcode and nothing after it become the
//     service's "venues". Places without a postcode ("Online", "Community venues across Kirklees") stay as written.
//   - Nothing else changes. "Who it's for" groups are not filled in here: partners tick them on the form.
//
// Then it checks no text was lost: every piece of text in each old listing must still be in the new listing or its
// venues.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data', 'services');
const venueFile = path.join(root, 'data', 'venues.json');
const checkOnly = process.argv.includes('--check');

const slug = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
const PC = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

// "Brian Jackson House, 2 New North Parade, Huddersfield, HD1 5JP (elevate connect, Wednesdays 1-3.30pm)"
//   -> { address: "Brian Jackson House, 2 New North Parade, Huddersfield, HD1 5JP", name: "Brian Jackson House",
//        postcode: "HD1 5JP", note: "elevate connect, Wednesdays 1-3.30pm" }
export function parsePlace(line) {
  const m = line.match(PC);
  if (!m) return null;
  const end = m.index + m[0].length;
  const address = line.slice(0, end).trim().replace(/[,\s]+$/, '');
  let rest = line.slice(end).trim();
  rest = rest.replace(/^[-–—:,]\s*/, '');
  if (/^\(.*\)$/.test(rest)) rest = rest.slice(1, -1).trim();
  const before = line.slice(0, m.index).trim().replace(/[,\s]+$/, '');
  // The name: the first part before a comma, skipping a "Town:" label, a floor or unit, and a bracket.
  const segs = before.replace(/^[A-Z][A-Za-z' ]+:\s+/, '').split(',').map((x) => x.trim()).filter(Boolean);
  let name = segs.find((x) => !/^(\d+(st|nd|rd|th)? floor|floor|unit|suite|room)\b/i.test(x)) || segs[0] || '';
  if (name.includes('(')) name = name.slice(name.indexOf('(') + 1).trim() || name.slice(0, name.indexOf('(')).trim();
  if (!name) name = address;
  return { name, address, postcode: (m[1] + ' ' + m[2]).toUpperCase(), note: rest };
}

const venues = fs.existsSync(venueFile) ? JSON.parse(fs.readFileSync(venueFile, 'utf8')).venues : [];
const byKey = new Map(venues.map((v) => [v.address.toLowerCase(), v]));
const usedIds = new Set(venues.map((v) => v.id));
// One venue per address as written: two ways of writing one place are two venues, listed for the team to combine.
function venueFor(p) {
  const key = p.address.toLowerCase();
  if (byKey.has(key)) return byKey.get(key);
  let id = slug(p.name) || 'venue';
  for (let n = 2; usedIds.has(id); n++) id = slug(p.name).slice(0, 46) + '-' + n;
  usedIds.add(id);
  const v = { id, name: p.name, address: p.address, postcode: p.postcode };
  byKey.set(key, v);
  venues.push(v);
  return v;
}

function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

const ORDER = ['id', 'name', 'organisation', 'logo', 'mapLinks', 'open', 'hwlFunded', 'level', 'audience', 'categories', 'groups', 'whoFor', 'age', 'webpage', 'email', 'phone', 'social',
  'locations', 'venues', 'areas', 'eligibility', 'exclusions', 'gate', 'healthFocus', 'requiresMention', 'referralRoutes', 'referralLink', 'selfReferral', 'projects', 'workExperience', 'cost', 'languages',
  'coachNotes', 'notes', 'lastUpdated', 'reviewCycle', 'provenance', 'listing'];
const P_ORDER = ['id', 'name', 'overview', 'runs', 'area', 'where', 'when', 'duration', 'places', 'age', 'audience', 'eligibility', 'gate', 'runsFrom', 'runsTo', 'referralsFrom', 'referralsUntil', 'sessions'];
const S_ORDER = ['id', 'name', 'venue', 'where', 'days', 'start', 'end', 'frequency', 'note', 'when', 'age', 'eligibility', 'gate', 'places', 'runsFrom', 'runsTo', 'referralsFrom', 'referralsUntil'];
const ordered = (o, keys) => Object.fromEntries([...keys.filter((k) => k in o), ...Object.keys(o).filter((k) => !keys.includes(k))].map((k) => [k, o[k]]));

const report = { converted: 0, sessions: 0, lost: [] };
function convert(old) {
  const s = structuredClone(old);
  const ids = new Set();
  const take = (base) => {
    let id = slug(base) || 'session';
    for (let n = 2; ids.has(id); n++) id = slug(base).slice(0, 46) + '-' + n;
    ids.add(id);
    return id;
  };
  for (const p of s.projects) ids.add(p.id);
  for (const p of s.projects) for (const c of p.cohorts || []) ids.add(c.id);

  s.projects = s.projects.map((p) => {
    const sessions = (p.cohorts || []).map((c) => {
      const out = { ...c };
      const where = [];
      for (const line of c.where || []) {
        const pl = parsePlace(line);
        if (pl && !out.venue && !pl.note) out.venue = venueFor(pl).id;
        else where.push(line);
      }
      delete out.where;
      if (where.length) out.where = where;
      return out;
    });
    delete p.cohorts;
    const keep = [];
    const placeLines = (p.where || []).map((l) => [l, parsePlace(l)]);
    const venueLines = placeLines.filter(([, pl]) => pl);
    // Sessions for groups and one place with nothing after it: the place goes on each session.
    if (sessions.length && venueLines.length === 1 && !venueLines[0][1].note && sessions.every((x) => !x.venue)) {
      const v = venueFor(venueLines[0][1]);
      for (const x of sessions) x.venue = v.id;
      for (const [l, pl] of placeLines) if (!pl) keep.push(l);
    } else {
      for (const [l, pl] of placeLines) {
        if (!pl) { keep.push(l); continue; }
        const v = venueFor(pl);
        const sn = { id: take(v.name), venue: v.id };
        if (pl.note) sn.note = pl.note;
        sessions.push(sn);
      }
    }
    if (keep.length) p.where = keep;
    else delete p.where;
    if (sessions.length) p.sessions = sessions.map((x) => ordered(x, S_ORDER));
    report.sessions += sessions.length;
    return ordered(p, P_ORDER);
  });
  // Places used by every project.
  const locs = [];
  const vids = [];
  for (const l of s.locations || []) {
    const pl = parsePlace(l);
    if (pl && !pl.note) vids.push(venueFor(pl).id);
    else locs.push(l);
  }
  s.locations = locs;
  if (vids.length) s.venues = [...new Set(vids)];
  return ordered(s, ORDER);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
for (const f of files) {
  const old = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (old.projects.some((p) => p.sessions) || (old.venues && !old.projects.some((p) => p.cohorts || p.where))) continue; // already converted
  const s = convert(old);
  // No text lost: every old string is in the new listing, or is a place line rebuilt from its venue and note.
  const vmap = new Map(venues.map((v) => [v.id, v]));
  const after = JSON.stringify(s) + JSON.stringify(venues);
  const rebuilt = new Set();
  for (const p of s.projects) for (const x of p.sessions || []) if (x.venue) {
    const v = vmap.get(x.venue);
    rebuilt.add(v.address);
    if (x.note) rebuilt.add(v.address + '|' + x.note);
  }
  for (const v of s.venues || []) rebuilt.add(vmap.get(v).address);
  for (const t of strings(old)) {
    if (after.includes(JSON.stringify(t).slice(1, -1))) continue;
    const pl = parsePlace(t);
    if (pl && (rebuilt.has(pl.address + '|' + pl.note) || (!pl.note && rebuilt.has(pl.address)))) continue;
    report.lost.push(`${old.id}: "${t}"`);
  }
  if (!checkOnly) fs.writeFileSync(path.join(dir, f), JSON.stringify(s, null, 2) + '\n');
  report.converted += 1;
}
venues.sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
if (!checkOnly) fs.writeFileSync(venueFile, JSON.stringify({ venues }, null, 2) + '\n');

// Places that may be the same venue: the same postcode under different names. Listed for the team; never merged.
const byPc = new Map();
for (const v of venues) byPc.set(v.postcode, [...(byPc.get(v.postcode) || []), v.name]);
const maybeSame = [...byPc].filter(([, n]) => n.length > 1).map(([pc, n]) => `${pc}: ${n.join('  |  ')}`);

console.log(`Converted ${report.converted} listings${checkOnly ? ' (check only: nothing written)' : ''}. ${venues.length} venues, ${report.sessions} sessions.`);
console.log(`Text lost: ${report.lost.length}${report.lost.length ? '\n  ' + report.lost.join('\n  ') : ''}`);
console.log(`Venues sharing a postcode (${maybeSame.length}), for the team to check and combine in Admin:${maybeSame.length ? '\n  ' + maybeSame.join('\n  ') : ''}`);
if (report.lost.length) process.exitCode = 1;
