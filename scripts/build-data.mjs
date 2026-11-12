// Combines data/meta.json and every data/services/<id>.json into two files:
//
//   data/services.json      the live list: only services whose "listing" decision is "include". The page, the
//                           Worker (and so the AI) and the tests read this one.
//   data/services-all.json  every service, whatever its decision, for the All services page in Admin.
//
// Each service names its organisation; the organisation's own details (its overview) are kept once, in
// data/organisations.json, and copied into each service here as "organisationOverview", so the page, the AI and
// the directory read one service at a time. Both files also list every organisation ("organisations"), for the
// type-ahead on the forms, and the venues (data/venues.json) the services use ("venues": the live list's only in
// services.json, every venue in services-all.json), so sessions can be shown with their address, ward and map.
//
// Run it before deploying, testing or running the Worker locally:
//
//   node scripts/build-data.mjs
//
// Both files are generated, so they are not kept in the repository. Edit the per-scheme files instead.
// No dependencies, so it runs anywhere Node does. scripts/check-data.mjs does the detailed checking.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data', 'services');
const out = path.join(root, 'data', 'services.json');
const outAll = path.join(root, 'data', 'services-all.json');

const meta = JSON.parse(fs.readFileSync(path.join(root, 'data', 'meta.json'), 'utf8'));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
if (!files.length) throw new Error('No scheme files found in data/services/.');

const services = files.map((f) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  } catch (e) {
    console.error(`data/services/${f} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
});

// Order by id, so the combined file (and the list the AI sees) only changes when the data does.
services.sort((a, b) => String(a.id).localeCompare(String(b.id)));

// Organisations: one record each. The overview is copied into each of its services.
const orgs = JSON.parse(fs.readFileSync(path.join(root, 'data', 'organisations.json'), 'utf8')).organisations;
const orgByName = new Map(orgs.map((o) => [o.name, o]));
for (const s of services) {
  const o = orgByName.get(s.organisation);
  if (o && o.overview) s.organisationOverview = o.overview;
}
const orgList = orgs.map((o) => ({ id: o.id, name: o.name, ...(o.aliases ? { aliases: o.aliases } : {}) }));

// Venues: one record per place. The team's notes stay out of the live file.
const venues = JSON.parse(fs.readFileSync(path.join(root, 'data', 'venues.json'), 'utf8')).venues;
const venueIdsOf = (s) => [...(s.venues || []), ...(s.projects || []).flatMap((p) => (p.sessions || []).map((x) => x.venue).filter(Boolean))];

const live = services.filter((s) => s.listing && s.listing.decision === 'include');
const liveVenueIds = new Set(live.flatMap(venueIdsOf));
const liveVenues = venues.filter((v) => liveVenueIds.has(v.id)).map(({ notes, ...v }) => v);
fs.writeFileSync(out, JSON.stringify({ ...meta, count: live.length, organisations: orgList, venues: liveVenues, services: live }, null, 2) + '\n');
// The All services page's edit form offers the same choices the schema allows.
const schema = JSON.parse(fs.readFileSync(path.join(root, 'data', 'schema.json'), 'utf8'));
const P = schema.properties;
const choices = {
  level: P.level.enum, reviewCycle: P.reviewCycle.enum, audience: P.audience.items.enum, categories: P.categories.items.enum,
  areas: P.areas.items.enum, healthFocus: P.healthFocus.items.enum, selfReferral: P.selfReferral.properties.allowed.enum, groups: P.groups.items.enum,
};
fs.writeFileSync(outAll, JSON.stringify({ ...meta, count: services.length, choices, organisations: orgs, venues, services }, null, 2) + '\n');
console.log(`Built data/services.json (${live.length} on the live list) and data/services-all.json (all ${services.length}).`);
