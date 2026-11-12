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
//
// Retired postcodes: Royal Mail sometimes retires a postcode that places carry on using (15 Lord Street,
// Huddersfield, still gives HD1 1QB, retired in 2014). postcodes.io keeps where those were, so the map position
// comes from that, and the ward from the nearest current postcode to it. They're listed in the output too.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://api.postcodes.io';
const API = BASE + '/postcodes';
const HEADERS = { 'user-agent': 'hwl-support-finder' };
const squash = (pc) => pc.toUpperCase().replace(/\s+/g, '');

// A retired postcode: where it was (postcodes.io keeps that), with the ward of the nearest current postcode.
// Returns null if it isn't a retired postcode either, or the lookup fails.
async function retired(pc, fetchFn) {
  try {
    const t = await fetchFn(BASE + '/terminated_postcodes/' + encodeURIComponent(squash(pc)), { headers: HEADERS });
    if (!t.ok) return null;
    const { result } = await t.json();
    if (!result || typeof result.latitude !== 'number' || typeof result.longitude !== 'number') return null;
    const out = { latitude: result.latitude, longitude: result.longitude, retired: true };
    const n = await fetchFn(`${API}?lon=${result.longitude}&lat=${result.latitude}&limit=1&radius=500`, { headers: HEADERS });
    if (n.ok) {
      const near = ((await n.json()).result || [])[0];
      if (near) Object.assign(out, { admin_ward: near.admin_ward, codes: near.codes });
    }
    return out;
  } catch {
    return null;
  }
}

// venues: the list from data/venues.json. Changes it in place. Returns { looked, updated, notFound, retired }.
export async function lookupVenues(venues, fetchFn = fetch) {
  const need = venues.filter((v) => v.postcode && (!v.ward || typeof v.lat !== 'number'));
  const postcodes = [...new Set(need.map((v) => v.postcode))];
  const found = new Map();
  for (let i = 0; i < postcodes.length; i += 100) {
    const batch = postcodes.slice(i, i + 100);
    try {
      const res = await fetchFn(API, { method: 'POST', headers: { 'content-type': 'application/json', ...HEADERS }, body: JSON.stringify({ postcodes: batch }) });
      if (!res.ok) continue;
      const data = await res.json();
      for (const r of data.result || []) if (r && r.result) found.set(squash(r.query), r.result);
    } catch {
      // Try again next time.
    }
  }
  // Not found among current postcodes: it may be a retired one that's still in use.
  for (const pc of postcodes) {
    if (found.has(squash(pc))) continue;
    const r = await retired(pc, fetchFn);
    if (r) found.set(squash(pc), r);
  }
  let updated = 0;
  const notFound = [];
  const old = [];
  for (const v of need) {
    const r = found.get(squash(v.postcode));
    if (!r) { notFound.push(`${v.id} (${v.postcode})`); continue; }
    if (r.retired) old.push(`${v.id} (${v.postcode})`);
    if (r.admin_ward) v.ward = r.admin_ward;
    if (r.codes && r.codes.admin_ward) v.wardCode = r.codes.admin_ward;
    if (typeof r.latitude === 'number' && typeof r.longitude === 'number') {
      v.lat = Math.round(r.latitude * 1e5) / 1e5;
      v.lng = Math.round(r.longitude * 1e5) / 1e5;
    }
    updated += 1;
  }
  return { looked: postcodes.length, updated, notFound, retired: old };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const i = process.argv.indexOf('--file');
  const file = i > 0 ? path.resolve(process.argv[i + 1]) : path.join(root, 'data', 'venues.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = await lookupVenues(data.venues);
  if (r.updated) fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.log(`Venues: looked up ${r.looked} postcodes, updated ${r.updated}.${r.retired.length ? ' Retired postcodes still in use (placed where the postcode was, ward from the nearest current postcode): ' + r.retired.join(', ') + '.' : ''}${r.notFound.length ? ' Not found (check these): ' + r.notFound.join(', ') : ''}`);
}
