// Browser test for the MVP pages. Run by test/run-ui.sh (headless Chromium, mocked Worker, no real API use).
const { chromium } = require('playwright');
const fs = require('node:fs');

const ON = 'http://127.0.0.1:18480';   // build with MVP tools switched on
const OFF = 'http://127.0.0.1:18481';  // build with MVP tools off (the wider-test version)
const PASS = 'test-pass';

let ok = 0, bad = 0;
const check = (name, cond, extra = '') => {
  (cond ? ok++ : bad++);
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '   ' + extra));
};

// ---- in-memory stand-in for the Worker ----
let seq = 0;
let log = [];
const mk = (f, status) => {
  const t = new Date().toISOString();
  const it = { id: ++seq, type: f.type || 'Issue', title: f.title, details: f.details || '', area: f.area || 'Other', priority: f.priority || 'Medium', owner: f.owner || '', status: status || 'Open', created: t, updated: t, updates: [] };
  log.push(it);
  return it;
};

async function worker(route) {
  const req = route.request();
  const url = new URL(req.url());
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-team-passcode', 'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS' };
  const json = (obj, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });

  if (url.pathname === '/chat') {
    const body = JSON.parse(req.postData());
    const last = body.messages[body.messages.length - 1].content;
    if (/crisis/i.test(last)) return json({ message: 'I am sorry you feel like this.', recommendations: [], safety_concern: true });
    return json({ message: 'Here is a match.', recommendations: [{ id: 'my-way-forward', why: 'Fits your age and situation.' }], safety_concern: false });
  }

  if (url.pathname.startsWith('/log/')) {
    if (req.headers()['x-team-passcode'] !== PASS) return json({ error: 'Wrong passcode.' }, 401);
    if (url.pathname === '/log/check') return json({ ok: true });
    if (url.pathname === '/log/items' && req.method() === 'GET') return json({ items: log });
    if (url.pathname === '/log/items' && req.method() === 'POST') return json({ item: mk(JSON.parse(req.postData())) }, 201);
    if (url.pathname === '/log/import') {
      if (log.length) return json({ imported: 0, reason: 'The log already has entries.' });
      const { items } = JSON.parse(req.postData());
      items.forEach((x) => mk(x, x.status));
      return json({ imported: items.length });
    }
    const m = url.pathname.match(/^\/log\/items\/(\d+)$/);
    if (m && req.method() === 'PATCH') {
      const it = log.find((x) => x.id === Number(m[1]));
      const b = JSON.parse(req.postData());
      if (b.status && b.status !== it.status) it.updates.push({ t: new Date().toISOString(), by: b.by || '', text: 'Status changed from ' + it.status + ' to ' + b.status + '.' });
      for (const k of ['status', 'priority', 'owner', 'type', 'area', 'title', 'details']) if (b[k] !== undefined) it[k] = b[k];
      if (b.update) it.updates.push({ t: new Date().toISOString(), by: b.by || '', text: b.update });
      it.updated = new Date().toISOString();
      return json({ item: it });
    }
  }
  return json({ error: 'Not found.' }, 404);
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, acceptDownloads: true });
  await ctx.route('https://mock.workers.dev/**', worker);
  const page = await ctx.newPage();

  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

  // ---------- main page (MVP tools ON) ----------
  await page.goto(ON + '/');
  check('main: team bar shown when MVP tools are on', (await page.locator('.teambar a').allTextContents()).join('|').includes('Help'));
  check('main: team bar links point at /mvp/', (await page.locator('.teambar a').evaluateAll((a) => a.map((x) => x.getAttribute('href')))).join() === 'mvp/help.html,mvp/log.html');
  await page.fill('#message', 'I am 20 and anxious in Dewsbury');
  await page.click('#send');
  await page.waitForSelector('.card');
  check('main: scheme card rendered from the data file', (await page.locator('.card h3').first().textContent()) === 'My Way Forward');
  check('main: overdue warning on the stale entry', (await page.locator('.card .stale').count()) === 1);
  await page.fill('#message', 'crisis');
  await page.click('#send');
  await page.waitForSelector('.crisis');
  check('main: crisis panel shown when flagged', (await page.locator('.crisis').count()) === 1);

  // ---------- help page ----------
  await page.goto(ON + '/mvp/help.html');
  await page.waitForSelector('#data-table tbody tr');
  check('help: data table lists all 17 schemes', (await page.locator('#data-table tbody tr').count()) === 17);
  check('help: overdue entries flagged (>= 4)', (await page.locator('#data-table .pill.warn').count()) >= 4, String(await page.locator('#data-table .pill.warn').count()));
  check('help: not-open scheme flagged', (await page.locator('#data-table .pill.bad').count()) === 1);
  check('help: has the key sections', (await page.locator('h2').allTextContents()).join('|').includes('Reporting a problem'));

  // ---------- log page ----------
  await page.goto(ON + '/mvp/log.html');
  check('log: gate shown first', await page.locator('#gate').isVisible() && !(await page.locator('#app').isVisible()));
  await page.fill('#pass', 'wrong');
  await page.click('#unlock');
  await page.waitForSelector('#gate-msg:not([hidden])');
  check('log: wrong passcode explained', (await page.textContent('#gate-msg')).includes('not right'));
  await page.fill('#pass', PASS);
  await page.click('#unlock');
  await page.waitForSelector('#app:not([hidden])');
  check('log: unlocked, starter offer shown on an empty log', await page.locator('#starter').isVisible());
  await page.click('#load-starter');
  await page.waitForSelector('#list .entry');
  check('log: starter list loaded (15 open shown, 1 done hidden)', (await page.locator('#list .entry').count()) === 15, String(await page.locator('#list .entry').count()));
  check('log: starter offer hides once loaded', !(await page.locator('#starter').isVisible()));
  const stats = await page.locator('#summary .stat').allTextContents();
  check('log: summary shows 4 open high-priority items', stats.some((s) => s.includes('High priority open') && s.startsWith('4')), stats.join(' | '));
  check('log: high priority sorted first', (await page.locator('#list .entry').first().getAttribute('class')).includes('pri-High'));

  await page.selectOption('#flt-status', 'all');
  check('log: "Everything" shows all 16', (await page.locator('#list .entry').count()) === 16);
  await page.selectOption('#flt-status', 'active');
  await page.selectOption('#flt-type', 'Action');
  check('log: type filter works', (await page.locator('#list .entry').count()) > 0 && (await page.locator('#list .entry .pill.blue').allTextContents()).every((t) => t === 'Action'));
  await page.selectOption('#flt-type', '');
  await page.fill('#flt-q', 'overdue');
  check('log: search finds the overdue entry', (await page.locator('#list .entry').count()) === 1);
  await page.fill('#flt-q', '');

  await page.fill('#by', 'TB');
  await page.selectOption('#flt-status', 'all');
  await page.selectOption('#st-2', 'In progress');
  for (let i = 0; i < 50 && (await page.inputValue('#st-2')) !== 'In progress'; i++) await page.waitForTimeout(100);
  check('log: status change saved', (await page.inputValue('#st-2')) === 'In progress');
  await page.click('#list .entry:has(#nt-2) summary');
  await page.fill('#nt-2', 'Emailed the provider');
  await page.click('#list .entry:has(#nt-2) >> text=Add note');
  await page.waitForSelector('#list .entry:has(#nt-2) .notes li >> text=Emailed the provider');
  const noteText = await page.locator('#list .entry:has(#nt-2) .notes').textContent();
  check('log: note added with the initials and a status-change line', noteText.includes('Emailed the provider') && noteText.includes('TB') && noteText.includes('In progress'), noteText);
  check('log: notes stay expanded after saving', await page.locator('#list .entry:has(#nt-2) details').evaluate((d) => d.open));

  await page.fill('#ow-3', 'Sam');
  await page.click('#list .entry:has(#ow-3) >> text=Save owner');
  await page.waitForSelector('#list .entry:has(#ow-3) .meta >> text=owner: Sam');
  check('log: owner saved', true);

  await page.click('#new');
  await page.fill('#f-title', '=HYPERLINK("x") test entry');
  await page.fill('#f-details', 'Typed: made up. Expected: a card. Got: nothing.');
  await page.selectOption('#f-type', 'Issue');
  await page.selectOption('#f-priority', 'High');
  await page.click('#form button[type=submit]');
  await page.waitForSelector('#list .entry:has-text("HYPERLINK")');
  check('log: new entry saved and listed', (await page.locator('#list .entry').count()) === 17);
  check('log: new entry form closes', !(await page.locator('#form').isVisible()));

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  check('log: CSV downloaded with a sensible name', /^service-finder-log-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  check('log: CSV has header and 17 rows', csv.includes('"ID","Type","Title"') && csv.trim().split(/\r?\n/).length >= 18);
  check('log: CSV neutralises a leading "=" (formula injection)', csv.includes("\"'=HYPERLINK"), csv.slice(0, 200));

  await page.reload();
  await page.waitForSelector('#app:not([hidden])');
  check('log: stays unlocked on reload (this tab only)', await page.locator('#list .entry').count() > 0);
  // suggested entries: offered, added in one go, note appended to #12, not offered again
  await page.waitForSelector('#suggested:not([hidden])');
  check('log: suggested entries are offered', (await page.textContent('#suggested')).includes('Data freshness') && (await page.textContent('#suggested')).includes('12 new entries'), await page.textContent('#suggested'));
  await page.selectOption('#flt-status', 'all');
  const before = await page.locator('#list .entry').count();
  await page.click('#suggested button');
  await page.locator('#suggested').waitFor({ state: 'hidden' });
  for (let i = 0; i < 50 && (await page.locator('#list .entry').count()) !== before + 12; i++) await page.waitForTimeout(200);
  check('log: 12 suggested entries added', (await page.locator('#list .entry').count()) === before + 12);
  check('log: freshness entries have their details', (await page.locator('#list .entry', { hasText: 'option B: AI-assisted' }).locator('.details').textContent()).includes('15p to 35p'));
  check('log: note appended to the existing "keep the data fresh" entry', (await page.locator('#list .entry', { hasText: 'Keep the data fresh automatically' }).locator('summary').textContent()).includes('(1)'));
  await page.reload();
  await page.waitForSelector('#list .entry');
  check('log: suggestions are not offered twice', !(await page.locator('#suggested').isVisible()));

  await page.click('#lock');
  check('log: lock returns to the gate', await page.locator('#gate').isVisible());
  await page.reload();
  check('log: still locked after reload', await page.locator('#gate').isVisible() && !(await page.locator('#app').isVisible()));

  // ---------- phone-width layout ----------
  await page.setViewportSize({ width: 375, height: 800 });
  for (const [name, path] of [['main', '/'], ['help', '/mvp/help.html'], ['log (gate)', '/mvp/log.html']]) {
    await page.goto(ON + path);
    await page.waitForTimeout(300);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('phone width: no sideways scrolling on ' + name, over <= 1, 'overflow ' + over + 'px');
  }
  await page.fill('#pass', PASS);
  await page.click('#unlock');
  await page.waitForSelector('#list .entry');
  const overLog = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('phone width: no sideways scrolling on the open log', overLog <= 1, 'overflow ' + overLog + 'px');

  // ---------- the wider-test build (MVP tools OFF) ----------
  const off = await ctx.newPage();
  await off.goto(OFF + '/');
  check('off: no team bar on the main page', (await off.locator('.teambar').count()) === 0);
  const r1 = await off.goto(OFF + '/mvp/help.html');
  const r2 = await off.goto(OFF + '/mvp/log.html');
  const r3 = await off.goto(OFF + '/mvp/seed-log.json');
  check('off: help, log and starter list are not published (404)', r1.status() === 404 && r2.status() === 404 && r3.status() === 404, [r1.status(), r2.status(), r3.status()].join());
  const cfg = await (await off.goto(OFF + '/config.js')).text();
  check('off: config says mvpTools false', cfg.includes('"mvpTools":false'), cfg);

  check('no console errors or CSP violations anywhere', problems.filter((p) => !/status of (401|404)/.test(p)).length === 0, problems.join(' || '));
  await browser.close();
  console.log(`passed=${ok} failed=${bad}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED:', e); process.exit(2); });
