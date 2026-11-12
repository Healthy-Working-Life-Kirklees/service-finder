// Fills in each venue's ward and map position from its postcode, using postcodes.io (free, no key, the Office for
// National Statistics' postcode directory). Only venues missing them are looked up (changing a venue's postcode in
// Admin clears them, so it is looked up again).
//
//   node scripts/lookup-venues.mjs              update data/venues.json
//   node scripts/lookup-venues.mjs --file x     another venues file (used by the tests)
//
// Run by the "Apply team changes" workflow after the team's changes are applied, and on its own by the "Look up
// venue wards" workflow. Postcodes are public reference data: nothing about a person is sent. A postcode that
// can't be found is left as it is and listed, for the team to check. Never fails the run over a lookup problem.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.postcodes.io/postcodes';

// venues: the list from data/venues.json. Changes it in place. Returns { looked, updated, notFound }.
export async function lookupVenues(venues, fetchFn = fetch) {
  const need = venues.filter((v) => v.postcode && (!v.ward || typeof v.lat !== 'number'));
  const postcodes = [...new Set(need.map((v) => v.postcode))];
  const found = new Map();
  for (let i = 0; i < postcodes.length; i += 100) {
    const batch = postcodes.slice(i, i + 100);
    try {
      const res = await fetchFn(API, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'hwl-support-finder' }, body: JSON.stringify({ postcodes: batch }) });
      if (!res.ok) continue;
      const data = await res.json();
      for (const r of data.result || []) if (r && r.result) found.set(r.query.toUpperCase().replace(/\s+/g, ''), r.result);
    } catch {
      // Try again next time.
    }
  }
  let updated = 0;
  const notFound = [];
  for (const v of need) {
    const r = found.get(v.postcode.toUpperCase().replace(/\s+/g, ''));
    if (!r) { notFound.push(`${v.id} (${v.postcode})`); continue; }
    if (r.admin_ward) v.ward = r.admin_ward;
    if (r.codes && r.codes.admin_ward) v.wardCode = r.codes.admin_ward;
    if (typeof r.latitude === 'number' && typeof r.longitude === 'number') {
      v.lat = Math.round(r.latitude * 1e5) / 1e5;
      v.lng = Math.round(r.longitude * 1e5) / 1e5;
    }
    updated += 1;
  }
  return { looked: postcodes.length, updated, notFound };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const i = process.argv.indexOf('--file');
  const file = i > 0 ? path.resolve(process.argv[i + 1]) : path.join(root, 'data', 'venues.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = await lookupVenues(data.venues);
  if (r.updated) fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.log(`Venues: looked up ${r.looked} postcodes, updated ${r.updated}.${r.notFound.length ? ' Not found (check these): ' + r.notFound.join(', ') : ''}`);
}
