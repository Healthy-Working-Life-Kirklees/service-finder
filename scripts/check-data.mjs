// Checks every scheme file in data/services/ before it can be deployed:
//
//   npm run check-data
//
// 1. Each file matches data/schema.json (required fields, allowed values, date and web address formats).
// 2. Rules a schema can't express: the file name matches the id, logos exist, requiresMention patterns
//    are valid, dates aren't in the future, and a service on the live list ("listing": include) has no
//    "To be completed" placeholders left in it. Project and cohort ids are unique within a service, and
//    their dates are in order.
// 3. data/organisations.json: one record per organisation, and every service's organisation is in it.
// It also reports (without failing) entries overdue for a check, organisations with no services, and text
// longer than the forms' character limits (kept as it is, for the partner to shorten when they check it).
//
// Exits with an error if anything fails, which stops the deploy or marks the pull request as failing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import '../site/listing-logic.js';

const { LIMITS, checkParts } = globalThis.LISTING;

const PLACEHOLDER = 'To be completed';
const STALE_DAYS = 135; // the same threshold the page uses for its "may be out of date" warning
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data', 'services');
const logos = path.join(root, 'site', 'img', 'logos');

const schema = JSON.parse(fs.readFileSync(path.join(root, 'data', 'schema.json'), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

const errors = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);

// Top-level details.
const metaFile = 'data/meta.json';
let meta;
try {
  meta = JSON.parse(fs.readFileSync(path.join(root, metaFile), 'utf8'));
} catch (e) {
  fail(metaFile, `can't be read as JSON (${e.message})`);
}
if (meta) {
  for (const k of ['source', 'converted', 'notes']) if (typeof meta[k] !== 'string' || !meta[k].trim()) fail(metaFile, `"${k}" is missing`);
  for (const k of Object.keys(meta)) if (!['source', 'converted', 'notes'].includes(k)) fail(metaFile, `unexpected field "${k}"`);
}

// Organisations.
const orgFile = 'data/organisations.json';
const orgNames = new Map(); // name -> id
const orgUsed = new Set();
const overLimit = [];
try {
  const o = JSON.parse(fs.readFileSync(path.join(root, orgFile), 'utf8'));
  if (!o || !Array.isArray(o.organisations)) fail(orgFile, 'must be { "organisations": [...] }');
  const ids = new Set();
  for (const [i, x] of (o.organisations || []).entries()) {
    const where = `${orgFile} organisations[${i}]`;
    if (!x || typeof x !== 'object') { fail(where, 'is not an object'); continue; }
    for (const k of Object.keys(x)) if (!['id', 'name', 'overview', 'website', 'aliases', 'notes'].includes(k)) fail(where, `unexpected field "${k}"`);
    if (typeof x.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(x.id) || x.id.length > 50) fail(where, 'needs an id of lower-case letters, numbers and hyphens');
    if (typeof x.name !== 'string' || !x.name.trim()) fail(where, 'needs a name');
    for (const k of ['overview', 'website', 'notes']) if (k in x && (typeof x[k] !== 'string' || !x[k].trim())) fail(where, `"${k}" must be text (leave it out if there is none)`);
    if ('website' in x && !/^https?:\/\/\S+$/.test(x.website)) fail(where, 'website must start with http:// or https://');
    if ('aliases' in x && (!Array.isArray(x.aliases) || x.aliases.some((a) => typeof a !== 'string' || !a.trim()))) fail(where, 'aliases must be a list of names');
    if (ids.has(x.id)) fail(where, `id "${x.id}" is used twice`);
    if (orgNames.has(x.name)) fail(where, `"${x.name}" is listed twice`);
    ids.add(x.id);
    orgNames.set(x.name, x.id);
    if (x.overview && x.overview.length > LIMITS.orgOverview) overLimit.push(`organisation ${x.id}: overview ${x.overview.length} characters (limit ${LIMITS.orgOverview})`);
  }
} catch (e) {
  fail(orgFile, `can't be read as JSON (${e.message})`);
}

const today = new Date().toISOString().slice(0, 10);
const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
const overdue = [];
const decisions = { include: 0, review: 0, exclude: 0 };
const names = new Map();

for (const f of files.sort()) {
  const rel = `data/services/${f}`;
  if (!f.endsWith('.json')) {
    fail(rel, 'only .json files belong in data/services/');
    continue;
  }
  let s;
  try {
    s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  } catch (e) {
    fail(rel, `isn't valid JSON (${e.message})`);
    continue;
  }
  if (!validate(s)) {
    for (const e of validate.errors) fail(rel, `${e.instancePath || '(top level)'} ${e.message}${e.params && e.params.allowedValues ? ': ' + e.params.allowedValues.join(', ') : ''}${e.params && e.params.additionalProperty ? ': "' + e.params.additionalProperty + '"' : ''}`);
    continue;
  }
  if (f !== `${s.id}.json`) fail(rel, `the file name must be the id: ${s.id}.json`);
  if (s.logo && !fs.existsSync(path.join(logos, s.logo))) fail(rel, `logo "${s.logo}" isn't in site/img/logos/`);
  if (s.requiresMention) {
    try {
      new RegExp(s.requiresMention.join('|'), 'iu');
    } catch (e) {
      fail(rel, `requiresMention isn't a valid pattern (${e.message})`);
    }
  }
  if (s.lastUpdated > today) fail(rel, `lastUpdated (${s.lastUpdated}) is in the future`);
  if (Number.isNaN(Date.parse(s.lastUpdated))) fail(rel, `lastUpdated (${s.lastUpdated}) isn't a real date`);
  if (s.listing.date && s.listing.date > today) fail(rel, `listing.date (${s.listing.date}) is in the future`);
  // Services added only for review carry "To be completed" where the research found nothing. They can't go live
  // until a person fills those in.
  if (s.listing.decision === 'include' && JSON.stringify(s).includes(PLACEHOLDER)) {
    fail(rel, `is on the live list ("listing": include) but still says "${PLACEHOLDER}". Fill in the details first, or set the decision to review.`);
  }
  if (orgNames.size && !orgNames.has(s.organisation)) fail(rel, `organisation "${s.organisation}" isn't in data/organisations.json (add it there, or use the name exactly as it is there)`);
  orgUsed.add(s.organisation);
  for (const p of checkParts(s.projects)) fail(rel, p);
  if (s.whoFor.length > LIMITS.whoFor) overLimit.push(`${s.id}: who it's for ${s.whoFor.length} characters (limit ${LIMITS.whoFor})`);
  for (const p of s.projects) if (p.overview.length > LIMITS.projectOverview) overLimit.push(`${s.id}: "${p.name}" overview ${p.overview.length} characters (limit ${LIMITS.projectOverview})`);
  if (s.coachNotes && s.coachNotes.length > LIMITS.coachNotes) overLimit.push(`${s.id}: anything coaches should know ${s.coachNotes.length} characters (limit ${LIMITS.coachNotes})`);
  decisions[s.listing.decision] += 1;
  const key = (s.name + ' | ' + s.organisation).toLowerCase();
  if (names.has(key)) fail(rel, `same name and organisation as ${names.get(key)}`);
  names.set(key, rel);
  if (s.open && s.listing.decision === 'include' && (Date.now() - Date.parse(s.lastUpdated)) / 86400000 > STALE_DAYS) overdue.push(`${s.id} (${s.lastUpdated})`);
}

if (!files.length) fail('data/services/', 'no scheme files found');

const unused = [...orgNames.keys()].filter((n) => !orgUsed.has(n));
if (unused.length) console.log(`Note: ${unused.length} organisations have no services: ${unused.join(', ')}`);
if (overLimit.length) console.log(`Note: ${overLimit.length} texts are longer than the forms allow (kept as they are; shorten them when next checked):\n  ${overLimit.join('\n  ')}`);
if (overdue.length) console.log(`Note: ${overdue.length} open entries on the live list are overdue for a check: ${overdue.join(', ')}`);
if (errors.length) {
  console.error(`\n${errors.length} problem${errors.length === 1 ? '' : 's'} in the scheme data:\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log(`Checked ${files.length} scheme files: all fine. On the live list: ${decisions.include}. Waiting for review: ${decisions.review}. Excluded: ${decisions.exclude}.`);
