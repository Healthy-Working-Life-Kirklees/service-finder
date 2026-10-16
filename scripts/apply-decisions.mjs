// Writes the MVP team's listing decisions (include, review or exclude, made on the All services page) into
// the scheme files, so they can go into a pull request. Nothing reaches the live site until that pull request
// is merged: the live list is built from the "listing" field in data/services/<id>.json.
//
//   WORKER_URL=https://hwl-service-finder.<subdomain>.workers.dev TEAM_PASSCODE='...' npm run apply-decisions
//   npm run apply-decisions -- --input decisions.json     (a file saved from the All services page)
//   add --dry-run to see what would change without changing anything
//
// It prints a Markdown summary of what changed, ready to paste into the pull request.
// A service still marked "To be completed" is never put on the live list: it is reported instead, so a person
// can fill in its details first (npm run check-data would fail otherwise).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = 'To be completed';
const DECISIONS = ['include', 'review', 'exclude'];
const WORD = { include: 'Include on the live list', review: 'Needs further review', exclude: 'Exclude completely' };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes('--dry-run');
const dir = path.resolve(opt('--dir') || path.join(root, 'data', 'services'));
const input = opt('--input');

async function loadDecisions() {
  if (input) return JSON.parse(fs.readFileSync(input, 'utf8')).decisions || {};
  const url = String(process.env.WORKER_URL || '').replace(/\/$/, '');
  const pass = process.env.TEAM_PASSCODE || '';
  if (!url || !pass) {
    console.error('Give --input <file>, or set WORKER_URL and TEAM_PASSCODE.');
    process.exit(2);
  }
  const res = await fetch(url + '/log/decisions', { headers: { 'x-team-passcode': pass } });
  if (!res.ok) {
    console.error(`The Worker said ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  return (await res.json()).decisions || {};
}

const decisions = await loadDecisions();
const changed = [];
const blocked = [];
const unknown = [];
let same = 0;

for (const [id, d] of Object.entries(decisions).sort(([a], [b]) => a.localeCompare(b))) {
  if (!d || !DECISIONS.includes(d.decision)) continue;
  const file = path.join(dir, id + '.json');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || !fs.existsSync(file)) {
    unknown.push(id);
    continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  const s = JSON.parse(text);
  const date = String(d.t || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const before = s.listing || {};
  // Already applied: same decision, recorded on the same day by the same person.
  if (before.decision === d.decision && before.date === date && before.by === d.by) {
    same += 1;
    continue;
  }
  if (d.decision === 'include' && text.includes(PLACEHOLDER)) {
    blocked.push({ id, name: s.name, by: d.by });
    continue;
  }
  s.listing = {
    decision: d.decision,
    reason: (d.note || '').trim() || (d.decision === 'include' ? 'Included by the MVP team.' : 'Decided by the MVP team.'),
    by: String(d.by || 'MVP team').trim(),
    date,
  };
  if (!dryRun) fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  changed.push({ id, name: s.name, from: before.decision, to: d.decision, by: s.listing.by, date, reason: s.listing.reason });
}

const out = [];
out.push(`# MVP team listing decisions${dryRun ? ' (dry run: nothing changed)' : ''}`, '');
out.push(`${changed.length} service${changed.length === 1 ? '' : 's'} updated, ${same} already up to date.`, '');
for (const to of DECISIONS) {
  const rows = changed.filter((c) => c.to === to);
  if (!rows.length) continue;
  out.push(`## ${WORD[to]} (${rows.length})`, '');
  for (const c of rows) out.push(`- **${c.name}** (\`data/services/${c.id}.json\`)${c.from && c.from !== c.to ? `, was ${c.from}` : ''}. ${c.by}, ${c.date}: ${c.reason}`);
  out.push('');
}
if (blocked.length) {
  out.push(`## Not applied: details still to be completed (${blocked.length})`, '');
  out.push(`The team chose to include these, but their files still say "${PLACEHOLDER}". Fill in the details, then run this again.`, '');
  for (const b of blocked) out.push(`- **${b.name}** (\`data/services/${b.id}.json\`), chosen by ${b.by}`);
  out.push('');
}
if (unknown.length) out.push(`Decisions for services that aren't in the data (renamed or removed?): ${unknown.join(', ')}`, '');
console.log(out.join('\n'));
