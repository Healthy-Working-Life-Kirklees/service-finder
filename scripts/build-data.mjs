// Combines data/meta.json and every data/services/<id>.json into data/services.json, the single file the
// page, the Worker and the tests read. Run it before deploying, testing or running the Worker locally:
//
//   node scripts/build-data.mjs
//
// data/services.json is generated, so it is not kept in the repository. Edit the per-scheme files instead.
// No dependencies, so it runs anywhere Node does. scripts/check-data.mjs does the detailed checking.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data', 'services');
const out = path.join(root, 'data', 'services.json');

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

fs.writeFileSync(out, JSON.stringify({ ...meta, count: services.length, services }, null, 2) + '\n');
console.log(`Built data/services.json from ${services.length} scheme files.`);
