// Browser test for the main page and the Admin pages. Run by test/run-ui.sh (headless Chromium, mocked Worker, no real API use).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const CSS_ID = (t) => t.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
const DATA = require(path.join(__dirname, '..', 'data', 'services.json')).services; // the live list
const ALL = require(path.join(__dirname, '..', 'data', 'services-all.json')).services; // every service

const ON = 'http://127.0.0.1:18480';   // the site as the Pages workflow builds it
const PASS = 'test-pass';

let ok = 0, bad = 0;
const check = (name, cond, extra = '') => {
  (cond ? ok++ : bad++);
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '   ' + extra));
};

// ---- in-memory stand-in for the Worker ----
let seq = 0;
let log = [];
let lastChat = null;
let lastChatHeaders = {};
let feedbackFlag = true; // what /health says about feedback
let fbSent = []; // feedback the page sent
let usageSent = []; // anonymous usage events the page sent
const decisions = {}; // listing decisions recorded on the All services page
let applyStatus = null; // what GET /log/apply/status returns (null: "Apply changes now" is off)
let providerLinks = []; // provider review links (GET /log/provider-links)
const pilotOrgs = {}; // organisations in the pilot (GET/PUT /log/pilot)
const edits = {}; // edits to details recorded on the All services page
const added = {}; // new services added on the All services page
const providerSent = [];
const orgs = {}; // organisation changes made on the All services page
const venueEdits = {}; // venue changes made on the All services page
const mk = (f, status) => {
  const t = new Date().toISOString();
  const it = { id: ++seq, type: f.type || 'Issue', title: f.title, details: f.details || '', area: f.area || 'Other', priority: f.priority || 'Medium', owner: f.owner || '', status: status || 'Open', created: t, updated: t, updates: [] };
  log.push(it);
  return it;
};

// Stored feedback for the User feedback review page.
const FB_PASS = PASS; // one team passcode for every Admin page
const fbToday = new Date().toISOString().slice(0, 10);
const fbBase = { date: fbToday, schemeIds: [], recordLastUpdated: null, helpful: null, reasons: [], text: '', missedService: null, gapCategories: [], gapArea: null, lang: 'en', mode: 'public', redacted: false, status: 'New', note: '' };
const fbStore = [
  { ...fbBase, id: 1, kind: 'reply', helpful: true, schemeIds: ['my-way-forward'] },
  { ...fbBase, id: 2, kind: 'reply', helpful: true, schemeIds: ['my-way-forward'] },
  { ...fbBase, id: 3, kind: 'reply', helpful: true, schemeIds: ['my-way-forward'], mode: 'staff' },
  { ...fbBase, id: 4, kind: 'reply', helpful: false, schemeIds: ['my-way-forward'], reasons: ['none-fit'], text: 'Nothing near me' },
  { ...fbBase, id: 5, kind: 'card', schemeIds: ['my-way-forward'], recordLastUpdated: '2026-08-03', reasons: ['contact-wrong'] },
  { ...fbBase, id: 7, kind: 'reply', helpful: false, schemeIds: ['my-way-forward'], reasons: ['none-fit'], text: 'Team test entry', team: true },
  { ...fbBase, id: 6, kind: 'gap', reasons: ['missing-service'], missedService: { name: 'A test service', website: '', area: '', role: 'provider', organisation: 'Test Trust', phone: '01924 000000', selfReferral: 'no', audience: ['employer'], groups: ['women'], projects: [{ name: 'Peer group', sessions: [{ where: 'Jo Cox House', day: 'tue', start: '13:00', end: '15:00' }] }] } },
];

// "Who is this for?" has no default any more. The tests search as someone looking for themselves unless a
// choice is already made.
async function chooseMode(page, mode = 'public') {
  await page.evaluate((m) => { if (!document.querySelector('input[name=mode]:checked')) document.querySelector('input[name=mode][value=' + m + ']').checked = true; }, mode);
}

// Before the first cards in a conversation the page asks "Have we understood you?". This says yes, so the
// cards show. It does nothing when the cards are already showing.
async function showCards(page) {
  await page.waitForSelector('.check-summary .check-actions .btn.primary, .card');
  const yes = page.locator('.check-summary .check-actions .btn.primary');
  if (await yes.count()) await yes.click();
  await page.waitForSelector('.card');
}

async function worker(route) {
  const req = route.request();
  const url = new URL(req.url());
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-team-passcode, x-feedback-passcode, x-team-test', 'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS' };
  const json = (obj, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });

  if (url.pathname === '/health') return json({ ok: true, aiConfigured: true, teamLog: true, feedback: feedbackFlag, usage: true });
  if (url.pathname === '/usage/days' && req.method() === 'GET') {
    if (req.headers()['x-team-passcode'] !== FB_PASS) return json({ error: 'Wrong passcode.' }, 401);
    const team = url.searchParams.get('source') === 'team';
    return json({ days: [{ date: fbToday, counts: team ? { 'search|en|staff': 2 } : { 'search|en|public': 4, 'conversation|en|public': 2 }, total: 1, tokens: { 'claude-sonnet-5-5': { calls: team ? 2 : 4, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 } } }] });
  }
  if (url.pathname === '/usage' && req.method() === 'POST') { usageSent.push(JSON.parse(req.postData())); return route.fulfill({ status: 204, headers: cors }); }
  // Reading feedback (the User feedback review page), with the team passcode.
  if (url.pathname.startsWith('/feedback/')) {
    if (req.headers()['x-team-passcode'] !== FB_PASS) return json({ error: 'Wrong passcode.' }, 401);
    if (url.pathname === '/feedback/items' && req.method() === 'GET') return json({ items: fbStore, statuses: ['New', 'Reviewed', 'Actioned', 'Not actioned'] });
    if (url.pathname === '/feedback/export.csv') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/csv' }, body: '"id","date"\r\n"1","2026-10-01"\r\n' });
    const m = url.pathname.match(/^\/feedback\/items\/(\d+)$/);
    if (m && req.method() === 'PATCH') {
      const item = fbStore.find((x) => x.id === Number(m[1]));
      if (!item) return json({ error: 'Not found.' }, 404);
      Object.assign(item, JSON.parse(req.postData()));
      return json({ item });
    }
    return json({ error: 'Not found.' }, 404);
  }
  if (url.pathname === '/feedback' && req.method() === 'POST') {
    fbSent.push(JSON.parse(req.postData()));
    return json({ ok: true, redacted: false }, 201);
  }

  if (url.pathname === '/chat') {
    const body = JSON.parse(req.postData());
    const last = body.messages[body.messages.length - 1].content;
    lastChat = body;
    lastChatHeaders = req.headers();
    if (/crisis/i.test(last)) return json({ status: 'results', message: 'I am sorry you feel like this.', recommendations: [], safety_concern: true, urgent_types: ['mental_health_crisis'], pii_detected: false, understood_needs: [], follow_up_questions: [] });
    if (/abuse/i.test(last)) return json({ status: 'results', message: 'I am so sorry. You deserve to be safe.', recommendations: [], safety_concern: true, urgent_types: ['domestic_abuse'], pii_detected: false, understood_needs: [], follow_up_questions: [] });
    if (/unsure/i.test(last)) return json({ status: 'needs_more_info', message: 'Thanks, I can help. One quick question.', recommendations: [], safety_concern: false, urgent_types: [], pii_detected: false, understood_needs: ['needs support'], follow_up_questions: ['Which town are you nearest to?'], question_options: [{ question: 'Which town are you nearest to?', options: ['Batley', 'Dewsbury', 'Huddersfield'] }] });
    if (/Jane Smith/.test(last)) return json({ status: 'results', message: 'Here is a match.', recommendations: [], safety_concern: false, urgent_types: [], pii_detected: true, understood_needs: [], follow_up_questions: [] });
    if (/partnership/i.test(last)) return json({ status: 'results', message: 'Here are some options.', recommendations: [{ id: 'proper-progress', why: 'One.', fit: 'strong' }, { id: 'audio-boost', why: 'Two.', fit: 'possible' }, { id: 'acas-helpline', why: 'Three.', fit: 'possible' }], safety_concern: false, urgent_types: [], pii_detected: false, understood_needs: [], follow_up_questions: [] });
    if (/several/i.test(last)) return json({ status: 'results', message: 'Here are some options.', recommendations: [{ id: 'my-way-forward', why: 'One.', fit: 'strong' }, { id: 'acas-helpline', why: 'Two.', fit: 'possible' }, { id: 'nope-not-real', why: 'Dropped.', fit: 'possible' }], safety_concern: false, urgent_types: [], pii_detected: false, understood_needs: [], follow_up_questions: [] });
    return json({ status: 'results', message: 'Here is a match.', recommendations: [{ id: 'my-way-forward', why: 'Fits your age and situation.', fit: 'possible', check_first: 'Check they are not claiming Universal Credit with a job-search requirement.' }], safety_concern: false, urgent_types: [], pii_detected: false, understood_needs: ['aged 20', 'anxious'], follow_up_questions: [] });
  }

  if (url.pathname.startsWith('/provider/') && req.method() === 'POST') {
    providerSent.push(JSON.parse(req.postData() || '{}'));
    return json({ ok: true, t: new Date().toISOString() });
  }
  if (url.pathname.startsWith('/provider/') && req.method() === 'GET') {
    const all = require(path.join(__dirname, '..', 'data', 'services-all.json'));
    const svc = all.services.find((x) => x.id === (url.pathname.includes('bbbb') ? 'acas-helpline' : 'my-way-forward'));
    return json({ service: svc, contact: 'Sam', expires: '2027-01-31T00:00:00Z', lastReply: null, choices: all.choices, organisations: all.organisations, venues: all.venues, otherServices: [] });
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
    if (url.pathname === '/log/apply/status') return applyStatus ? json(applyStatus) : json({ error: 'Off.', off: true }, 404);
    if (url.pathname === '/log/provider-links' && req.method() === 'GET') return json({ links: providerLinks });
    const hm = url.pathname.match(/^\/log\/provider-links\/([A-Za-z0-9_-]{32})\/handled$/);
    if (hm && req.method() === 'POST') {
      const b = JSON.parse(req.postData());
      const l = providerLinks.find((x) => x.token === hm[1]);
      const r = l && l.replies.find((x) => x.t === b.t);
      if (!r) return json({ error: 'Not found.' }, 404);
      r.handled = { by: b.by, t: new Date().toISOString(), note: b.note };
      return json({ link: l });
    }
    if (url.pathname === '/log/decisions') return json({ decisions });
    if (url.pathname === '/log/edits') return json({ edits });
    if (url.pathname === '/log/new') return json({ added });
    if (url.pathname === '/log/orgs') return json({ orgs });
    if (url.pathname === '/log/pilot') return json({ pilot: pilotOrgs });
    const pm = url.pathname.match(/^\/log\/pilot\/([a-z0-9-]+)$/);
    if (pm && req.method() === 'PUT') {
      const b = JSON.parse(req.postData());
      if (b.on) pilotOrgs[pm[1]] = pilotOrgs[pm[1]] || { by: b.by, t: new Date().toISOString() }; else delete pilotOrgs[pm[1]];
      return json({ id: pm[1], item: pilotOrgs[pm[1]] || null });
    }
    if (url.pathname === '/log/venues') return json({ venues: venueEdits });
    const vm = url.pathname.match(/^\/log\/venues\/([a-z0-9-]+)$/);
    if (vm && req.method() === 'PUT') {
      const b = JSON.parse(req.postData());
      venueEdits[vm[1]] = { ...b, t: new Date().toISOString(), history: [] };
      return json({ id: vm[1], item: venueEdits[vm[1]] });
    }
    if (vm && req.method() === 'DELETE') {
      delete venueEdits[vm[1]];
      return json({ id: vm[1], deleted: true });
    }
    const om = url.pathname.match(/^\/log\/orgs\/([a-z0-9-]+)$/);
    if (om && req.method() === 'PUT') {
      const b = JSON.parse(req.postData());
      orgs[om[1]] = { ...b, t: new Date().toISOString(), history: [] };
      return json({ id: om[1], item: orgs[om[1]] });
    }
    if (om && req.method() === 'DELETE') {
      delete orgs[om[1]];
      return json({ id: om[1], deleted: true });
    }
    const nm = url.pathname.match(/^\/log\/new\/([a-z0-9-]+)$/);
    if (nm && req.method() === 'PUT') {
      const b = JSON.parse(req.postData());
      const t = new Date().toISOString();
      added[nm[1]] = { service: b.service, note: b.note, by: b.by, checkedUrl: b.checkedUrl || null, created: (added[nm[1]] || {}).created || t, createdBy: (added[nm[1]] || {}).createdBy || b.by, t, history: [] };
      return json({ id: nm[1], item: added[nm[1]] });
    }
    if (nm && req.method() === 'DELETE') {
      delete added[nm[1]];
      return json({ id: nm[1], deleted: true });
    }
    const em = url.pathname.match(/^\/log\/edits\/([a-z0-9-]+)$/);
    if (em && req.method() === 'PUT') {
      const b = JSON.parse(req.postData());
      edits[em[1]] = { ...b, t: new Date().toISOString(), history: [] };
      return json({ id: em[1], item: edits[em[1]] });
    }
    if (em && req.method() === 'DELETE') {
      delete edits[em[1]];
      return json({ id: em[1], deleted: true });
    }
    const dm = url.pathname.match(/^\/log\/decisions\/([a-z0-9-]+)$/);
    if (dm && req.method() === 'PUT') {
      const b = JSON.parse(req.postData());
      const prev = decisions[dm[1]];
      decisions[dm[1]] = { decision: b.decision, note: b.note, by: b.by, t: new Date().toISOString(), history: prev ? [...prev.history, { decision: prev.decision, note: prev.note, by: prev.by, t: prev.t }] : [] };
      return json({ id: dm[1], item: decisions[dm[1]] });
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
  // The commissioner map's background tiles: never fetched in the test.
  await ctx.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 204, body: '' }));
  const page = await ctx.newPage();

  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

  // ---------- main page ----------
  await page.goto(ON + '/');
  check('main: no team bar on the public page', (await page.locator('.teambar').count()) === 0);
  check('main: one link to Admin, and nothing else for the team', (await page.locator('a[href^="admin/"]').evaluateAll((a) => a.map((x) => x.getAttribute('href') + '|' + x.textContent))).join() === 'admin/|Admin');
  check('main: the word MVP is not on the page', !(await page.content()).includes('MVP'));
  check('main: "Who is this for?" has no default', (await page.locator('input[name=mode]:checked').count()) === 0);
  await page.fill('#message', 'I am 20 and anxious in Dewsbury');
  await page.click('#send');
  await page.waitForTimeout(200);
  check('main: searching without choosing asks for the choice and sends nothing', (await page.locator('#mode-error').isVisible()) && (await page.locator('.bubble.user').count()) === 0);
  await page.check('input[name=mode][value=public]');
  check('main: choosing hides the prompt', !(await page.locator('#mode-error').isVisible()));
  await page.click('#send');
  await page.waitForSelector('.check-summary');
  check('check: summary shown before any cards', (await page.locator('.card').count()) === 0 && (await page.locator('.check-summary h2').textContent()) === 'Have we understood you?' && (await page.locator('.check-list li').allTextContents()).join('|') === 'Aged 20|Anxious');
  check('check: no feedback buttons while the summary waits', (await page.locator('.fb-reply').count()) === 0);
  await page.waitForTimeout(300);
  check('check: summary announced to screen readers', (await page.textContent('#sr-status')).includes('Have we understood you?'));
  await page.locator('.check-summary .btn.primary').click();
  await page.waitForSelector('.card');
  check('check: "Yes" shows the cards with no second call to the AI', (await page.locator('.check-actions').count()) === 0 && (await page.locator('.check-done').textContent()) === 'Thanks for checking.' && lastChat.messages.length === 1);
  check('usage: summary "yes" counted', usageSent.some((e) => e.e === 'summary' && e.k === 'yes'));
  check('main: "other options" offered under the results', (await page.locator('.more-options .chip').count()) === 1);
  check('usage: page visit sent with no identifiers', usageSent.some((e) => e.e === 'visit') && usageSent.every((e) => Object.keys(e).every((k) => ['e', 's', 'k', 'lang', 'mode'].includes(k))), JSON.stringify(usageSent));
  check('main: scheme card rendered from the data file', (await page.locator('.card h3').first().textContent()) === 'My Way Forward');
  // Worked out from the data: My Way Forward is the card shown, and it is flagged only while it is overdue.
  const mwfData = DATA.find((x) => x.id === 'my-way-forward');
  const mwfOverdue = (Date.now() - Date.parse(mwfData.lastUpdated + 'T00:00:00')) / 86400000 > 135;
  check('main: overdue warning only when the entry is overdue', (await page.locator('.card .stale').count()) === (mwfOverdue ? 1 : 0));

  // ---------- folding cards ----------
  {
    const one = page.locator('.card').first();
    const btn = one.locator('.more-btn');
    check('cards: a single result starts open', (await btn.getAttribute('aria-expanded')) === 'true' && await one.locator('.more').isVisible() && (await btn.textContent()) === 'Hide full details');
    check('cards: the button points at the section it opens', (await btn.getAttribute('aria-controls')) === (await one.locator('.more').getAttribute('id')));
    check('cards: no "all" button with one result', (await page.locator('.cards-bar').count()) === 0);
    const p2 = await ctx.newPage();
    p2.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    await p2.goto(ON + '/');
    await p2.check('input[name=mode][value=staff]');
    await p2.fill('#message', 'show me several options');
    await p2.click('#send');
    await p2.waitForSelector('.card');
    const cards = p2.locator('.card');
    check('cards: unknown ids are left out', (await cards.count()) === 2);
    check('cards: several results start folded, with the summary still showing', (await p2.locator('.card .more-btn[aria-expanded="false"]').count()) === 2 && (await p2.locator('.card .more:visible').count()) === 0 && await cards.first().locator('.whofor').isVisible() && await cards.first().locator('.why').isVisible());
    check('cards: contact details are inside the folded part', (await cards.first().locator('.more .contact').count()) === 1);
    const shortH = (await cards.first().boundingBox()).height;
    await cards.first().locator('.more-btn').click();
    check('cards: "Show full details" opens one card only', (await cards.first().locator('.more-btn').getAttribute('aria-expanded')) === 'true' && await cards.first().locator('.more .contact').isVisible() && !(await cards.nth(1).locator('.more').isVisible()));
    check('cards: a folded card is much shorter than an open one', (await cards.first().boundingBox()).height > shortH * 1.5, shortH + ' vs ' + (await cards.first().boundingBox()).height);
    check('usage: opening a card is counted once, with the scheme', usageSent.filter((e) => e.e === 'expand').length === 1 && usageSent.find((e) => e.e === 'expand').s === 'my-way-forward', JSON.stringify(usageSent.filter((e) => e.e === 'expand')));
    await cards.first().locator('.more-btn').click();
    check('cards: pressing again folds it', !(await cards.first().locator('.more').isVisible()) && (await cards.first().locator('.more-btn').textContent()) === 'Show full details');
    {
      // Partnerships and where the details came from.
      const p3 = await ctx.newPage();
      p3.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
      await p3.goto(ON + '/');
      await p3.check('input[name=mode][value=staff]');
      await p3.fill('#message', 'partnership options please');
      await p3.click('#send');
      await p3.waitForSelector('.card');
      const c3 = p3.locator('.card');
      check('cards: a partnership shows the lead and "In partnership with" the others', (await c3.first().locator('.org').first().textContent()) === 'Proper Job Theatre Company' && (await c3.first().locator('.org.partners').textContent()) === 'In partnership with KLTV and Thread Republic');
      check('cards: a service with no partners has no partner line', (await c3.nth(2).locator('.org.partners').count()) === 0);
      check('cards: a verified listing says the organisation confirmed it; a website listing says so', /^Details confirmed by the organisation on /.test(await c3.nth(1).locator('.meta').textContent()) && /^Details from the service's website, last checked /.test(await c3.nth(2).locator('.meta').textContent()) && /^Information last checked/.test(await c3.first().locator('.meta').textContent()));
      await p3.close();
    }
    await p2.click('.cards-bar .all-btn');
    check('cards: "Show full details for all" opens every card', (await p2.locator('.card .more:visible').count()) === 2 && (await p2.textContent('.cards-bar .all-btn')) === 'Hide full details for all');
    await p2.click('.cards-bar .all-btn');
    check('cards: and folds them again', (await p2.locator('.card .more:visible').count()) === 0);
    await p2.close();
  }

  // ---------- feedback: "Report a problem with this listing" ----------
  const lastSent = () => fbSent[fbSent.length - 1];
  const waitSent = async (n) => { for (let i = 0; i < 50 && fbSent.length < n; i++) await page.waitForTimeout(100); };
  const cardLink = page.locator('.card').first().locator('.fb-card .linkish');
  check('feedback: each card has a "Report a problem" link', (await cardLink.textContent()) === 'Report a problem with this listing' && (await cardLink.getAttribute('aria-expanded')) === 'false');
  await cardLink.focus();
  await page.keyboard.press('Enter');
  const cardForm = page.locator('.card').first().locator('form.fb-card-form');
  await cardForm.waitFor();
  check('feedback: the card form opens inside the card from the keyboard', (await cardLink.getAttribute('aria-expanded')) === 'true' && (await cardLink.getAttribute('aria-controls')) === (await cardForm.getAttribute('id')));
  check('feedback: card form has a fieldset, a legend with the scheme name in English, and 7 labelled tick boxes', (await cardForm.locator('fieldset legend [lang="en"]').textContent()) === 'My Way Forward' && (await cardForm.locator('fieldset label input[type=checkbox]').count()) === 7);
  const ta = cardForm.locator('textarea');
  const taId = await ta.getAttribute('id');
  check('feedback: comment box has a label, the privacy note and a 300 character limit', (await ta.getAttribute('maxlength')) === '300' && (await cardForm.locator('label[for="' + taId + '"]').count()) === 1 && (await cardForm.locator('.fb-note').textContent()).includes("Please don't include names, contact details") && (await ta.getAttribute('aria-describedby')).includes(taId + '-note'));
  await cardForm.locator('button[type=submit]').click();
  check('feedback: sending with nothing ticked asks for a tick', (await cardForm.locator('.fb-error').textContent()).includes('at least one') && fbSent.length === 0);
  await cardForm.locator('input[value="contact-wrong"]').check();
  await cardForm.locator('input[value="missing-details"]').check();
  await ta.fill('The number 07700 900123 rang out, email info@example.org');
  check('feedback: the page warns that contact details will be removed', await cardForm.locator('.fb-warn').isVisible() && (await cardForm.locator('.fb-warn').textContent()).includes('remove'));
  await cardForm.locator('button[type=submit]').click();
  await page.locator('.card').first().locator('.fb-thanks').waitFor();
  const sentCard = lastSent();
  const mwf = DATA.find((x) => x.id === 'my-way-forward');
  check('feedback: card entry sends the scheme id, the record date, reasons, mode and language', sentCard.kind === 'card' && sentCard.schemeIds.join() === 'my-way-forward' && sentCard.recordLastUpdated === mwf.lastUpdated && sentCard.reasons.join() === 'contact-wrong,missing-details' && sentCard.mode === 'public' && sentCard.lang === 'en', JSON.stringify(sentCard));
  check('feedback: contact details removed in the page before sending', sentCard.text === 'The number [removed] rang out, email [removed]', sentCard.text);
  check('feedback: thank-you replaces the form and has focus', await page.evaluate(() => document.activeElement.classList.contains('fb-thanks')) && (await page.locator('.card').first().locator('form, .fb-card .linkish').count()) === 0);
  await page.waitForTimeout(300);
  check('feedback: thank-you announced in the live region', (await page.textContent('#sr-status')).includes("We'll check this listing"));

  // ---------- feedback: "Was this helpful?" ----------
  check('feedback: helpful buttons under a reply with cards', (await page.locator('.fb-helpful').count()) === 1 && (await page.locator('.fb-helpful button').allTextContents()).join() === 'Yes,No');
  check('feedback: "Tell us" link under the result reply', (await page.locator('.fb-reply .fb-gap-link').first().textContent()) === 'Know a service that should be here? Tell us');
  await page.locator('.fb-helpful button', { hasText: 'Yes' }).click();
  await page.locator('.fb-reply .fb-thanks').first().waitFor();
  const sentYes = lastSent();
  check('feedback: Yes sends straight away with only the ids, mode and language', sentYes.kind === 'reply' && sentYes.helpful === true && sentYes.schemeIds.join() === 'my-way-forward' && Object.keys(sentYes).sort().join() === 'helpful,kind,lang,mode,schemeIds', JSON.stringify(sentYes));
  check('feedback: thank-you after Yes has focus', await page.evaluate(() => document.activeElement.classList.contains('fb-thanks')));
  await page.fill('#message', 'crisis');
  await chooseMode(page);
  await page.click('#send');
  await page.waitForSelector('.crisis');
  check('main: crisis panel shown when flagged', (await page.locator('.crisis').count()) === 1);
  check('feedback: no helpful buttons or feedback links under an urgent support reply', (await page.locator('.fb-reply').count()) === 1);
  check('main: card shows the fit badge and the check-first line', (await page.locator('.card .badge.fit-possible').first().textContent()) === 'Worth checking' && (await page.locator('.card .check').first().textContent()).startsWith('Check first:'));
  check('main: what was understood is in the summary, not repeated under the confirmed results', (await page.locator('.check-list').first().textContent()).includes('Anxious') && (await page.locator('.bubble .understood').count()) === 0);
  check('main: mental health crisis panel has the Single Point of Access number', (await page.locator('.crisis').first().textContent()).includes('01924 316830'));
  await page.fill('#message', 'there is abuse at home');
  await chooseMode(page);
  await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.crisis').length === 2);
  const abuse = await page.locator('.crisis').nth(1).textContent();
  check('main: domestic abuse panel has 999 and NHS 111, and no mental health number', abuse.includes('999') && abuse.includes('NHS 111') && !abuse.includes('01924'), abuse);
  const abusePanel = page.locator('.crisis').nth(1);
  check('main: domestic abuse panel gives the checked helplines as tap-to-call links', (await abusePanel.locator('a[href="tel:08000527222"]').count()) === 1 && (await abusePanel.locator('a[href="tel:08082000247"]').count()) === 1);
  check('main: domestic abuse panel links to the safety contacts page', (await abusePanel.locator('a.safety-link').getAttribute('href') || '').startsWith('safety.html'));
  await page.fill('#message', 'I am unsure what I need');
  await chooseMode(page);
  await page.click('#send');
  await page.waitForFunction(() => document.body.textContent.includes('Which town are you nearest to?'));
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  check('feedback: no helpful buttons or feedback links under a reply that asks questions', (await page.locator('.fb-reply').count()) === 1 && (await page.locator('.fb-helpful').count()) === 0);
  const qBox = page.locator('.answer-box').last();
  check('answers: the question is a labelled group of tappable answers plus "Prefer not to say"', (await qBox.locator('fieldset legend').textContent()) === 'Which town are you nearest to?' && (await qBox.locator('input[type=radio]').count()) === 4 && (await qBox.locator('label.answer-option').last().textContent()) === 'Prefer not to say');
  check('answers: the question is not repeated in the message above', !(await page.locator('.bubble.assistant').last().locator(':scope > p').allTextContents()).join(' ').includes('Which town'));
  await qBox.locator('.answer-continue').click();
  check('answers: Continue with nothing picked asks for an answer and sends nothing', await qBox.locator('.answer-error').isVisible() && lastChat.messages[lastChat.messages.length - 1].content === 'I am unsure what I need');
  await qBox.locator('label.answer-option', { hasText: 'Dewsbury' }).click();
  await qBox.locator('.answer-continue').click();
  await page.waitForFunction(() => document.querySelectorAll('.bubble.assistant').length >= 6 && !document.querySelector('#send').disabled);
  check('answers: the question asked is kept in the history for the AI, even though it was only shown with buttons', lastChat.messages.some((m) => m.role === 'assistant' && m.content.startsWith('Thanks, I can help. One quick question.') && m.content.includes('Which town are you nearest to?')), JSON.stringify(lastChat.messages));
  check('answers: no "what I have understood" line under a question', (await page.locator('.bubble.assistant').filter({ has: page.locator('.answer-box') }).locator('.understood').count()) === 0);
  check('answers: the tapped answer is sent with its question', lastChat.messages[lastChat.messages.length - 1].content === 'Which town are you nearest to? Dewsbury', JSON.stringify(lastChat.messages.slice(-1)));
  check('answers: the old question keeps only the picked answer and can no longer be changed', (await qBox.locator('fieldset[disabled]').count()) === 1 && (await qBox.locator('.answer-continue').count()) === 0);
  check('usage: tapped answer counted', usageSent.some((e) => e.e === 'answers' && e.k === 'tapped'));
  check('main: follow-up questions asked are recorded in the history sent back', lastChat.messages.some((m) => m.role === 'assistant' && m.content.includes('(Follow-up questions asked: 1)')), JSON.stringify(lastChat.messages));

  // ---------- feedback: "No", then "It missed a service I know about" ----------
  const reply2 = page.locator('.fb-reply').nth(1);
  check('feedback: helpful buttons under the next result reply', (await reply2.locator('.fb-helpful').count()) === 1);
  await reply2.locator('.fb-helpful button', { hasText: 'No' }).click();
  const noForm = reply2.locator('form.fb-no-form');
  await noForm.waitFor();
  check('feedback: No opens tick boxes, with focus on the first', (await noForm.locator('input[type=checkbox]').count()) === 4 && await page.evaluate(() => document.activeElement.value === 'none-fit') && (await noForm.locator('textarea').getAttribute('maxlength')) === '300');
  check('feedback: gap form not open yet', (await reply2.locator('form.fb-gap-form').count()) === 0);
  await noForm.locator('input[value="missed-service"]').check();
  await reply2.locator('form.fb-gap-form').waitFor();
  check('feedback: "It missed a service I know about" opens the gap form, the same one as the Tell us link', (await reply2.locator('form.fb-gap-form').count()) === 1 && (await reply2.locator('.fb-gap-link').getAttribute('aria-expanded')) === 'true' && (await reply2.locator('.fb-gap-link').getAttribute('aria-controls')) === (await reply2.locator('form.fb-gap-form').getAttribute('id')));
  await page.waitForTimeout(300);
  check('feedback: opening the gap form is announced', (await page.textContent('#sr-status')).includes('opened below'));
  await noForm.locator('input[value="info-wrong"]').check();
  await noForm.locator('button[type=submit]').click();
  await reply2.locator('.fb-thanks').first().waitFor();
  const sentNo = lastSent();
  check('feedback: No sends the reasons, ids, mode and language', sentNo.kind === 'reply' && sentNo.helpful === false && sentNo.reasons.join() === 'info-wrong,missed-service' && sentNo.schemeIds.join() === 'my-way-forward', JSON.stringify(sentNo));
  const gapForm = reply2.locator('form.fb-gap-form');
  check('feedback: gap form is still open after sending the No form', await gapForm.isVisible());
  check('feedback: service fields only appear once "a service" is ticked', !(await gapForm.locator('.fb-sub').first().isVisible()));
  await gapForm.locator('input[value="missing-service"]').check();
  const svcSub = gapForm.locator('.fb-sub').first();
  check('feedback: gap form first asks only "from this service, or suggesting it?"', await svcSub.isVisible() && (await svcSub.locator('input[type=radio]').count()) === 2 && !(await svcSub.locator('label:text-is("Name of the service (mandatory)")').isVisible()));
  await gapForm.locator('button[type=submit]').click();
  check('feedback: "from this service, or suggesting it?" is needed', (await gapForm.locator('.fb-error').textContent()).includes('from the service or suggesting it') && lastSent() === sentNo && await page.evaluate(() => document.activeElement.type === 'radio'));
  await svcSub.locator('input[type=radio][value=suggester]').check();
  const topLabels = await svcSub.locator('.fb-rest > .fb-field > label').allTextContents();
  check('feedback: "not from the organisation" asks for the names and a way to find out more, nothing else', topLabels.join('|') === 'Name of the service (mandatory)|Name of organisation (mandatory)|Its website|Its phone number|Email address for the service|Area it covers|Anything else we should know?' && !(await svcSub.locator('details.fb-more').count()) && (await svcSub.locator('.fb-prompt').textContent()).includes('a website or a contact') && !(await svcSub.locator('label:has-text("You may use our logo")').count()), topLabels.join('|'));
  await gapForm.locator('button[type=submit]').click();
  check('feedback: the service name is needed', (await gapForm.locator('.fb-error').textContent()).includes('name of the service') && lastSent() === sentNo);
  check('feedback: both missing names get a red box and a message, and focus jumps to the service name', (await svcSub.locator('.fb-field.fb-invalid').count()) === 2 && (await svcSub.locator('.fb-field-error:visible').count()) === 2 && (await svcSub.getByLabel('Name of the service (mandatory)', { exact: true }).getAttribute('aria-invalid')) === 'true' && await page.evaluate(() => document.activeElement.labels && document.activeElement.labels[0].textContent === 'Name of the service (mandatory)'));
  const areaOpts = await svcSub.locator('select').first().locator('option').allTextContents();
  check('feedback: area choices come from the data, plus "Don\'t know"', areaOpts.includes('Batley') && areaOpts.includes('Kirklees-wide') && areaOpts[areaOpts.length - 1] === "Don't know" && areaOpts.length === new Set(DATA.flatMap((x) => x.areas)).size + 2, areaOpts.join('|'));
  await svcSub.getByLabel('Name of the service (mandatory)', { exact: true }).fill('Batley Job Club');
  await gapForm.locator('button[type=submit]').click();
  check('feedback: the organisation is needed too', (await gapForm.locator('.fb-error').textContent()).includes('organisation') && lastSent() === sentNo);
  check('feedback: typing a name clears its red box; the organisation keeps its own and gets the focus', (await svcSub.locator('.fb-field.fb-invalid').count()) === 1 && (await svcSub.getByLabel('Name of the service (mandatory)', { exact: true }).getAttribute('aria-invalid')) === null && await page.evaluate(() => document.activeElement.labels[0].textContent === 'Name of organisation (mandatory)'));
  await svcSub.getByLabel('Name of organisation (mandatory)', { exact: true }).fill('Batley Trust');
  await gapForm.locator('button[type=submit]').click();
  check('feedback: a website, phone or email is needed, so we can find out more', (await gapForm.locator('.fb-error').textContent()).includes('website, phone number or email') && lastSent() === sentNo);
  await gapForm.locator('input[type=url]').fill('not a web address');
  await gapForm.locator('button[type=submit]').click();
  check('feedback: a bad website is explained and not sent', (await gapForm.locator('.fb-error').textContent()).includes('http') && lastSent() === sentNo);
  await gapForm.locator('input[type=url]').fill('www.example.org/job-club');
  await svcSub.locator('select').first().selectOption('Batley');
  await gapForm.locator('button[type=submit]').click();
  await reply2.locator('.fb-gap-slot .fb-thanks').waitFor();
  const sentGap = lastSent();
  check('feedback: gap entry sent, with the website given https://', sentGap.kind === 'gap' && sentGap.reasons.join() === 'missing-service' && sentGap.missedService.name === 'Batley Job Club' && sentGap.missedService.website === 'https://www.example.org/job-club' && sentGap.missedService.area === 'Batley' && sentGap.missedService.role === 'suggester' && sentGap.missedService.organisation === 'Batley Trust' && Object.keys(sentGap.missedService).length === 5 && sentGap.mode === 'public', JSON.stringify(sentGap));
  await page.fill('#message', 'My name is Jane Smith and I need work');
  await chooseMode(page);
  await page.click('#send');
  await page.waitForSelector('.pii-note');
  check('main: reminder about identifying details shown when flagged', (await page.locator('.pii-note').textContent()).includes('please leave them out'));
  check('feedback: "Tell us" link under a result reply with no cards, but no helpful buttons', (await page.locator('.fb-reply').count()) === 3 && (await page.locator('.fb-reply').nth(2).locator('.fb-helpful').count()) === 0 && (await page.locator('.fb-reply').nth(2).locator('.fb-gap-link').count()) === 1);

  // ---------- feedback: "Suggest a service" in the header, any time ----------
  const sugBtn = page.locator('#suggest-btn');
  check('feedback: "Suggest a service" button in the header', await sugBtn.isVisible() && (await sugBtn.textContent()).trim() === 'Suggest a service' && (await sugBtn.getAttribute('aria-expanded')) === 'false');
  check('feedback: no "Tell us" link in the emergency footer', (await page.locator('.site-footer .fb-gap-link, #fb-footer').count()) === 0);
  // "Who is this for?" is hidden during a chat, so try the button on a fresh page, with no chat at all.
  await page.goto(ON + '/');
  await sugBtn.waitFor();
  await page.locator('label:has(input[name=mode][value=staff])').click();
  await sugBtn.click();
  const panel = page.locator('#suggest-panel');
  const footForm = panel.locator('form.fb-gap-form');
  await footForm.waitFor();
  check('feedback: "What\'s missing?" is a choice of one', (await footForm.locator('input[name=gap][type=radio]').count()) === 3 && (await footForm.locator('legend').first().textContent()) === "What's missing? Choose one.");
  check('feedback: the button opens a panel with nothing ticked', (await sugBtn.getAttribute('aria-expanded')) === 'true' && (await panel.locator('h2').textContent()) === 'Suggest a service' && (await footForm.locator('input[name=gap]:checked').count()) === 0 && !(await footForm.locator('.fb-sub').first().isVisible()));
  check('feedback: focus moves to the first tick box', await page.evaluate(() => document.activeElement && document.activeElement.name === 'gap'));
  await footForm.locator('input[value="missing-support"]').check();
  check('feedback: categories come from the data, in English, plus "Something else"', (await footForm.locator('input[name=category]').count()) === new Set(DATA.flatMap((x) => x.categories)).size + 1 && (await footForm.locator('label:has(input[value="Carers"]) span').first().getAttribute('lang')) === 'en');
  await footForm.locator('input[name=category][value="Carers"]').check();
  await footForm.locator('.fb-sub').nth(1).locator('select').selectOption('Dewsbury');
  await footForm.locator('textarea[name=text]').fill('Nothing for young carers who want work.');
  await footForm.locator('button[type=submit]').click();
  await panel.locator('.fb-thanks').waitFor();
  const sentFoot = lastSent();
  check('feedback: header form sends a gap entry with categories and area, in staff mode', sentFoot.kind === 'gap' && sentFoot.reasons.join() === 'missing-support' && sentFoot.gapCategories.join() === 'Carers' && sentFoot.gapArea === 'Dewsbury' && sentFoot.mode === 'staff' && !sentFoot.missedService, JSON.stringify(sentFoot));
  await panel.locator('button:text-is("Close")').click();
  check('feedback: Close shuts the panel and returns focus to the button', !(await panel.isVisible()) && (await sugBtn.getAttribute('aria-expanded')) === 'false' && await page.evaluate(() => document.activeElement.id === 'suggest-btn'));

  // Someone from the service: the full service form, on its own page (the same form as the verify page).
  await sugBtn.click();
  await footForm.waitFor();
  await footForm.locator('input[value="missing-service"]').check();
  const sub = footForm.locator('.fb-sub').first();
  check('feedback: choosing a service hides the support questions', !(await footForm.locator('input[name=category]').first().isVisible()) && !(await footForm.locator('input[value="missing-support"]').isChecked()));
  await sub.locator('input[type=radio][value=provider]').check();
  check('feedback: "I work for or run this service" points to the service form, and this form\'s own Send steps aside', (await sub.locator('.fb-prompt').textContent()).includes('service form') && (await sub.locator('a.btn[href^="./suggest.html"]').getAttribute('target')) === '_blank' && !(await footForm.locator('.fb-actions button[type=submit]').isVisible()), JSON.stringify([await sub.locator('.fb-prompt').count(), await sub.locator('a.btn').count(), await footForm.locator('.fb-actions button[type=submit]').isVisible()]));
  await sub.locator('input[type=radio][value=suggester]').check();
  check('feedback: ...and comes back for the short version', await footForm.locator('.fb-actions button[type=submit]').isVisible());
  await sugBtn.click();
  const sentFoot2 = lastSent();
  await page.goto(ON + '/suggest.html?org=' + encodeURIComponent('Batley Community Trust'));
  await page.waitForSelector('#pc-app:not([hidden])');
  check('service form: the same three-part form, starting empty with the organisation filled in and no "Unknown" labels', (await page.locator('.lf-steps .lf-step').count()) === 3 && (await page.inputValue('#sg-organisation')) === 'Batley Community Trust' && (await page.inputValue('#sg-name')) === '' && (await page.locator('.lf-label').count()) === 0);
  await page.fill('#sg-name', 'Batley Job Club');
  await page.fill('#sg-whoFor', 'Anyone in Batley looking for work.');
  await page.locator('#sg-residence input[value=kirklees]').check();
  const aboveRes = page.locator('.lf-above[data-ess=residence]');
  check('service form: where people live shows in the eligibility, with its own "Essential" tick, unticked to start', await aboveRes.isVisible() && (await aboveRes.textContent()).includes('People living in Kirklees') && !(await aboveRes.locator('input[type=checkbox]').isChecked()));
  await aboveRes.getByLabel('Essential').check();
  await page.locator('#sg-residence input[value=west-yorkshire]').check();
  await page.locator('#sg-residence input[value=kirklees]').check();
  check('service form: the tick stays when the answer above is changed and the line redrawn', await page.locator('.lf-above[data-ess=residence] input[type=checkbox]').isChecked());
  const catBox = page.locator('#sg-categories');
  await catBox.getByLabel('Benefits and money', { exact: true }).check();
  check('service form: with one kind of support ticked, there is no "main one" question', !(await catBox.locator('.lf-main').isVisible()));
  await catBox.getByLabel('Apprenticeships', { exact: true }).check();
  await catBox.locator('.lf-main').getByLabel('Apprenticeships', { exact: true }).check();
  check('service form: with two or more, it asks which is the main one, from only those ticked', await catBox.locator('.lf-main').isVisible() && (await catBox.locator('.lf-main input').count()) === 2);
  await page.click('.lf-step[data-part="2"]');
  await page.fill('#sg-webpage', 'www.example.org/job-club');
  await page.click('.lf-step[data-part="3"]');
  await page.locator('.lf-proj textarea').first().fill('Weekly job club with CV help.');
  const proj1 = page.locator('.lf-proj').first();
  check('service form: cost is asked for each activity, not in part 2', await proj1.getByLabel('Cost', { exact: true }).isVisible() && !(await page.locator('.lf-part[data-part="2"] [data-key=cost]').count()));
  await proj1.getByLabel('Cost', { exact: true }).fill('Free');
  await proj1.getByLabel('At set times and places').check();
  await proj1.locator('input[type=radio][value=no]').last().check();
  if (!(await proj1.locator('.lf-session').count())) await proj1.locator('button', { hasText: 'Add a time and place' }).click();
  const row1 = proj1.locator('.lf-session').first();
  check('service form: "This one is online" only shows when the activity runs online or by phone', !(await row1.locator('.lf-online').isVisible()));
  await proj1.getByLabel('Online or by phone').check();
  await row1.locator('.lf-online input').check();
  check('service form: an online time and place needs no place', await row1.locator('.lf-online').isVisible() && !(await row1.getByLabel('Place', { exact: true }).isVisible()));
  await row1.locator('input[value=tue]').check();
  await page.fill('#sg-yourname', 'Sam');
  await page.click('.pc-send button[type=submit]');
  check('service form: unanswered questions are a reminder, with "Send anyway"', await page.locator('.pc-left').isVisible() && lastSent() === sentFoot2);
  await page.locator('.pc-left button', { hasText: 'Send anyway' }).click();
  await page.waitForSelector('.lf-review');
  const rv = await page.locator('.lf-review').innerText();
  check('service form: "Check your answers" shows what they told us, by part, before anything is sent', lastSent() === sentFoot2 && rv.includes('Part 1: The service and who can join') && rv.includes('People living in Kirklees (essential)') && rv.includes('Cost: Free') && rv.includes('Online') && rv.includes('Sam') && !(await page.locator('.lf-part').first().isVisible()), rv.slice(0, 600));
  await page.locator('.lf-review-row', { hasText: 'Who can use it' }).first().locator('button', { hasText: 'Change' }).click().catch(() => page.locator('.lf-review-change button').first().click());
  check('service form: "Change" goes back to that question in the form', !(await page.locator('.lf-review').count()) && await page.locator('.lf-part:visible').count() === 1);
  await page.click('.lf-step[data-part="3"]');
  await page.click('.pc-send button[type=submit]');
  await page.locator('.pc-left button', { hasText: 'Send anyway' }).click();
  await page.locator('.lf-review button', { hasText: 'Send to the Healthy Working Life team' }).click();
  await page.waitForSelector('.pc-thanks');
  const sentFull = lastSent();
  const fm = sentFull.missedService || {};
  check('service form: sent to the team as a suggested service with the whole listing', sentFull.kind === 'gap' && sentFull.reasons.join() === 'missing-service' && fm.role === 'provider' && fm.name === 'Batley Job Club' && fm.organisation === 'Batley Community Trust' && fm.contactName === 'Sam' && fm.listing && fm.listing.whoFor === 'Anyone in Batley looking for work.' && JSON.stringify(fm.listing.residence) === '{"scope":"kirklees"}' && fm.listing.projects[0].overview === 'Weekly job club with CV help.' && fm.listing.webpage === 'https://www.example.org/job-club' && fm.listing.cost === 'Free' && fm.listing.categories.join() === 'Apprenticeships,Benefits and money' && JSON.stringify(fm.listing.essential) === '["residence"]' && !('cost' in fm.listing.projects[0]) && JSON.stringify(fm.listing.projects[0].sessions) === '[{"id":"tue","where":["Online"],"days":["tue"]}]' && fm.website === 'https://www.example.org/job-club', JSON.stringify(fm.listing && [fm.listing.cost, fm.listing.projects]));
  check('service form: offers to add another service from the same organisation', await page.locator('.pc-thanks button', { hasText: 'Tell us about another service' }).isVisible());
  await page.goto(ON + '/');
  await sugBtn.waitFor();
  await sugBtn.click();
  await footForm.waitFor();
  await sugBtn.click();
  check('feedback: the button closes the panel too', !(await panel.isVisible()));
  const everything = JSON.stringify(fbSent);
  check('feedback: nothing from the conversation is ever sent', fbSent.length === 6 && fbSent.every((x) => !('messages' in x) && !('understood_needs' in x) && !('message' in x)) && !everything.includes('aged 20') && !everything.includes('Here is a match'), everything);
  check('feedback: nothing stored in the browser', await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''));

  // ---------- Admin home and signing in ----------
  await page.goto(ON + '/admin/help.html');
  await page.waitForURL(/\/admin\/\?next=help\.html$/);
  check('admin: not signed in, an Admin page sends you to sign in first', await page.locator('#gate').isVisible() && !(await page.locator('#app').isVisible()));
  check('admin: says why', (await page.textContent('#gate-msg')).includes('Please sign in'));
  for (const p of ['services.html', 'log.html', 'feedback.html']) {
    await page.goto(ON + '/admin/' + p);
    await page.waitForURL(/\/admin\/\?next=/);
    check('admin: ' + p + ' is not shown without signing in', page.url().endsWith('?next=' + p) && (await page.locator('.svc, #list .entry').count()) === 0);
  }
  await page.goto(ON + '/admin/');
  check('admin: home page asks for the passcode and a name', await page.locator('#pass').isVisible() && await page.locator('#by').isVisible() && !(await page.locator('#app').isVisible()));
  await page.fill('#pass', 'wrong');
  await page.click('#unlock');
  await page.waitForSelector('#gate-msg:not([hidden])');
  check('admin: wrong passcode explained', (await page.textContent('#gate-msg')).includes('not right'));
  check('admin: wrong passcode is not kept', await page.evaluate(() => !sessionStorage.getItem('hwlTeamPass')));
  await page.fill('#pass', PASS);
  await page.fill('#by', 'PL');
  await page.click('#unlock');
  await page.waitForSelector('#app:not([hidden])');
  check('admin: signed in, the seven Admin pages are listed', (await page.locator('.admin-tools a').evaluateAll((a) => a.map((x) => x.getAttribute('href')))).join() === 'todo.html,help.html,organisation.html,services.html,commissioner.html,log.html,feedback.html');
  check('admin: team bar says signed in with the name', (await page.textContent('.teambar .team-auth')).includes('Signed in as PL'));
  // ---------- Admin test mode ----------
  const usageBefore = usageSent.length;
  await page.click('#test-mode');
  await page.waitForURL(ON + '/');
  await page.waitForSelector('.team-test-bar');
  check('test mode: the finder shows the test mode bar', (await page.textContent('.team-test-bar')).includes('Test mode') && await page.locator('.team-test-stop').isVisible());
  await page.waitForFunction((n) => true, usageBefore);
  await page.waitForTimeout(300);
  check('test mode: usage events carry the team marker', usageSent.slice(usageBefore).length > 0 && usageSent.slice(usageBefore).every((e) => e.t === PASS), JSON.stringify(usageSent.slice(usageBefore)));
  await chooseMode(page);
  await page.fill('#message', 'I am 20 and anxious in Dewsbury');
  await page.click('#send');
  await page.waitForSelector('.check-summary, .card, .bubble.assistant');
  check('test mode: searches carry the team marker', lastChatHeaders['x-team-test'] === PASS);
  await page.click('.team-test-stop');
  await page.waitForLoadState();
  await page.waitForTimeout(300);
  check('test mode: "Stop test mode" turns it off', !(await page.locator('.team-test-bar').count()) && await page.evaluate(() => !sessionStorage.getItem('hwlTeamTest') && window.HWL_TEAM_TEST === ''));
  const afterStop = usageSent.length;
  await page.reload();
  await page.waitForTimeout(300);
  check('test mode: ...and later events are ordinary again', usageSent.slice(afterStop).every((e) => !('t' in e)));
  await page.goto(ON + '/admin/');
  await page.waitForSelector('#app:not([hidden])');
  await page.goto(ON + '/admin/?next=https://example.org/');
  check('admin: only goes on to Admin pages after signing in', page.url().startsWith(ON + '/admin/') && await page.locator('#app').isVisible());
  await page.goto(ON + '/admin/?next=help.html');
  await page.waitForURL(/\/admin\/help\.html$/);
  check('admin: already signed in, a sign-in link goes straight on', page.url().endsWith('/admin/help.html'));
  check('admin: every page links to the Admin home and the To do list', (await page.locator('.teambar a', { hasText: 'Admin home' }).getAttribute('href')) === './' && (await page.locator('.teambar a', { hasText: 'To do' }).getAttribute('href')) === 'todo.html');
  check('admin: the word MVP is not on the help page', !(await page.content()).includes('MVP'));

  // ---------- help page ----------
  await page.goto(ON + '/admin/help.html');
  await page.waitForSelector('#data-table tbody tr');
  const schemeCount = DATA.length;
  check(`help: data table lists all ${schemeCount} schemes`, (await page.locator('#data-table tbody tr').count()) === schemeCount);
  // Worked out from the data, as the team keeps checking entries and the number goes down.
  const overdue = DATA.filter((x) => (Date.now() - Date.parse(x.lastUpdated + 'T00:00:00')) / 86400000 > 135).length;
  check(`help: overdue entries flagged (${overdue} in the data)`, (await page.locator('#data-table .pill.warn').count()) >= overdue, String(await page.locator('#data-table .pill.warn').count()));
  check('help: not-open schemes flagged', (await page.locator('#data-table .pill.bad').count()) === DATA.filter((x) => !x.open).length);
  check('help: has the key sections', (await page.locator('h2').allTextContents()).join('|').includes('Reporting a problem'));
  check('help: explains keeping the data up to date, with a request to copy', (await page.locator('h2#checks').count()) === 1 && (await page.textContent('#check-request')).includes('service check'));
  await page.click('button[data-copy="#check-request"]');
  check('help: the Copy button responds', /Cop|copy/.test(await page.textContent('button[data-copy="#check-request"]')));

  // ---------- all services page ----------
  await page.goto(ON + '/admin/services.html');
  await page.waitForSelector('.svc');
  check(`services: lists all ${ALL.length} services, including those not on the live list`, (await page.locator('.svc').count()) === ALL.length, String(await page.locator('.svc').count()));
  check('services: live list holds only included services', ALL.length > DATA.length && DATA.every((x) => x.listing.decision === 'include'));
  await page.waitForSelector('.svc .decide');
  check('services: signed in from Admin home, so decision controls shown', !(await page.locator('#signin-form').isVisible()));
  await page.selectOption('#f-listing', 'review');
  check('services: "waiting for review" filter', (await page.locator('.svc').count()) === ALL.filter((x) => x.listing.decision === 'review').length);
  check('services: waiting-for-review badge and reason shown', (await page.locator('.svc .pill.warn', { hasText: 'Waiting for review' }).count()) > 0 && (await page.locator('.svc .listing').first().textContent()).startsWith('Waiting for review:'));
  await page.click('#clear');
  await page.fill('#q', 'gambling');
  await page.waitForTimeout(300);
  const gambling = await page.locator('.svc').count();
  check('services: search narrows the list', gambling > 0 && gambling < schemeCount, String(gambling));
  check('services: search is kept in the address', page.url().includes('q=gambling'));
  await page.click('#clear');
  await page.selectOption('#f-type', 'hwl');
  check('services: HWL filter shows the HWL schemes', (await page.locator('.svc').count()) === ALL.filter((x) => x.hwlFunded).length);
  await page.goto(ON + '/admin/services.html?review=closed');
  await page.waitForSelector('.svc');
  check('services: filters restored from the address (not open)', (await page.locator('.svc').count()) === ALL.filter((x) => !x.open).length);
  check('services: edit link points at the scheme file', /\/edit\/main\/data\/services\/[a-z0-9-]+\.json$/.test(await page.locator('.svc a', { hasText: 'Edit on GitHub' }).first().getAttribute('href')));

  // ---------- log page ----------
  await page.goto(ON + '/admin/log.html');
  check('log: opens straight away, signed in from Admin home', await page.waitForSelector('#app:not([hidden])', { timeout: 5000 }).then(() => true, () => false) && !(await page.locator('#gate').isVisible()));
  check('log: unlocked, starter offer shown on an empty log', await page.waitForSelector('#starter:not([hidden])', { timeout: 5000 }).then(() => true, () => false));
  await page.click('#load-starter');
  await page.waitForSelector('#list .entry');
  check('log: starter list loaded (14 open shown, 1 done hidden)', (await page.locator('#list .entry').count()) === 14, String(await page.locator('#list .entry').count()));
  check('log: starter offer hides once loaded', !(await page.locator('#starter').isVisible()));
  const stats = await page.locator('#summary .stat').allTextContents();
  check('log: summary shows 4 open high-priority items', stats.some((s) => s.includes('High priority open') && s.startsWith('4')), stats.join(' | '));
  check('log: high priority sorted first', (await page.locator('#list .entry').first().getAttribute('class')).includes('pri-High'));

  await page.selectOption('#flt-status', 'all');
  check('log: "Everything" shows all 15', (await page.locator('#list .entry').count()) === 15);
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
  check('log: new entry saved and listed', (await page.locator('#list .entry').count()) === 16);
  check('log: new entry form closes', !(await page.locator('#form').isVisible()));

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  check('log: CSV downloaded with a sensible name', /^support-finder-log-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  check('log: CSV has header and 16 rows', csv.includes('"ID","Type","Title"') && csv.trim().split(/\r?\n/).length >= 17);
  check('log: CSV neutralises a leading "=" (formula injection)', csv.includes("\"'=HYPERLINK"), csv.slice(0, 200));

  await page.reload();
  await page.waitForSelector('#app:not([hidden])');
  check('log: stays unlocked on reload (this tab only)', await page.waitForSelector('#list .entry', { timeout: 5000 }).then(() => true, () => false));
  // suggested entries: offered, added in one go, note appended to #12, not offered again
  await page.waitForSelector('#suggested:not([hidden])');
  check('log: suggested entries are offered', (await page.textContent('#suggested')).includes('Data freshness') && (await page.textContent('#suggested')).includes('12 new entries'), await page.textContent('#suggested'));
  await page.selectOption('#flt-status', 'all');
  const before = await page.locator('#list .entry').count();
  await page.locator('#suggested button').first().click();
  for (let i = 0; i < 50 && (await page.locator('#list .entry').count()) !== before + 12; i++) await page.waitForTimeout(200);
  check('log: 12 suggested entries added', (await page.locator('#list .entry').count()) === before + 12);
  await page.waitForSelector('#suggested:not([hidden])');
  check('log: the urgent-support pack is still offered', (await page.textContent('#suggested')).includes('Urgent support') && (await page.textContent('#suggested')).includes('2 new entries'), await page.textContent('#suggested'));
  await page.locator('#suggested button').first().click();
  for (let i = 0; i < 50 && (await page.locator('#list .entry').count()) !== before + 14; i++) await page.waitForTimeout(200);
  check('log: 2 urgent-support entries added', (await page.locator('#list .entry').count()) === before + 14);

  await page.waitForSelector('#suggested:not([hidden])');
  check('log: the October import pack is still offered', (await page.textContent('#suggested')).includes('October 2026 import') && (await page.textContent('#suggested')).includes('22 new entries'), await page.textContent('#suggested'));
  await page.locator('#suggested button').first().click();
  await page.locator('#suggested').waitFor({ state: 'hidden' });
  for (let i = 0; i < 50 && (await page.locator('#list .entry').count()) !== before + 36; i++) await page.waitForTimeout(200);
  check('log: 22 import-check entries added', (await page.locator('#list .entry').count()) === before + 36);
  check('log: freshness entries have their details', (await page.locator('#list .entry', { hasText: 'option B: AI-assisted' }).locator('.details').textContent()).includes('15p to 35p'));
  check('log: note appended to the existing "keep the data fresh" entry', (await page.locator('#list .entry', { hasText: 'Keep the data fresh automatically' }).locator('summary').textContent()).includes('(1)'));
  await page.reload();
  await page.waitForSelector('#list .entry');
  check('log: suggestions are not offered twice', !(await page.locator('#suggested').isVisible()));

  // ---------- listing decisions on the All services page (signed in from the log, same tab) ----------
  await page.goto(ON + '/admin/services.html?listing=review&q=samaritans');
  await page.waitForSelector('#signed-in:not([hidden])');
  check('decide: signed in via the log passcode in this tab', (await page.textContent('#signed-in-text')).includes('0 decisions, 0 edited services and 0 new services'), await page.textContent('#signed-in-text'));
  await page.waitForSelector('.svc .decide');
  check('decide: decision controls shown', (await page.locator('#svc-samaritans-helpline .decide input[type=radio]').count()) === 4);
  check('decide: planned dates hidden until planned is chosen', !(await page.locator('#svc-samaritans-helpline .planned-fields').isVisible()));
  await page.check('#svc-samaritans-helpline .decide input[value=planned]');
  check('decide: choosing planned asks when it is expected', await page.locator('#exp-samaritans-helpline').isVisible() && await page.locator('#chk-samaritans-helpline').isVisible());
  await page.check('#svc-samaritans-helpline .decide input[value=include]');
  check('decide: and hides it again for another choice', !(await page.locator('#svc-samaritans-helpline .planned-fields').isVisible()));
  await page.fill('#by', '');
  await page.check('#svc-samaritans-helpline input[value=exclude]');
  await page.click('#svc-samaritans-helpline .decide button');
  check('decide: needs a name first', (await page.textContent('#svc-samaritans-helpline .decide .msg[role=status]')).includes('name'));
  await page.fill('#by', 'TB');
  await page.click('#svc-samaritans-helpline .decide button');
  check('decide: exclude needs a reason', (await page.textContent('#svc-samaritans-helpline .decide .msg[role=status]')).includes('why'));
  await page.fill('#note-samaritans-helpline', 'The crisis panel covers this');
  await page.click('#svc-samaritans-helpline .decide button');
  await page.waitForSelector('#svc-samaritans-helpline .pill.blue >> text=waiting to be applied');
  check('decide: saved and shown as waiting to be applied', decisions['samaritans-helpline'] && decisions['samaritans-helpline'].decision === 'exclude' && decisions['samaritans-helpline'].by === 'TB');
  check('decide: "Saved." confirmation', (await page.textContent('#svc-samaritans-helpline .decide .msg[role=status]')).includes('Saved'));
  // an incomplete service: choosing include warns that it can't go live yet
  await page.goto(ON + '/admin/services.html?q=lukes-lads-tcd');
  await page.waitForSelector('#svc-lukes-lads-tcd .decide');
  await page.check('#svc-lukes-lads-tcd input[value=include]');
  check('decide: warns when an incomplete service is chosen for the live list', await page.locator('#svc-lukes-lads-tcd .decide .msg.info').isVisible());
  await page.click('#svc-lukes-lads-tcd .decide button');
  await page.waitForSelector('#svc-lukes-lads-tcd .pill.blue');

  // ---------- adding a new service ----------
  await page.goto(ON + '/admin/services.html');
  await page.waitForSelector('#add-service:not([hidden])');
  await page.click('#add-service');
  await page.waitForSelector('#add-panel form');
  await page.fill('#ed-new-service-name', 'Acas Helpline');
  check('add: id made from the name', (await page.inputValue('#ed-new-service-newid')) === 'acas-helpline');
  await page.fill('#ed-new-service-newid', 'batley-job-club');
  await page.fill('#ed-new-service-organisation', 'Batley Community Centre');
  await page.fill('#ed-new-service-whoFor', 'Anyone in Batley looking for work.');
  await page.check('#ed-new-service-categories input[value="Finding work"]');
  await page.check('#ed-new-service-areas input[value=Batley]');
  check('add: the form is in three parts, all on one page for the team', (await page.locator('#add-panel .lf-part').count()) === 3 && (await page.locator('#add-panel .lf-part-title').allTextContents()).join('|') === 'Part 1: The service and who can join|Part 2: Contact and how people get in|Part 3: Activities and timetable' && (await page.locator('#add-panel .lf-steps').count()) === 0);
  // Who can use it: where they live (certain parts warns who won't see it), health, work situation, age.
  await page.locator('#ed-new-service-residence input[value=parts]').check();
  await page.locator('#ed-new-service-residence-areas input[value=Batley]').check();
  check('add: "certain parts of Kirklees" says who won\'t be shown it', (await page.textContent('#ed-new-service-residence .lf-warn')).includes("won't be shown this service") && (await page.textContent('#ed-new-service-residence .lf-warn')).includes('Dewsbury'));
  await page.locator('#ed-new-service-work input[value=yes]').check();
  await page.locator('#ed-new-service-work label:has-text("Claiming certain benefits") input').check();
  await page.locator('#ed-new-service-work-benefits label:has-text("Universal Credit, any") input').check();
  await page.fill('#ed-new-service-agemin', '18+');
  check('add: age boxes take numbers only, and fill in the words for the card', (await page.inputValue('#ed-new-service-agemin')) === '18' && (await page.inputValue('#ed-new-service-age')) === '18+');
  check('add: eligibility shows the answers from above', (await page.locator('#add-panel .lf-fromabove .lf-above').allTextContents()).join('|') === 'People living in BatleyFrom above Essential|Work situation: Claiming Universal Credit, anyFrom above Essential|Age: 18+From above Essential', (await page.locator('#add-panel .lf-fromabove .lf-above').allTextContents()).join('|'));
  // How people get in: no referral needed, so the ways in are optional.
  await page.locator('#ed-new-service-referral input[value=no]').check();
  check('add: with no referral needed, the box asks how people sign up', (await page.textContent('#add-panel [data-key=referralRoutes] .lf-lab')) === 'How people sign up or book, if they need to' && !(await page.locator('#ed-new-service-referral-who').isVisible()));
  await page.locator('#add-panel [data-key=referralRoutes] .lf-line input').first().fill('Drop in');
  check('add: the organisation box suggests organisations already listed', (await page.locator('#add-panel datalist option').count()) > 100);
  check('add: a new organisation name is accepted and shown as new', (await page.textContent('#add-panel .lf-match')).includes('new organisation'));
  await page.locator('#add-panel .lf-proj input[type=text]').first().fill('Job club');
  await page.locator('#add-panel .lf-proj textarea').first().fill('CV help and job search.');
  await page.locator('#add-panel .lf-proj fieldset[data-key=cohorts] input[value=no]').check();
  await page.locator('#add-panel .lf-plain-block .lf-dates input[type=date]').nth(2).fill('2027-02-01');
  await page.locator('#add-panel .lf-plain-block .lf-dates input[type=date]').nth(3).fill('2027-01-01');
  await page.fill('#ed-new-service-why', 'Suggested by a work coach');
  await page.click('#add-panel button[type=submit]');
  check('add: an activity that ends before it starts is caught', (await page.textContent('#add-panel .msg')).includes('ends before it starts'), await page.textContent('#add-panel .msg'));
  await page.locator('#add-panel .lf-plain-block .lf-dates input[type=date]').nth(3).fill('');
  check('add: the timetable shows once "At set times and places" is ticked', !(await page.locator('#add-panel .lf-plain-block .lf-sessions-box').isVisible()));
  await page.locator('#add-panel .lf-runs label:has-text("At set times and places") input').check();
  check('add: ...with a first time and place ready to fill in', await page.locator('#add-panel .lf-plain-block .lf-sessions-box').isVisible() && (await page.locator('#add-panel .lf-session').count()) === 1);
  const sess = page.locator('#add-panel .lf-session').first();
  await sess.getByLabel('Place', { exact: true }).fill('Batley Library');
  check('add: a place we don\'t list asks for its address and postcode', await sess.locator('.lf-newvenue').isVisible() && (await sess.getByLabel('Name of the place', { exact: true }).inputValue()) === 'Batley Library');
  await sess.getByLabel('Address', { exact: true }).fill('Market Place, Batley');
  await sess.getByLabel('Full postcode', { exact: true }).fill('WF17');
  await sess.locator('.lf-days label:has-text("Tue") input').check();
  await sess.getByLabel('From', { exact: true }).fill('10:00');
  await sess.getByLabel('Until', { exact: true }).fill('12:00');
  check('add: "How often" starts at every week', (await sess.getByLabel('How often', { exact: true }).inputValue()) === 'weekly');
  await page.click('#add-panel button[type=submit]');
  check('add: a new place needs its full postcode', (await page.textContent('#add-panel .msg')).includes('full postcode'), await page.textContent('#add-panel .msg'));
  await sess.getByLabel('Full postcode', { exact: true }).fill('wf17 5da');
  // Cohorts: each needs a name; it is labelled with it.
  await page.locator('#add-panel .lf-proj fieldset[data-key=cohorts] input[value=yes]').check();
  const grp = page.locator('#add-panel .lf-cohort').first();
  check('add: "Are there different cohorts?" Yes adds a cohort', (await page.locator('#add-panel .lf-cohort').count()) === 1 && (await grp.locator('legend').first().textContent()) === 'Cohort' && !(await page.locator('#add-panel .lf-plain-block').isVisible()));
  await page.click('#add-panel button[type=submit]');
  check('add: a cohort needs a name', (await page.textContent('#add-panel .msg')).includes('give each cohort a name'), await page.textContent('#add-panel .msg'));
  await grp.getByLabel('Name of the cohort (mandatory)', { exact: true }).fill('Cohort 1: ages 18 to 24');
  check('add: the cohort is labelled with its name', (await grp.locator('legend').first().textContent()) === 'Cohort: Cohort 1: ages 18 to 24');
  await grp.locator('fieldset[data-key=cohort-open] input[value=no]').check();
  await grp.getByLabel('Age for this cohort', { exact: true }).fill('16 to 24');
  await page.click('#add-panel button[type=submit]');
  check('add: a cohort can only narrow the service\'s age', (await page.textContent('#add-panel .msg')).includes('can only narrow'), await page.textContent('#add-panel .msg'));
  await grp.locator('button:text-is("Remove this cohort")').click();
  await page.locator('#add-panel .lf-proj fieldset[data-key=cohorts] input[value=no]').check();
  await page.fill('#ed-new-service-why', 'Suggested by a work coach');
  await page.click('#add-panel button[type=submit]');
  check('add: warns about a possible duplicate first', (await page.textContent('#add-panel .msg')).includes('may already be listed') && (await page.textContent('#add-panel .msg')).includes('Acas helpline'), await page.textContent('#add-panel .msg'));
  await page.fill('#ed-new-service-name', 'Batley Job Club');
  await page.click('#add-panel button[type=submit]');
  await page.waitForSelector('#svc-batley-job-club');
  check('add: saved to the Worker as a whole service', added['batley-job-club'] && added['batley-job-club'].service.areas.join() === 'Batley' && added['batley-job-club'].service.name === 'Batley Job Club');
  const np = added['batley-job-club'].service.projects;
  check('add: the activity and time and place are saved with ids made from their names, the start date, the day and times, and the new place written out', np.length === 1 && np[0].id === 'job-club' && np[0].runsFrom === '2027-02-01' && !np[0].runsTo && np[0].runs.join() === 'set' && JSON.stringify(np[0].sessions) === JSON.stringify([{ id: 'batley-library-tue', venue: { name: 'Batley Library', address: 'Market Place, Batley', postcode: 'WF17 5DA' }, days: ['tue'], start: '10:00', end: '12:00' }]), JSON.stringify(np));
  const ns = added['batley-job-club'].service;
  check('add: the new answers are saved: where they live, work situation, age and referral', JSON.stringify(ns.residence) === '{"scope":"parts","areas":["Batley"]}' && JSON.stringify(ns.work) === '{"needed":"yes","situations":["benefits"],"benefits":["Universal Credit, any"]}' && ns.ageMin === 18 && ns.ageMax === null && ns.age === '18+' && JSON.stringify(ns.referral) === '{"needed":"no"}' && ns.selfReferral.allowed === 'yes', JSON.stringify({ r: ns.residence, w: ns.work, a: [ns.ageMin, ns.ageMax, ns.age], rf: ns.referral, sr: ns.selfReferral }));
  check('add: listed as new, with the "new" filter on', (await page.locator('.svc').count()) === 1 && (await page.inputValue('#f-listing')) === 'new' && (await page.locator('#svc-batley-job-club .pill.blue', { hasText: 'New: not yet in the data' }).count()) === 1);
  check('add: can be decided on like any other', (await page.locator('#svc-batley-job-club .decide input[type=radio]').count()) === 4);
  await page.check('#svc-batley-job-club input[value=include]');
  await page.click('#svc-batley-job-club .decide button');
  await page.waitForSelector('#svc-batley-job-club .pill.blue >> text=waiting to be applied');
  check('add: decision recorded for the new service', decisions['batley-job-club'] && decisions['batley-job-club'].decision === 'include');
  await page.click('#svc-batley-job-club .edit-open button:has-text("Edit details")');
  await page.waitForSelector('#svc-batley-job-club form');
  check('add: editing a new service starts from what was saved', (await page.inputValue('#ed-batley-job-club-whoFor')) === 'Anyone in Batley looking for work.');
  await page.fill('#ed-batley-job-club-phone', '01924 000000');
  await page.click('#svc-batley-job-club form button[type=submit]');
  await page.waitForSelector('#svc-batley-job-club .msg.ok');
  check('add: edits to a new service update it, not a separate edit', added['batley-job-club'].service.phone === '01924 000000' && !edits['batley-job-club']);
  check('add: summary counts new services', (await page.locator('#summary .stat').allTextContents()).some((x) => x.startsWith('1') && x.includes('new services waiting to be added')));
  await page.reload();
  await page.waitForSelector('#svc-batley-job-club');
  check('add: still there after reloading (from the Worker)', (await page.locator('#svc-batley-job-club').count()) === 1);
  page.once('dialog', (d) => d.accept());
  await page.click('#svc-batley-job-club button:has-text("Discard this new service")');
  await page.waitForSelector('#svc-batley-job-club', { state: 'detached' });
  check('add: a new service can be discarded', !added['batley-job-club']);
  delete decisions['batley-job-club'];

  await page.goto(ON + '/admin/services.html?decision=pending');
  await page.waitForSelector('.svc');
  check('decide: "waiting to be applied" filter shows both decisions', (await page.locator('.svc').count()) === 2, String(await page.locator('.svc').count()));
  const sStats = await page.locator('#summary .stat').allTextContents();
  check('decide: summary counts decisions waiting to be applied', sStats.some((x) => x.startsWith('2') && x.includes('waiting to be applied')), sStats.join(' | '));
  const [dd] = await Promise.all([page.waitForEvent('download'), page.click('#export-decisions')]);
  const saved = JSON.parse(fs.readFileSync(await dd.path(), 'utf8'));
  check('decide: decisions download for apply-decisions', saved.decisions['lukes-lads-tcd'].decision === 'include' && saved.decisions['samaritans-helpline'].decision === 'exclude' && 'edits' in saved);

  // ---------- editing a service's details ----------
  await page.goto(ON + '/admin/services.html?q=lukes-lads-tcd');
  await page.waitForSelector('#svc-lukes-lads-tcd .edit-open button');
  await page.click('#svc-lukes-lads-tcd .edit-open button');
  await page.waitForSelector('#svc-lukes-lads-tcd form.edit-form');
  check('edit: form starts from the data', (await page.inputValue('#ed-lukes-lads-tcd-name')) === "Luke's Lads" && (await page.inputValue('#ed-lukes-lads-tcd-level')) === 'local');
  check('edit: "To be completed" boxes highlighted', (await page.locator('#svc-lukes-lads-tcd .edit .tbc').count()) >= 3, String(await page.locator('#svc-lukes-lads-tcd .edit .tbc').count()));
  await page.click('#svc-lukes-lads-tcd form.edit-form button[type=submit]');
  check('edit: nothing changed is caught', (await page.textContent('#svc-lukes-lads-tcd .edit .msg')).includes('Nothing has changed'));
  await page.fill('#ed-lukes-lads-tcd-phone', '01484 000000');
  await page.fill('#ed-lukes-lads-tcd-whoFor', 'Adults in Kirklees with complex needs.');
  await page.check('#ed-lukes-lads-tcd-areas input[value=Batley]');
  await page.locator('#svc-lukes-lads-tcd .lf-proj textarea').first().fill('One-to-one key worker support.');
  check('edit: changed questions are marked', (await page.locator('#svc-lukes-lads-tcd .lf-field.changed').count()) >= 2 && (await page.locator('#svc-lukes-lads-tcd .lf-projects-box.changed').count()) === 1);
  await page.click('#svc-lukes-lads-tcd form.edit-form button[type=submit]');
  check('edit: needs a reason', (await page.textContent('#svc-lukes-lads-tcd .edit .msg')).includes('what changed'));
  await page.fill('#ed-lukes-lads-tcd-why', 'Phoned the provider');
  await page.check('#ed-lukes-lads-tcd-checked');
  await page.click('#svc-lukes-lads-tcd form.edit-form button[type=submit]');
  await page.waitForSelector('#svc-lukes-lads-tcd .waiting');
  const sent = edits['lukes-lads-tcd'];
  check('edit: ticking an area keeps the existing order and adds it last', JSON.stringify(sent.changes.areas) === JSON.stringify([...ALL.find((x) => x.id === 'lukes-lads-tcd').areas, 'Batley']), JSON.stringify(sent.changes.areas));
  check('edit: categories untouched are not sent (order kept)', !('categories' in sent.changes));
  check('edit: only the changed fields are sent, with what the data said', sent && Object.keys(sent.changes).sort().join() === 'areas,phone,projects,whoFor' && sent.before.phone === null && sent.checked === true && sent.by === 'TB', JSON.stringify(sent && sent.changes));
  check('edit: waiting changes shown, old and new', (await page.textContent('#svc-lukes-lads-tcd .waiting')).includes('01484 000000') && (await page.locator('#svc-lukes-lads-tcd .waiting del').count()) === 4);
  check('edit: badge says it is waiting to be applied', (await page.locator('#svc-lukes-lads-tcd .pill.blue', { hasText: 'Details edited by TB' }).count()) === 1);
  await page.click('#svc-lukes-lads-tcd .edit-open button');
  await page.waitForSelector('#svc-lukes-lads-tcd form.edit-form');
  check('edit: editing again starts from the waiting changes', (await page.inputValue('#ed-lukes-lads-tcd-phone')) === '01484 000000');
  await page.click('#svc-lukes-lads-tcd .edit button:has-text("Cancel")');
  await page.goto(ON + '/admin/services.html?decision=edited');
  await page.waitForSelector('.svc');
  check('edit: "details edited" filter', (await page.locator('.svc').count()) === 1);
  page.once('dialog', (d) => d.accept());
  await page.click('#svc-lukes-lads-tcd .waiting button');
  await page.waitForSelector('#svc-lukes-lads-tcd .waiting', { state: 'detached' });
  check('edit: waiting changes can be discarded', !edits['lukes-lads-tcd']);

  // ---------- organisations ----------
  await page.click('#open-orgs');
  await page.waitForSelector('#orgs-panel:not([hidden]) .org');
  check('orgs: the panel lists organisations', (await page.locator('#orgs-panel details.org').count()) > 0);
  // Any organisation will do (the real ones get combined and renamed over time).
  const pj = page.locator('#orgs-panel details.org').first();
  await pj.locator('summary').click();
  await pj.locator('textarea').first().fill('A theatre company. Runs Healthy Working Life projects.');
  await pj.locator('textarea').last().fill('Same organisation');
  await pj.locator('button:has-text("Save organisation changes")').click();
  check('orgs: an overview mentioning Healthy Working Life is refused (it belongs on the service)', (await pj.locator('.msg').textContent()).includes('Healthy Working Life'));
  await pj.locator('textarea').first().fill('');
  const target = await pj.locator('select option').nth(1).getAttribute('value');
  const targetName = await pj.locator('select option').nth(1).textContent();
  await pj.locator('select').selectOption(target);
  page.once('dialog', (d) => d.accept());
  await pj.locator('button:has-text("Save organisation changes")').click();
  await page.waitForSelector('#orgs-panel .waiting');
  const oc = Object.values(orgs)[0];
  check('orgs: the waiting count includes organisation changes', /1 organisation change waiting/.test(await page.textContent('#apply-pending').catch(() => '')) || !(await page.locator('#apply-now').isVisible()));
  check('orgs: combining is saved as a change waiting to be applied', oc && oc.changes.mergeInto === target && oc.by === 'TB' && (await page.textContent('#orgs-panel .waiting')).includes('combine into ' + targetName), JSON.stringify(orgs));
  page.once('dialog', (d) => d.accept());
  await page.click('#orgs-panel .waiting button:has-text("Discard")');
  await page.waitForSelector('#orgs-panel .waiting', { state: 'detached' });
  check('orgs: a waiting organisation change can be discarded', !Object.keys(orgs).length);
  await page.click('#orgs-panel button:has-text("Close organisations")');

  // ---------- venues ----------
  await page.click('#open-venues');
  await page.waitForSelector('#venues-panel:not([hidden]) .venue');
  check('venues: the panel lists venues and postcodes shared by more than one venue', (await page.locator('#venues-panel details.venue').count()) > 0 && (await page.textContent('#venues-panel')).includes('postcodes shared by more than one venue'));
  await page.fill('#venue-q', 'WF12 8DJ');
  check('venues: search finds venues by postcode', (await page.locator('#venues-panel details.venue').count()) >= 3);
  const ev = page.locator('#venues-panel details.venue').first();
  await ev.locator('summary').click();
  await ev.locator('select').selectOption({ index: 1 });
  await ev.locator('textarea').last().fill('Same building');
  page.once('dialog', (d) => d.accept());
  await ev.locator('button:has-text("Save venue changes")').click();
  await page.waitForSelector('#venues-panel .waiting');
  const vc = Object.values(venueEdits)[0];
  check('venues: combining is saved as a change waiting to be applied', vc && vc.changes.mergeInto && vc.by === 'TB' && (await page.textContent('#venues-panel .waiting')).includes('combine into'), JSON.stringify(venueEdits));
  page.once('dialog', (d) => d.accept());
  await page.click('#venues-panel .waiting button:has-text("Discard")');
  await page.waitForSelector('#venues-panel .waiting', { state: 'detached' });
  check('venues: a waiting venue change can be discarded', !Object.keys(venueEdits).length);
  await page.click('#venues-panel button:has-text("Close venues")');

  // ---------- "Apply changes now": what the last run couldn't apply ----------
  // Luke's Lads is chosen for the live list (above) but its details still say "To be completed", so the run sets it aside.
  // The run is "now": after the decision above, which it couldn't apply. (A fixed minute ago made this depend on how
  // long the steps in between took: under a minute and the decision looked newer than the run, so wasn't shown.)
  const ranAt = new Date().toISOString();
  const lastRun = { id: 9, status: 'completed', conclusion: 'success', created: ranAt, updated: ranAt, title: 'Apply team changes and put them live (from the All services page, TB)', url: 'https://github.com/run' };
  const waitingNow = async () => Number(((await page.textContent('#apply-pending')).match(/^(\d+) services? ha/) || [0, 0])[1]);
  applyStatus = { on: true, apply: lastRun, site: null, worker: null, report: { run: 9, setAside: [] } };
  await page.reload();
  await page.waitForSelector('#apply-now:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#apply-pending').textContent.length > 0);
  const waitBefore = await waitingNow();
  applyStatus = { ...applyStatus, report: { run: 9, setAside: [{ kind: 'service', id: 'lukes-lads-tcd', name: "Luke's Lads", by: 'TB', why: 'chosen to go on the live list, but its details still say "To be completed"' }] } };
  await page.reload();
  await page.waitForSelector('#apply-aside:not([hidden])');
  const asideText = await page.textContent('#apply-aside');
  check('apply: what the last run couldn\'t apply is listed, with why', asideText.includes('1 change couldn\u2019t be applied') && asideText.includes("Luke's Lads") && asideText.includes('To be completed'), asideText);
  check('apply: those aren\'t counted as waiting', (await waitingNow()) === waitBefore - 1 && (await page.textContent('#apply-pending')).includes('couldn\u2019t be applied'), waitBefore + " / " + (await page.textContent('#apply-pending')));
  await page.click('#apply-aside a:has-text("Luke\'s Lads")');
  check('apply: the link opens that service', await page.locator('#svc-lukes-lads-tcd details').evaluate((d) => d.open).catch(() => false));
  applyStatus = null;
  // ---------- "Checked with the provider" filter ----------
  const soon = new Date(Date.now() + 20 * 864e5).toISOString();
  const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
  providerLinks = [
    { id: 'my-way-forward', token: 'a'.repeat(32), contact: 'Sam', by: 'TB', created: ago(3), expires: soon, replies: [] },
    { id: 'acas-helpline', token: 'b'.repeat(32), contact: 'Jo', by: 'TB', created: ago(3), expires: soon, replies: [{ name: 'Jo', t: ago(1), allCorrect: true, note: '', changes: {} }] },
  ];
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#signed-in').hidden);
  await page.click('#clear');
  const shown = async (v) => { await page.selectOption('#f-provider', v); return page.locator('.svc').evaluateAll((a) => a.map((e) => e.id.slice(4))); };
  let ids = await shown('sent');
  check('provider filter: sent shows the services with a review link', ids.length === 2 && ids.includes('my-way-forward') && ids.includes('acas-helpline'), ids.join());
  ids = await shown('no-reply');
  check('provider filter: sent, no reply yet', ids.length === 1 && ids[0] === 'my-way-forward', ids.join());
  ids = await shown('replied');
  check('provider filter: replied', ids.length === 1 && ids[0] === 'acas-helpline', ids.join());
  ids = await shown('reply-waiting');
  check('provider filter: a reply the team hasn\'t dealt with yet', ids.length === 1 && ids[0] === 'acas-helpline', ids.join());
  await page.click('#svc-acas-helpline summary');
  await page.waitForSelector('#svc-acas-helpline .provider .reply');
  check('all services: a provider\'s reply comes with a pilot invitation to copy', (await page.locator('#svc-acas-helpline .provider button:text-is("Copy a pilot invitation email")').count()) === 1);
  ids = await shown('not-sent');
  const liveNot = await shown('live-not-sent');
  check('provider filter: not sent leaves those two out, and live-not-sent is part of it', !ids.includes('my-way-forward') && !ids.includes('acas-helpline') && liveNot.length > 0 && liveNot.length < ids.length && liveNot.every((i) => ids.includes(i)), ids.length + ' / ' + liveNot.length);
  check('provider filter: kept in the address', new URL(page.url()).searchParams.get('provider') === 'live-not-sent');
  await page.selectOption('#f-provider', '');
  providerLinks = [];

  // ---------- Across Kirklees (commissioner view) ----------
  await page.goto(ON + '/admin/commissioner.html');
  await page.waitForSelector('#stats .stat');
  const cmStats = await page.locator('#stats .stat').allTextContents();
  check('across: counts the live list (services, sessions, venues)', cmStats.length === 5 && Number(cmStats[0].match(/\d+/)[0]) > 100, cmStats.join(' | '));
  await page.selectOption('#f-group', 'women');
  const womenCount = Number((await page.locator('#stats .stat').first().textContent()).match(/\d+/)[0]);
  check('across: the "Who it\'s for" filter narrows the services', womenCount < Number(cmStats[0].match(/\d+/)[0]), String(womenCount));
  await page.click('#f-reset');
  await page.click('#tab-week');
  check('across: the timetable has a column for each day and lists what has no day yet', (await page.locator('#view-week .cm-day').count()) === 7 && (await page.textContent('#view-week')).includes('No day given'));
  await page.click('#tab-wards');
  check('across: by ward shows services with no venue separately, never as a gap', (await page.textContent('#view-wards')).includes('(No venue given)'));
  await page.click('#tab-gaps');
  check('across: says how much data is still to collect', /services haven't ticked who they're for/.test(await page.textContent('#view-gaps')));
  const [cmDl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const cmCsv = fs.readFileSync(await cmDl.path(), 'utf8');
  check('across: the timetable downloads as a spreadsheet, one row per session', cmCsv.startsWith('"Service","Organisation"') && cmCsv.split('\r\n').length > 100);
  await page.goto(ON + '/admin/services.html?decision=pending');
  await page.waitForSelector('.svc');
  const [dc] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  const csv2 = fs.readFileSync(await dc.path(), 'utf8');
  check('decide: CSV includes the live list and team decision', csv2.includes('"Live list"') && csv2.includes('"Exclude completely"'), csv2.slice(0, 600));
  await page.click('#lock');
  await page.waitForURL(/\/admin\/\?next=services\.html/);
  check('decide: signing out goes back to Admin home to sign in', await page.locator('#gate').isVisible() && (await page.locator('.decide').count()) === 0);
  await page.goto(ON + '/admin/log.html');
  await page.waitForURL(/\/admin\/\?next=log\.html$/);
  check('log: signed out, the log asks you to sign in first', await page.locator('#gate').isVisible());
  await page.fill('#pass', PASS);
  await page.click('#unlock');
  await page.waitForURL(/\/admin\/log\.html$/);
  check('log: after signing in you are taken back to the log', await page.waitForSelector('#app:not([hidden])', { timeout: 5000 }).then(() => true, () => false));

  await page.click('#lock');
  await page.waitForURL(/\/admin\/\?next=log\.html$/);
  check('log: lock returns to the sign-in', await page.locator('#gate').isVisible());
  await page.reload();
  check('log: still locked after reload', await page.locator('#gate').isVisible() && !(await page.locator('#app').isVisible()));

  // ---------- User feedback review page ----------
  await page.goto(ON + '/admin/feedback.html');
  await page.waitForURL(/\/admin\/\?next=feedback\.html$/);
  await page.fill('#pass', 'wrong');
  await page.click('#unlock');
  await page.waitForTimeout(200);
  check('review: wrong passcode refused', (await page.textContent('#gate-msg')).includes('not right') && !(await page.locator('#app').isVisible()));
  await page.fill('#pass', FB_PASS);
  await page.click('#unlock');
  await page.waitForURL(/\/admin\/feedback\.html$/);
  await page.waitForSelector('#app:not([hidden])');
  check('review: team bar marks the page', (await page.locator('.teambar a[aria-current="page"]').textContent()) === 'Feedback and usage');
  check('review: starts at "Since live testing started", showing delivery partners and the public', (await page.inputValue('#period')) === 'live' && (await page.inputValue('#source')) === 'real');
  await page.selectOption('#period', '30');
  await page.waitForSelector('#usage .stat');
  const usStats = await page.locator('#usage > .summary .stat b').allTextContents();
  check('review: usage shows real use only', usStats[2] === '4', usStats.join());
  check('review: the team testing AI cost is noted under real use', (await page.textContent('#usage')).includes('Admin team testing in this period used another 2 AI calls'));
  const fbStats = await page.locator('#summary .stat b').allTextContents();
  check('review: totals (75% helpful, 3 yes, 1 no, 1 listing problem, 1 missing)', fbStats.slice(0, 5).join() === '75%,3,1,1,1', fbStats.join());
  check('review: list hides plain Yes answers', (await page.locator('#list .entry').count()) === 3);
  check('review: team test feedback is not in the real list', !(await page.textContent('#list')).includes('Team test entry'));
  await page.selectOption('#source', 'team');
  check('review: "Admin team testing" shows only test mode feedback, labelled', (await page.locator('#list .entry').count()) === 1 && (await page.textContent('#list')).includes('Team test entry') && (await page.locator('#list .pill:text-is("Team test")').count()) === 1);
  check('review: ...and only test mode usage', (await page.locator('#usage > .summary .stat b').allTextContents())[2] === '2' && (await page.textContent('#usage')).includes('Showing Admin team testing only'));
  await page.selectOption('#source', 'real');
  check('review: shows scheme names, not ids', (await page.textContent('#list')).includes('My Way Forward'));
  const sugText = await page.locator('#list .entry:has(#st-6)').textContent();
  check('review: a suggestion shows who sent it and the details they gave', sugText.includes('Someone from the service') && sugText.includes('6 details') && sugText.includes('Peer group: Where and when: Jo Cox House, Tuesdays 1pm to 3pm.') && sugText.includes('Women') && !sugText.includes('[object Object]') && sugText.includes('Test Trust') && sugText.includes('01924 000000') && sugText.includes('No, needs a referral') && sugText.includes('Employers'), sugText);
  await page.locator('#list .entry').first().locator('select').selectOption('Actioned');
  await page.waitForTimeout(200);
  check('review: status change is saved', fbStore.find((x) => x.id === 6).status === 'Actioned');
  const fbDl = page.waitForEvent('download');
  await page.click('#export');
  check('review: CSV download', (await fbDl).suggestedFilename().endsWith('.csv'));
  await page.selectOption('#flt-kind', 'provider');
  await page.selectOption('#flt-status', '');
  check('review: filter for services sent in by the service itself', (await page.locator('#list .entry').count()) === 1);
  await page.locator('#list .entry:has(#st-6) button:text-is("Start a new listing from this")').click();
  await page.waitForSelector('#add-panel:not([hidden]) form.edit-form');
  const draftVal = (k) => page.locator('#add-panel #' + CSS_ID('ed-new-service-' + k)).inputValue();
  check('review: "Start a new listing" opens Add a service on All services, filled in from the suggestion', (await draftVal('name')) === 'A test service' && (await draftVal('organisation')) === 'Test Trust' && (await draftVal('phone')) === '01924 000000' && (await draftVal('newid')) === 'a-test-service' && (await page.locator('#add-panel .from-suggestion').isVisible()) && (await draftVal('why')).includes('feedback #6'));
  check('review: the draft is used once and not left in the browser', await page.evaluate(() => sessionStorage.getItem('hwl-listing-draft') === null));
  await page.locator('#add-panel button:text-is("Cancel")').click();

  // ---------- one sign-in for every Admin page ----------
  check('one sign-in: team bar says signed in', (await page.textContent('.teambar .team-auth')).includes('Signed in'));
  await page.goto(ON + '/admin/log.html');
  check('one sign-in: the log opens without asking again', await page.waitForSelector('#app:not([hidden])', { timeout: 5000 }).then(() => true, () => false) && !(await page.locator('#gate').isVisible()));
  await page.goto(ON + '/admin/services.html');
  check('one sign-in: All services is signed in without asking again', await page.waitForSelector('#signed-in:not([hidden])', { timeout: 5000 }).then(() => true, () => false));
  await page.goto(ON + '/admin/help.html');
  check('one sign-in: the help page shows it too', (await page.textContent('.teambar .team-auth')).includes('Signed in'));
  await page.click('.teambar .team-auth button');
  await page.waitForURL(/\/admin\/\?next=help\.html$/);
  check('one sign-in: signing out in the team bar goes back to sign in', (await page.textContent('.teambar .team-auth')).includes('Not signed in') && await page.locator('#gate').isVisible());
  await page.goto(ON + '/admin/feedback.html');
  await page.waitForURL(/\/admin\/\?next=feedback\.html$/);
  check('one sign-in: ...and signs out of every page', await page.locator('#gate').isVisible() && !(await page.locator('#app').isVisible()));
  check('one sign-in: the sign-in box explains it is one passcode for all pages', (await page.textContent('#gate')).includes('One passcode for all the Admin pages'));
  await page.fill('#pass', FB_PASS);
  await page.click('#unlock');
  await page.waitForURL(/\/admin\/feedback\.html$/);
  await page.waitForSelector('#app:not([hidden])');
  await page.click('#lock');
  await page.waitForURL(/\/admin\/\?next=feedback\.html$/);
  check('review: lock returns to the sign-in', await page.locator('#gate').isVisible());

  // ---------- feedback switched off on the Worker ----------
  feedbackFlag = false;
  await page.goto(ON + '/');
  await page.waitForTimeout(300);
  await page.fill('#message', 'I am 20 and anxious in Dewsbury');
  await chooseMode(page);
  await page.click('#send');
  await showCards(page);
  check('feedback off: no card link, no helpful buttons, no Tell us links', (await page.locator('.fb-card, .fb-reply, .fb-helpful').count()) === 0);
  check('feedback off: "Suggest a service" hidden', !(await page.locator('#suggest-btn').isVisible()));
  feedbackFlag = true;

  // ---------- feedback in Urdu (right to left) ----------
  await page.goto(ON + '/?lang=ur');
  await page.waitForSelector('#suggest-btn:not([hidden])');
  await page.fill('#message', 'I am 20 and anxious in Dewsbury');
  await chooseMode(page);
  await page.click('#send');
  await showCards(page);
  await page.waitForSelector('.card .fb-card .linkish');
  await page.locator('.card .fb-card .linkish').first().click();
  await page.locator('#suggest-btn').click();
  const urCard = page.locator('form.fb-card-form').first();
  await urCard.waitFor();
  const dirs = await page.evaluate(() => [...document.querySelectorAll('form.fb-card-form, #suggest-panel form.fb-gap-form')].map((f) => getComputedStyle(f).direction));
  check('feedback in Urdu: the forms are laid out right to left', dirs.length === 2 && dirs.every((d) => d === 'rtl'), dirs.join());
  check('feedback in Urdu: the wording is in Urdu and the scheme name stays in English', (await page.locator('.card .fb-card .linkish').first().textContent()) === 'اس اندراج میں مسئلے کی اطلاع دیں' && (await urCard.locator('legend [lang="en"]').textContent()) === 'My Way Forward');
  const newKeys = ['answerHint', 'answerPreferNot', 'answerContinue', 'answerNeedOne', 'checkTitleSelf', 'checkTitleStaff', 'checkIntro', 'checkYes', 'checkNo', 'checkFix', 'checkThanks'];
  const untranslated = await page.evaluate((keys) => keys.filter((k) => /[A-Za-z]{3}/.test(window.I18N.t(k))), newKeys);
  check('answers and check in Urdu: all the new wording is translated', untranslated.length === 0, untranslated.join());
  const tickBox = await urCard.locator('input[type=checkbox]').first().boundingBox();
  const tickText = await urCard.locator('.fb-tick label span').first().boundingBox();
  check('feedback in Urdu: tick boxes sit on the right of their labels', tickBox.x > tickText.x, JSON.stringify([tickBox, tickText]));

  // ---------- "Have we understood you?": something's not right ----------
  await page.goto(ON + '/');
  await page.fill('#message', 'I am 20 and anxious in Dewsbury');
  await chooseMode(page);
  await page.click('#send');
  await page.waitForSelector('.check-summary');
  await page.locator('.check-summary .check-actions .btn.secondary').click();
  check('check: "Something\'s not right" asks what was wrong and moves to the message box', await page.locator('.check-fix').isVisible() && await page.evaluate(() => document.activeElement.id === 'message'));
  await page.fill('#message', 'I am 40, not 20');
  await page.click('#send');
  await page.waitForSelector('.check-summary >> nth=1');
  const fixed = lastChat.messages;
  check('check: the correction is sent with a note that the summary was not right, and no services were shown', fixed.length === 3 && fixed[1].role === 'assistant' && fixed[1].content.includes('aged 20; anxious') && fixed[1].content.includes('no services were shown') && !fixed[1].content.includes('Services shown') && fixed[2].content === 'I am 40, not 20', JSON.stringify(fixed));
  check('check: the first summary can no longer be answered, and the new one is checked again', (await page.locator('.check-summary').first().locator('.check-actions, .check-fix').count()) === 0 && (await page.locator('.check-summary').nth(1).locator('.check-actions').count()) === 1 && (await page.locator('.card').count()) === 0);
  check('usage: summary "changed" counted', usageSent.some((e) => e.e === 'summary' && e.k === 'changed'));
  await page.locator('.check-summary').nth(1).locator('.btn.primary').click();
  await page.waitForSelector('.card');
  check('check: after a yes, cards show', (await page.locator('.card').count()) === 1);

  // ---------- feedback forms at the largest text size, high contrast, phone width ----------
  await page.setViewportSize({ width: 375, height: 800 });
  for (const q of ['?size=3&contrast=high', '?lang=ur&size=3']) {
    await page.goto(ON + '/' + q);
    await page.waitForSelector('#suggest-btn:not([hidden])');
    await page.fill('#message', 'I am 20 and anxious in Dewsbury');
    await chooseMode(page);
  await page.click('#send');
    await showCards(page);
    await page.waitForSelector('.card .fb-card .linkish');
    await page.locator('.card .fb-card .linkish').first().click();
    await page.locator('.fb-reply .fb-helpful button').nth(1).click();
    await page.locator('.fb-no-form input[value="missed-service"]').check();
    await page.locator('.fb-reply form.fb-gap-form input[value="missing-service"]').check();
    await page.locator('.fb-reply form.fb-gap-form input[value="missing-support"]').check();
    await page.waitForTimeout(200);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('feedback: no sideways scrolling with the forms open at ' + q, over <= 1, 'overflow ' + over + 'px');
  }
  await page.setViewportSize({ width: 1000, height: 900 });

  // ---------- phone-width layout ----------
  await page.setViewportSize({ width: 375, height: 800 });
  const phoneOver = async (name, path) => {
    await page.goto(ON + path);
    await page.waitForTimeout(300);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('phone width: no sideways scrolling on ' + name, over <= 1, 'overflow ' + over + 'px');
  };
  await phoneOver('main', '/');
  await phoneOver('Admin sign-in', '/admin/');
  await page.fill('#pass', PASS);
  await page.click('#unlock');
  await page.waitForSelector('#app:not([hidden])');
  await phoneOver('Admin home', '/admin/');
  for (const p of ['help', 'services', 'feedback']) await phoneOver(p, '/admin/' + p + '.html');
  await page.goto(ON + '/admin/log.html');
  await page.waitForSelector('#list .entry');
  const overLog = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('phone width: no sideways scrolling on the open log', overLog <= 1, 'overflow ' + overLog + 'px');

  // ---------- help with abuse and safety (safety.html) ----------
  for (const q of ['', '?size=3&contrast=high', '?lang=ur&size=3', '?lang=pl']) await phoneOver('safety page ' + (q || 'default'), '/safety.html' + q);
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(ON + '/?lang=pl');
  await page.click('#safety-link');
  await page.waitForURL(/safety\.html\?lang=pl/);
  check('safety: the footer button opens the safety page in the same language', (await page.locator('h1').textContent()).startsWith('Pomoc'));
  check('safety: numbers in translated text are tap-to-call links', (await page.locator('a[href="tel:01484414960"]').count()) === 1 && (await page.locator('a[href="tel:08001111"]').count()) === 1);
  await page.goto(ON + '/safety.html?lang=ur');
  check('safety: Urdu page is right to left with its own title', (await page.evaluate(() => document.documentElement.dir)) === 'rtl' && (await page.title()).includes('زیادتی'));
  await page.goto(ON + '/safety.html');
  check('safety: every number on the page is a tap-to-call link', (await page.locator('a[href^="tel:"]').count()) >= 18);
  await page.click('#back-link');
  await page.waitForURL((u) => !u.pathname.endsWith('safety.html'));
  check('safety: back link returns to the main page', (await page.locator('#message').count()) === 1);
  await page.goto(ON + '/safety.html');
  await page.route('https://www.bbc.co.uk/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Weather</title>' }));
  await page.click('#quick-exit');
  await page.waitForURL(/bbc\.co\.uk\/weather/);
  await page.goBack();
  check('safety: quick exit replaces the page, so Back does not return to it', !page.url().endsWith('safety.html'), page.url());
  await page.unroute('https://www.bbc.co.uk/**');

  // ---------- partner check page: "a different service" is kept apart from sending ----------
  await page.goto(ON + '/provider-check.html#' + 'a'.repeat(32));
  await page.waitForSelector('#pc-app:not([hidden])');
  const pcOrder = await page.evaluate(() => { const send = document.querySelector('.pc-send'); const other = document.querySelector('.pc-other'); return Boolean(send && other && (send.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) && !send.contains(other)); });
  check('partner page: "Do you run a different service?" comes after the send box, outside it', pcOrder);
  check('partner page: only one "Add another project to" route (in the form), none beside the different-service link', (await page.locator('.pc-other button').count()) === 0 && (await page.locator('.pc-other a.btn').textContent()).includes('different service'));
  check('partner page: says it sends nothing on this page', (await page.locator('.pc-other').textContent()).includes("doesn't send anything on this page"));
  check('partner page: no unsent-changes warning before anything changes', await page.locator('.pc-unsent').isHidden());
  await page.locator('.pc-form textarea, .pc-form input[type=text]').first().fill('Changed for the test');
  await page.locator('.pc-form textarea, .pc-form input[type=text]').first().dispatchEvent('input');
  await page.waitForTimeout(200);
  check('partner page: with unsent changes, the different-service section says to send them first', await page.locator('.pc-unsent').isVisible());
  {
    // The three parts, one at a time; where answers came from; questions that must be answered; the draft.
    await page.evaluate(() => localStorage.clear());
    await page.goto(ON + '/provider-check.html#' + 'b'.repeat(32));
    await page.reload(); // only the # changed, so load the page again
    await page.waitForSelector('#pc-app:not([hidden])');
    const visibleParts = async () => page.locator('.lf-part:visible').evaluateAll((ps) => ps.map((p) => p.dataset.part).join());
    check('partner form: three parts, one shown at a time, with links between them', (await page.locator('.lf-steps .lf-step').count()) === 3 && (await visibleParts()) === '1' && (await page.locator('.lf-step[aria-current=step]').textContent()) === '1. The service and who can join');
    check('partner form: answers found online say so, unknown ones ask to be answered', (await page.locator('[data-key=whoFor] .lf-label-found').textContent()).startsWith('Found on your website') && (await page.locator('#pc-work .lf-label-unknown').textContent()) === 'Unknown: please answer' && (await page.locator('#pc-residence .lf-label-found').count()) === 1);
    await page.click('.lf-part[data-part="1"] .lf-partnav .btn.primary');
    const formTop = await page.evaluate(() => Math.round(document.querySelector('.lf-top').getBoundingClientRect().top));
    check('partner form: "Next" goes to part 2, back at the top of the form', (await visibleParts()) === '2' && formTop >= -2 && formTop <= 40, String(formTop));
    await page.click('.lf-step[data-part="3"]');
    check('partner form: the send box is at the end of part 3', (await visibleParts()) === '3' && await page.locator('.pc-send').isVisible());
    await page.click('.lf-step[data-part="1"]');
    await page.fill('#pc-whoFor', 'People in Kirklees looking for a way forward.');
    await page.click('.lf-step[data-part="3"]');
    await page.click('.pc-send button[type=submit]');
    check('partner form: unanswered questions are a reminder before sending, not a rule', await page.locator('.pc-left').isVisible() && (await page.textContent('.pc-left')).includes('Work situation') && (await page.locator('.pc-left button', { hasText: 'Send anyway' }).count()) === 1 && providerSent.length === 0, await page.textContent('.pc-left'));
    await page.locator('.pc-left button', { hasText: 'Work situation' }).click();
    check('partner form: each one goes back to its question', (await visibleParts()) === '1');
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForSelector('#pc-app:not([hidden])');
    check('partner form: a draft is kept on this device and filled in again', (await page.inputValue('#pc-whoFor')) === 'People in Kirklees looking for a way forward.' && (await page.textContent('.pc-draft')).includes("We've filled in the answers you saved"));
    await page.locator('#pc-residence input[value=kirklees]').check();
    await page.locator('#pc-work input[value=no]').check();
    await page.locator('#pc-noage').check();
    await page.click('.lf-step[data-part="2"]');
    await page.fill('#pc-workExperience', '');
    await page.locator('#pc-referral input[value=yes]').check();
    await page.locator('#pc-referral-who input[value=professional]').check();
    await page.fill('#pc-referral-professionals', 'GP or work coach');
    await page.click('.lf-step[data-part="3"]');
    const proj = page.locator('.lf-proj').first();
    for (const k of ['multi']) await page.locator('fieldset[data-key=' + k + '] input[value=no]').check();
    if (!(await proj.locator('.lf-runs input:checked').count())) await proj.locator('.lf-runs label:has-text("By appointment") input').check();
    await proj.locator('fieldset[data-key=act-open] input[value=yes]').check();
    await proj.locator('fieldset[data-key=cohorts] input[value=no]').check();
    const before = providerSent.length;
    await page.click('.pc-send button[type=submit]');
    if (await page.locator('.pc-left button', { hasText: 'Send anyway' }).isVisible()) await page.locator('.pc-left button', { hasText: 'Send anyway' }).click();
    await page.waitForSelector('.lf-review');
    const prv = await page.locator('.lf-review').innerText();
    check('partner form: "Check your changes" shows only what they changed', providerSent.length === before && prv.includes('People in Kirklees looking for a way forward.') && prv.includes('GP or work coach') && !prv.includes('Acas helpline:'), prv.slice(0, 500));
    await page.locator('.lf-review button', { hasText: 'Send my changes' }).click();
    await page.waitForSelector('.pc-thanks');
    const got = providerSent[before];
    check('partner form: sends only what changed, with the new answers', got && got.changes.whoFor === 'People in Kirklees looking for a way forward.' && JSON.stringify(got.changes.residence) === '{"scope":"kirklees"}' && JSON.stringify(got.changes.work) === '{"needed":"no"}' && JSON.stringify(got.changes.referral) === '{"needed":"yes","who":"professional","professionals":"GP or work coach"}' && got.changes.selfReferral.allowed === 'no' && got.changes.age === 'All ages' && !('name' in got.changes) && !('workExperience' in got.changes), JSON.stringify(got && got.changes));
    check('partner form: the draft is cleared once sent', await page.evaluate(() => !Object.keys(localStorage).some((k) => k.startsWith('hwl-verify-draft-'))));
  }

  // ---------- the To do list, checking a partner's reply and a suggestion, organisations ----------
  await page.goto(ON + '/admin/');
  await page.evaluate((p) => { sessionStorage.setItem('hwlTeamPass', p); sessionStorage.setItem('hwlLogBy', 'PL'); }, PASS);
  const replyT = new Date(Date.now() - 3600e3).toISOString();
  const ab = ALL.find((x) => x.id === 'audio-boost');
  providerLinks = [{ token: 'r'.repeat(32), id: 'audio-boost', contact: 'Sam', by: 'PL', created: new Date(Date.now() - 86400e3).toISOString(), expires: new Date(Date.now() + 20 * 86400e3).toISOString(), cancelled: null, sent: 1,
    replies: [{ t: replyT, name: 'Sam', allCorrect: false, note: 'New number', changes: { phone: '01924 000001', gate: ab.gate.filter((g) => g !== 'Lives in Kirklees' && g !== 'Aged 18 or over'), referralRoutes: ['Apply at https://example.org/apply-now.'] }, before: { phone: ab.phone, gate: ab.gate, referralRoutes: ab.referralRoutes } }] },
    { token: 'w'.repeat(32), id: 'my-way-forward', contact: 'Jo', by: 'PL', created: new Date(Date.now() - 2 * 86400e3).toISOString(), expires: new Date(Date.now() + 20 * 86400e3).toISOString(), cancelled: null, sent: 0, replies: [] }];
  await page.goto(ON + '/admin/');
  await page.waitForSelector('#app:not([hidden])');
  check('admin home: the Admin pages only, with the To do list on its own page', (await page.locator('#todo').count()) === 0 && (await page.getAttribute('.admin-tools a >> nth=0', 'href')) === 'todo.html');
  fbStore.push({ ...fbBase, id: 8, kind: 'gap', reasons: ['missing-service'], missedService: { name: 'Mental health support sessions', role: 'provider', organisation: 'TCD Mental Health Charity', organisationOverview: 'A charity in Kirklees.', age: '20+', exclusions: "Under 11's", eligibility: 'Mental Health', healthNeed: 'none', groups: ['young-people', 'young-adults', 'adults', 'adults-50', 'older-people', 'parents', 'mothers', 'fathers', 'women', 'men', 'mental-health'], email: 'x@example.org', projects: [{ name: 'Peer groups', sessions: [{ group: 'Young adults', age: '20 to 25', where: 'Jo Cox House', day: 'wed' }] }] } });
  await page.goto(ON + '/admin/todo.html');
  await page.waitForSelector('#todo .todo-sec');
  const todoText = await page.textContent('#todo');
  check('to do: "Ready to go live" comes first', (await page.locator('#todo .todo-sec h2').first().textContent()).startsWith('Ready to go live'));
  const checkSec = page.locator('#todo .todo-sec', { hasText: 'Check these: duplicates and partnerships' });
  // The real data changes as the team tidies organisations up, so check for one of each kind rather than particular names.
  const checkText = await checkSec.textContent();
  check('to do: possible duplicate organisations and partnerships are listed to check', ['Possible duplicate organisation', 'Possible partnership', 'Partner name to check'].every((k) => checkText.includes(k)), checkText.slice(0, 400));
  const nDupes = await checkSec.locator('.todo-item').count();
  await checkSec.locator('.todo-item', { hasText: 'Possible partnership' }).first().locator('button:text-is("It’s one organisation")').click();
  check('to do: "It’s one organisation" takes it off the list', (await page.locator('#todo .todo-sec', { hasText: 'Check these' }).locator('.todo-item').count()) === nDupes - 1);
  check('to do: the partner reply is listed to check, with the Healthy Working Life rule flagged', todoText.includes('Audio Boost: 3 changes from Sam') && todoText.includes('remove a grant funding rule'), todoText.slice(0, 600));
  check('to do: the suggestion is listed, with things to ask', todoText.includes('Mental health support sessions, from TCD Mental Health Charity') && /\d+ things to ask/.test(todoText));
  check('to do: a link with no reply is "waiting on a partner", with a reminder to copy', todoText.includes('My Way Forward: no reply yet') && await page.locator('#todo button', { hasText: 'Copy a reminder email' }).count() === 1);
  await page.click('#todo a:text-is("Check changes")');
  await page.waitForSelector('.change');
  check('reply: one card per change, old and new', (await page.locator('.change').count()) >= 2 && (await page.textContent('#page')).includes('01924 000001'));
  check('reply: links in a change can be clicked (and open in a new tab)', (await page.getAttribute('.change .now a[href="https://example.org/apply-now"]', 'target')) === '_blank');
  await page.evaluate(() => { window.__copied = ''; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await page.click('#page button:text-is("Copy a pilot invitation email")');
  const invite = await page.evaluate(() => window.__copied);
  check('reply: a pilot invitation can be copied, thanking them by name for checking the service', invite.startsWith('Subject: Would you like to help pilot') && invite.includes('Hi Sam,') && invite.includes('Thank you for checking your entry for Audio Boost') && invite.includes(ON + '/') && !/\n\n\n/.test(invite) && !/:\n\n- /.test(invite), invite.slice(0, 300));
  check('reply: taking out a grant funding rule is flagged to check, not locked', (await page.textContent('.change.blocked')).includes('Check this: it takes out "Lives in Kirklees"') && (await page.locator('.change.blocked input[value=use]').isChecked()));
  await page.click('.decide-bar button:text-is("Save as checked")');
  await page.waitForSelector('.msg.ok');
  const ed = edits['audio-boost'];
  check('reply: saved as a checked edit, using their change as it is', ed && ed.checked === true && ed.changes.phone === '01924 000001' && !ed.changes.gate.includes('Lives in Kirklees') && !ed.changes.gate.includes('Aged 18 or over') && ed.note.includes('From Sam'), JSON.stringify(ed));
  await page.goto(ON + '/admin/todo.html');
  await page.waitForSelector('#todo .todo-sec');
  check('to do: the reply has moved to "ready to go live"', !(await page.textContent('#todo')).includes('3 changes from Sam') && (await page.textContent('.todo-ready')).includes('Audio Boost'));
  await page.goto(ON + '/admin/services.html#svc-audio-boost');
  await page.waitForSelector('#svc-audio-boost details[open]');
  await page.waitForTimeout(500);
  check('all services: a reply that has been dealt with has no "Review their changes" button (it would show older values)', (await page.locator('#svc-audio-boost button:has-text("Review their changes")').count()) === 0 && (await page.locator('#svc-audio-boost').innerText()).includes('use Edit details'));
  // Using none of a reply's changes marks it as dealt with.
  providerLinks[0].replies.push({ t: new Date().toISOString(), name: 'Sam', allCorrect: false, note: '', changes: { phone: '01924 999999' }, before: { phone: ab.phone } });
  await page.goto(ON + '/admin/reply.html?id=audio-boost');
  await page.waitForSelector('.change');
  await page.check('.change input[value=skip]');
  await page.click('.decide-bar button:text-is("Don\'t use any of them")');
  await page.waitForSelector('.msg.ok');
  check('reply: using none of them marks the reply as dealt with', Boolean(providerLinks[0].replies[1].handled));
  // A suggested service.
  await page.goto(ON + '/admin/suggestion.html?id=8');
  await page.waitForSelector('.ask-table');
  const sugg = await page.textContent('#page');
  check('suggestion: matched to the organisation already listed (TCD)', sugg.includes('looks like') && sugg.includes('Add it under TCD'));
  check('suggestion: picks out what to ask (age, groups, who can join, health need, other services)', ['Age', 'Who can join', 'Health need', 'Other TCD services'].every((w) => sugg.includes(w)), sugg.slice(0, 800));
  check('suggestion: projects and groups in words', sugg.includes('Young adults, age 20 to 25: Jo Cox House, Wednesdays'));
  await page.click('.decide-bar button:text-is("Mark as waiting on them")');
  await page.waitForSelector('.msg.ok');
  check('suggestion: "waiting on them" is saved with what was asked', fbStore.find((x) => x.id === 8).status === 'Reviewed' && fbStore.find((x) => x.id === 8).note.includes('Age'));
  await page.goto(ON + '/admin/suggestion.html?id=8');
  await page.waitForSelector('.decide-bar');
  await page.click('.decide-bar button:has-text("Start the listing under TCD")');
  await page.waitForURL(/services\.html/);
  await page.waitForSelector('#add-panel:not([hidden]) form, #add-panel:not([hidden]) .edit');
  check('suggestion: starting the listing renames the organisation (keeping the old name) and opens Add a service under it', orgs.tcd && orgs.tcd.changes.name === 'TCD Mental Health Charity' && (await page.inputValue('#add-panel [data-key=organisation] input')) === 'TCD', JSON.stringify(orgs.tcd));
  // A suggestion sent with the full service form: the whole listing is shown, and starts the new listing.
  fbStore.push({ ...fbBase, id: 9, kind: 'gap', reasons: ['missing-service'], missedService: { name: 'Brand New Job Club', role: 'provider', organisation: 'Brand New Trust', contactName: 'Sam', website: 'https://example.org/club',
    listing: { organisation: 'Brand New Trust', name: 'Brand New Job Club', whoFor: 'Anyone in Batley looking for work.', webpage: 'https://example.org/club', residence: { scope: 'kirklees' }, referral: { needed: 'no' }, projects: [{ id: 'brand-new-job-club', name: 'Brand New Job Club', overview: 'Weekly job club.' }] } } });
  await page.goto(ON + '/admin/suggestion.html?id=9');
  await page.waitForSelector('.decide-bar');
  const full9 = await page.textContent('#page');
  check('suggestion: the full service form shows every answer, with links, and nothing to ask', full9.includes('Anyone in Batley looking for work.') && full9.includes('People living in Kirklees') && full9.includes('No referral needed') && full9.includes('full service form') && (await page.locator('#page a[href="https://example.org/club"]').count()) > 0 && !(await page.locator('.ask-table').count()), full9.slice(0, 900));
  await page.click('.decide-bar button:has-text("Start the listing")');
  await page.waitForURL(/services\.html/);
  await page.waitForSelector('#add-panel:not([hidden]) form, #add-panel:not([hidden]) .edit');
  const addText = await page.locator('#add-panel').evaluate((n) => [...n.querySelectorAll('input, textarea')].map((i) => i.value).join(' | '));
  check('suggestion: starting it fills Add a service with their whole listing', addText.includes('Brand New Job Club') && addText.includes('Anyone in Batley looking for work.') && addText.includes('Weekly job club.') && (await page.locator('#add-panel input[value=kirklees]').isChecked()), addText.slice(0, 500));
  // "Show the whole listing" (a link to one service) lands on that service, even once the team's changes load.
  await page.goto(ON + '/admin/reply.html?id=audio-boost');
  await page.waitForSelector('#page a:text-is("Show the whole listing")');
  await page.click('#page a:text-is("Show the whole listing")');
  await page.waitForSelector('#svc-audio-boost details[open]');
  await page.waitForTimeout(400);
  const shownIds = await page.locator('#list > [id^=svc-]').evaluateAll((els) => els.map((e) => e.id));
  const atTop = await page.evaluate(() => { const r = document.querySelector('#svc-audio-boost').getBoundingClientRect(); return r.top > -5 && r.top < innerHeight / 2 ? true : r.top + ' of ' + innerHeight + ' scrollY ' + scrollY; });
  check('link to one service: shows that service, open and in view', shownIds[0] === 'svc-audio-boost' && atTop === true, shownIds.slice(0, 3).join() + ' ' + atTop);
  // Organisations.
  await page.goto(ON + '/admin/organisation.html');
  await page.waitForSelector('.org-list-page li');
  const orgShown = await page.locator('.org-list-page li').count();
  const orgCount = await page.locator('#page .count').textContent();
  check('organisations: the whole list is shown, A to Z', orgShown > 80 && orgCount.startsWith(orgShown + ' '), orgShown + ' ' + orgCount);
  await page.fill('#org-find', 'tcd');
  await page.click('.org-list-page a >> nth=0');
  await page.waitForSelector('.org-head');
  const orgText = await page.textContent('#page');
  check('organisation: shows its services with projects, and the Healthy Working Life marker only on the funded one', orgText.includes('TCD Healthy Futures') && orgText.includes("Luke's Lads") && orgText.includes('Project: Healthy Futures Programme') && (await page.locator('.org-head .pill.blue').count()) === 0);
  check('organisation: the waiting suggestion is shown under it', orgText.includes('Mental health support sessions'));
  check('organisation: not in the pilot to start, with a pilot invitation to copy (it runs local services)', !(await page.isChecked('#pilot-switch')) && (await page.locator('.org-head button:text-is("Copy a pilot invitation email")').count()) === 1);
  await page.check('#pilot-switch');
  await page.waitForFunction(() => document.querySelector('.org-head').parentElement.textContent.includes('Added to the pilot by'));
  check('organisation: the pilot switch is saved for the team, with who switched it on', Boolean(pilotOrgs.tcd && pilotOrgs.tcd.by));
  await page.evaluate(() => { window.__copied = ''; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await page.click('.org-head button:text-is("Copy a pilot invitation email")');
  const orgInvite = await page.evaluate(() => window.__copied);
  check('organisation: the invitation has no service thank-you and a name to fill in when no one has been sent a link', orgInvite.includes('Hi [name],') && !orgInvite.includes('Thank you for checking') && orgInvite.includes('join the pilot'), orgInvite.slice(0, 200));
  check('organisation: "Add a service" adds it under this organisation', (await page.getAttribute('.org-head a:text-is("Add a service")', 'href')) === 'services.html?add=TCD');
  await page.goto(ON + '/admin/organisation.html');
  await page.waitForSelector('.org-list-page li');
  check('organisations: the list marks who is in the pilot', (await page.locator('.org-list-page li', { hasText: 'TCD' }).first().textContent()).includes('In the pilot'));
  await page.check('#org-pilot-only');
  check('organisations: can show only those in the pilot', (await page.locator('.org-list-page li').count()) === 1);
  await page.goto(ON + '/admin/organisation.html?id=tcd');
  await page.waitForSelector('#pilot-switch');
  await page.uncheck('#pilot-switch');
  await page.waitForFunction(() => document.body.textContent.includes('Not in the pilot.'));
  check('organisation: switching it off takes it out of the pilot', !pilotOrgs.tcd);
  providerLinks = [];

  // ---------- old /mvp/ addresses ----------
  // The Pages workflow publishes small redirect pages at /mvp/; this local build doesn't, so only check the config.
  const cfg = await (await page.goto(ON + '/config.js')).text();
  check('config: only says where the Worker is', cfg.includes('apiBase') && !cfg.includes('mvp'), cfg);

  check('no console errors or CSP violations anywhere', problems.filter((p) => !/status of (401|404)/.test(p)).length === 0, problems.join(' || '));
  await browser.close();
  console.log(`passed=${ok} failed=${bad}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED:', e); process.exit(2); });
