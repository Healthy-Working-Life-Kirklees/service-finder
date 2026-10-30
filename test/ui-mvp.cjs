// Browser test for the MVP pages. Run by test/run-ui.sh (headless Chromium, mocked Worker, no real API use).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const DATA = require(path.join(__dirname, '..', 'data', 'services.json')).services; // the live list
const ALL = require(path.join(__dirname, '..', 'data', 'services-all.json')).services; // every service

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
let lastChat = null;
let feedbackFlag = true; // what /health says about feedback
let fbSent = []; // feedback the page sent
let usageSent = []; // anonymous usage events the page sent
const decisions = {}; // listing decisions recorded on the All services page
const edits = {}; // edits to details recorded on the All services page
const added = {}; // new services added on the All services page
const mk = (f, status) => {
  const t = new Date().toISOString();
  const it = { id: ++seq, type: f.type || 'Issue', title: f.title, details: f.details || '', area: f.area || 'Other', priority: f.priority || 'Medium', owner: f.owner || '', status: status || 'Open', created: t, updated: t, updates: [] };
  log.push(it);
  return it;
};

// Stored feedback for the User feedback review page.
const FB_PASS = 'fb-test-pass';
const fbToday = new Date().toISOString().slice(0, 10);
const fbBase = { date: fbToday, schemeIds: [], recordLastUpdated: null, helpful: null, reasons: [], text: '', missedService: null, gapCategories: [], gapArea: null, lang: 'en', mode: 'public', redacted: false, status: 'New', note: '' };
const fbStore = [
  { ...fbBase, id: 1, kind: 'reply', helpful: true, schemeIds: ['my-way-forward'] },
  { ...fbBase, id: 2, kind: 'reply', helpful: true, schemeIds: ['my-way-forward'] },
  { ...fbBase, id: 3, kind: 'reply', helpful: true, schemeIds: ['my-way-forward'], mode: 'staff' },
  { ...fbBase, id: 4, kind: 'reply', helpful: false, schemeIds: ['my-way-forward'], reasons: ['none-fit'], text: 'Nothing near me' },
  { ...fbBase, id: 5, kind: 'card', schemeIds: ['my-way-forward'], recordLastUpdated: '2026-08-03', reasons: ['contact-wrong'] },
  { ...fbBase, id: 6, kind: 'gap', reasons: ['missing-service'], missedService: { name: 'A test service', website: '', area: '' } },
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
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-team-passcode, x-feedback-passcode', 'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS' };
  const json = (obj, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });

  if (url.pathname === '/health') return json({ ok: true, aiConfigured: true, teamLog: true, feedback: feedbackFlag, usage: true });
  if (url.pathname === '/usage' && req.method() === 'POST') { usageSent.push(JSON.parse(req.postData())); return route.fulfill({ status: 204, headers: cors }); }
  // Reading feedback (the User feedback review page), with its own passcode.
  if (url.pathname.startsWith('/feedback/')) {
    if (req.headers()['x-feedback-passcode'] !== FB_PASS) return json({ error: 'Wrong passcode.' }, 401);
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
    if (/crisis/i.test(last)) return json({ status: 'results', message: 'I am sorry you feel like this.', recommendations: [], safety_concern: true, urgent_types: ['mental_health_crisis'], pii_detected: false, understood_needs: [], follow_up_questions: [] });
    if (/abuse/i.test(last)) return json({ status: 'results', message: 'I am so sorry. You deserve to be safe.', recommendations: [], safety_concern: true, urgent_types: ['domestic_abuse'], pii_detected: false, understood_needs: [], follow_up_questions: [] });
    if (/unsure/i.test(last)) return json({ status: 'needs_more_info', message: 'Which town are you nearest to?', recommendations: [], safety_concern: false, urgent_types: [], pii_detected: false, understood_needs: ['needs support'], follow_up_questions: ['Which town are you nearest to?'], question_options: [{ question: 'Which town are you nearest to?', options: ['Batley', 'Dewsbury', 'Huddersfield'] }] });
    if (/Jane Smith/.test(last)) return json({ status: 'results', message: 'Here is a match.', recommendations: [], safety_concern: false, urgent_types: [], pii_detected: true, understood_needs: [], follow_up_questions: [] });
    return json({ status: 'results', message: 'Here is a match.', recommendations: [{ id: 'my-way-forward', why: 'Fits your age and situation.', fit: 'possible', check_first: 'Check they are not claiming Universal Credit with a job-search requirement.' }], safety_concern: false, urgent_types: [], pii_detected: false, understood_needs: ['aged 20', 'anxious'], follow_up_questions: [] });
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
    if (url.pathname === '/log/decisions') return json({ decisions });
    if (url.pathname === '/log/edits') return json({ edits });
    if (url.pathname === '/log/new') return json({ added });
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
  const page = await ctx.newPage();

  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

  // ---------- main page (MVP tools ON) ----------
  await page.goto(ON + '/');
  check('main: team bar shown when MVP tools are on', (await page.locator('.teambar a').allTextContents()).join('|').includes('Help'));
  check('main: team bar links point at /mvp/', (await page.locator('.teambar a').evaluateAll((a) => a.map((x) => x.getAttribute('href')))).join() === 'mvp/help.html,mvp/services.html,mvp/log.html,mvp/feedback.html');
  check('main: "Who is this for?" has no default', (await page.locator('input[name=mode]:checked').count()) === 0);
  await page.fill('#message', 'I am 20 and anxious in Dewsbury');
  await page.click('#send');
  await page.waitForTimeout(200);
  check('main: searching without choosing asks for the choice and sends nothing', (await page.locator('#mode-error').isVisible()) && (await page.locator('.bubble.user').count()) === 0);
  await page.check('input[name=mode][value=public]');
  check('main: choosing hides the prompt', !(await page.locator('#mode-error').isVisible()));
  await page.click('#send');
  await page.waitForSelector('.check-summary');
  check('check: summary shown before any cards', (await page.locator('.card').count()) === 0 && (await page.locator('.check-summary h2').textContent()) === 'Have we understood you?' && (await page.locator('.check-list li').allTextContents()).join('|') === 'aged 20|anxious');
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
  check('main: overdue warning on the stale entry', (await page.locator('.card .stale').count()) === 1);

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
  check('main: what was understood is in the summary, not repeated under the confirmed results', (await page.locator('.check-list').first().textContent()).includes('anxious') && (await page.locator('.bubble .understood').count()) === 0);
  check('main: mental health crisis panel has the Single Point of Access number', (await page.locator('.crisis').first().textContent()).includes('01924 316830'));
  await page.fill('#message', 'there is abuse at home');
  await chooseMode(page);
  await page.click('#send');
  await page.waitForFunction(() => document.querySelectorAll('.crisis').length === 2);
  const abuse = await page.locator('.crisis').nth(1).textContent();
  check('main: domestic abuse panel has 999 and NHS 111, and no mental health number', abuse.includes('999') && abuse.includes('NHS 111') && !abuse.includes('01924'), abuse);
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
  check('feedback: gap form shows name, website and area fields with labels', await gapForm.locator('.fb-sub').first().isVisible() && (await gapForm.locator('.fb-sub').first().locator('label').count()) === 3);
  const areaOpts = await gapForm.locator('.fb-sub').first().locator('select option').allTextContents();
  check('feedback: area choices come from the data, plus "Don\'t know"', areaOpts.includes('Batley') && areaOpts.includes('Kirklees-wide') && areaOpts[areaOpts.length - 1] === "Don't know" && areaOpts.length === new Set(DATA.flatMap((x) => x.areas)).size + 2, areaOpts.join('|'));
  await gapForm.locator('.fb-sub').first().locator('input[type=text]').fill('Batley Job Club');
  await gapForm.locator('input[type=url]').fill('not a web address');
  await gapForm.locator('button[type=submit]').click();
  check('feedback: a bad website is explained and not sent', (await gapForm.locator('.fb-error').textContent()).includes('http') && lastSent() === sentNo);
  await gapForm.locator('input[type=url]').fill('www.example.org/job-club');
  await gapForm.locator('.fb-sub').first().locator('select').selectOption('Batley');
  await gapForm.locator('button[type=submit]').click();
  await reply2.locator('.fb-gap-slot .fb-thanks').waitFor();
  const sentGap = lastSent();
  check('feedback: gap entry sent, with the website given https://', sentGap.kind === 'gap' && sentGap.reasons.join() === 'missing-service' && sentGap.missedService.name === 'Batley Job Club' && sentGap.missedService.website === 'https://www.example.org/job-club' && sentGap.missedService.area === 'Batley' && sentGap.mode === 'public', JSON.stringify(sentGap));
  await page.fill('#message', 'My name is Jane Smith and I need work');
  await chooseMode(page);
  await page.click('#send');
  await page.waitForSelector('.pii-note');
  check('main: reminder about identifying details shown when flagged', (await page.locator('.pii-note').textContent()).includes("Please don't type names"));
  check('feedback: "Tell us" link under a result reply with no cards, but no helpful buttons', (await page.locator('.fb-reply').count()) === 3 && (await page.locator('.fb-reply').nth(2).locator('.fb-helpful').count()) === 0 && (await page.locator('.fb-reply').nth(2).locator('.fb-gap-link').count()) === 1);

  // ---------- feedback: the footer link, any time ----------
  const footLink = page.locator('#fb-footer .fb-gap-link');
  check('feedback: "Tell us" link in the footer', await footLink.isVisible() && (await footLink.textContent()) === 'Know a service that should be here? Tell us');
  // "Who is this for?" is hidden during a chat, so try the footer on a fresh page, with no chat at all.
  await page.goto(ON + '/');
  await footLink.waitFor();
  await page.locator('label:has(input[name=mode][value=staff])').click();
  check('feedback: staff wording for practitioners', (await footLink.textContent()) === "Do you refer people to a service that isn't listed? Tell us");
  await footLink.click();
  const footForm = page.locator('#fb-footer form.fb-gap-form');
  await footForm.waitFor();
  await footForm.locator('input[value="missing-support"]').check();
  check('feedback: categories come from the data, in English, plus "Something else"', (await footForm.locator('input[name=category]').count()) === new Set(DATA.flatMap((x) => x.categories)).size + 1 && (await footForm.locator('label:has(input[value="Carers"]) span').getAttribute('lang')) === 'en');
  await footForm.locator('input[value="Carers"]').check();
  await footForm.locator('.fb-sub').nth(1).locator('select').selectOption('Dewsbury');
  await footForm.locator('textarea').fill('Nothing for young carers who want work.');
  await footForm.locator('button[type=submit]').click();
  await page.locator('#fb-footer .fb-thanks').waitFor();
  const sentFoot = lastSent();
  check('feedback: footer form sends a gap entry with categories and area, in staff mode', sentFoot.kind === 'gap' && sentFoot.reasons.join() === 'missing-support' && sentFoot.gapCategories.join() === 'Carers' && sentFoot.gapArea === 'Dewsbury' && sentFoot.mode === 'staff' && !sentFoot.missedService, JSON.stringify(sentFoot));
  check('feedback: footer link still offered after sending', await footLink.isVisible());
  const everything = JSON.stringify(fbSent);
  check('feedback: nothing from the conversation is ever sent', fbSent.length === 5 && fbSent.every((x) => !('messages' in x) && !('understood_needs' in x) && !('message' in x)) && !everything.includes('aged 20') && !everything.includes('Here is a match'), everything);
  check('feedback: nothing stored in the browser', await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''));

  // ---------- help page ----------
  await page.goto(ON + '/mvp/help.html');
  await page.waitForSelector('#data-table tbody tr');
  const schemeCount = DATA.length;
  check(`help: data table lists all ${schemeCount} schemes`, (await page.locator('#data-table tbody tr').count()) === schemeCount);
  check('help: overdue entries flagged (>= 4)', (await page.locator('#data-table .pill.warn').count()) >= 4, String(await page.locator('#data-table .pill.warn').count()));
  check('help: not-open scheme flagged', (await page.locator('#data-table .pill.bad').count()) === 1);
  check('help: has the key sections', (await page.locator('h2').allTextContents()).join('|').includes('Reporting a problem'));

  // ---------- all services page ----------
  await page.goto(ON + '/mvp/services.html');
  await page.waitForSelector('.svc');
  check(`services: lists all ${ALL.length} services, including those not on the live list`, (await page.locator('.svc').count()) === ALL.length, String(await page.locator('.svc').count()));
  check('services: live list holds only included services', ALL.length > DATA.length && DATA.every((x) => x.listing.decision === 'include'));
  check('services: not signed in, so no decision controls', (await page.locator('.decide').count()) === 0 && await page.locator('#signin-form').isVisible());
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
  check('services: HWL filter shows the HWL schemes', (await page.locator('.svc').count()) === DATA.filter((x) => x.hwlFunded).length);
  await page.goto(ON + '/mvp/services.html?review=closed');
  await page.waitForSelector('.svc');
  check('services: filters restored from the address (not open)', (await page.locator('.svc').count()) === ALL.filter((x) => !x.open).length);
  check('services: edit link points at the scheme file', /\/edit\/main\/data\/services\/[a-z0-9-]+\.json$/.test(await page.locator('.svc a', { hasText: 'Edit on GitHub' }).first().getAttribute('href')));

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
  check('log: unlocked, starter offer shown on an empty log', await page.waitForSelector('#starter:not([hidden])', { timeout: 5000 }).then(() => true, () => false));
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
  await page.goto(ON + '/mvp/services.html?listing=review&q=samaritans');
  await page.waitForSelector('#signed-in:not([hidden])');
  check('decide: signed in via the log passcode in this tab', (await page.textContent('#signed-in-text')).includes('0 decisions, 0 edited services and 0 new services'), await page.textContent('#signed-in-text'));
  await page.waitForSelector('.svc .decide');
  check('decide: decision controls shown', (await page.locator('#svc-samaritans-helpline .decide input[type=radio]').count()) === 3);
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
  await page.goto(ON + '/mvp/services.html?q=kbop');
  await page.waitForSelector('#svc-kbop .decide');
  await page.check('#svc-kbop input[value=include]');
  check('decide: warns when an incomplete service is chosen for the live list', await page.locator('#svc-kbop .decide .msg.info').isVisible());
  await page.click('#svc-kbop .decide button');
  await page.waitForSelector('#svc-kbop .pill.blue');

  // ---------- adding a new service ----------
  await page.goto(ON + '/mvp/services.html');
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
  await page.fill('#ed-new-service-referralRoutes', 'Drop in');
  await page.fill('#ed-new-service-sr-note', 'Just turn up');
  await page.fill('#ed-new-service-act-name-0', 'Job club');
  await page.fill('#ed-new-service-act-summary-0', 'CV help and job search.');
  await page.fill('#ed-new-service-why', 'Suggested by a work coach');
  await page.click('#add-panel button[type=submit]');
  check('add: warns about a possible duplicate first', (await page.textContent('#add-panel .msg')).includes('may already be listed') && (await page.textContent('#add-panel .msg')).includes('Acas helpline'), await page.textContent('#add-panel .msg'));
  await page.fill('#ed-new-service-name', 'Batley Job Club');
  await page.click('#add-panel button[type=submit]');
  await page.waitForSelector('#svc-batley-job-club');
  check('add: saved to the Worker as a whole service', added['batley-job-club'] && added['batley-job-club'].service.areas.join() === 'Batley' && added['batley-job-club'].service.name === 'Batley Job Club');
  check('add: listed as new, with the "new" filter on', (await page.locator('.svc').count()) === 1 && (await page.inputValue('#f-listing')) === 'new' && (await page.locator('#svc-batley-job-club .pill.blue', { hasText: 'New: not yet in the data' }).count()) === 1);
  check('add: can be decided on like any other', (await page.locator('#svc-batley-job-club .decide input[type=radio]').count()) === 3);
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

  await page.goto(ON + '/mvp/services.html?decision=pending');
  await page.waitForSelector('.svc');
  check('decide: "waiting to be applied" filter shows both decisions', (await page.locator('.svc').count()) === 2, String(await page.locator('.svc').count()));
  const sStats = await page.locator('#summary .stat').allTextContents();
  check('decide: summary counts decisions waiting to be applied', sStats.some((x) => x.startsWith('2') && x.includes('waiting to be applied')), sStats.join(' | '));
  const [dd] = await Promise.all([page.waitForEvent('download'), page.click('#export-decisions')]);
  const saved = JSON.parse(fs.readFileSync(await dd.path(), 'utf8'));
  check('decide: decisions download for apply-decisions', saved.decisions.kbop.decision === 'include' && saved.decisions['samaritans-helpline'].decision === 'exclude' && 'edits' in saved);

  // ---------- editing a service's details ----------
  await page.goto(ON + '/mvp/services.html?q=kbop');
  await page.waitForSelector('#svc-kbop .edit-open button');
  await page.click('#svc-kbop .edit-open button');
  await page.waitForSelector('#svc-kbop form.edit-form');
  check('edit: form starts from the data', (await page.inputValue('#ed-kbop-name')) === 'Kirklees Better Outcomes Partnership (KBOP)' && (await page.inputValue('#ed-kbop-level')) === 'local');
  check('edit: "To be completed" boxes highlighted', (await page.locator('#svc-kbop .edit .tbc').count()) >= 3, String(await page.locator('#svc-kbop .edit .tbc').count()));
  await page.click('#svc-kbop form.edit-form button[type=submit]');
  check('edit: nothing changed is caught', (await page.textContent('#svc-kbop .edit .msg')).includes('Nothing has changed'));
  await page.fill('#ed-kbop-phone', '01484 000000');
  await page.fill('#ed-kbop-whoFor', 'Adults in Kirklees with complex needs.');
  await page.check('#ed-kbop-areas input[value=Batley]');
  await page.fill('#ed-kbop-act-summary-0', 'One-to-one key worker support.');
  await page.click('#svc-kbop form.edit-form button[type=submit]');
  check('edit: needs a reason', (await page.textContent('#svc-kbop .edit .msg')).includes('what changed'));
  await page.fill('#ed-kbop-why', 'Phoned the provider');
  await page.check('#ed-kbop-checked');
  await page.click('#svc-kbop form.edit-form button[type=submit]');
  await page.waitForSelector('#svc-kbop .waiting');
  const sent = edits.kbop;
  check('edit: ticking an area keeps the existing order and adds it last', JSON.stringify(sent.changes.areas) === JSON.stringify([...ALL.find((x) => x.id === 'kbop').areas, 'Batley']), JSON.stringify(sent.changes.areas));
  check('edit: categories untouched are not sent (order kept)', !('categories' in sent.changes));
  check('edit: only the changed fields are sent, with what the data said', sent && Object.keys(sent.changes).sort().join() === 'activities,areas,phone,whoFor' && sent.before.phone === null && sent.checked === true && sent.by === 'TB', JSON.stringify(sent && sent.changes));
  check('edit: waiting changes shown, old and new', (await page.textContent('#svc-kbop .waiting')).includes('01484 000000') && (await page.locator('#svc-kbop .waiting del').count()) === 4);
  check('edit: badge says it is waiting to be applied', (await page.locator('#svc-kbop .pill.blue', { hasText: 'Details edited by TB' }).count()) === 1);
  await page.click('#svc-kbop .edit-open button');
  await page.waitForSelector('#svc-kbop form.edit-form');
  check('edit: editing again starts from the waiting changes', (await page.inputValue('#ed-kbop-phone')) === '01484 000000');
  await page.click('#svc-kbop .edit button:has-text("Cancel")');
  await page.goto(ON + '/mvp/services.html?decision=edited');
  await page.waitForSelector('.svc');
  check('edit: "details edited" filter', (await page.locator('.svc').count()) === 1);
  page.once('dialog', (d) => d.accept());
  await page.click('#svc-kbop .waiting button');
  await page.waitForSelector('#svc-kbop .waiting', { state: 'detached' });
  check('edit: waiting changes can be discarded', !edits.kbop);
  await page.goto(ON + '/mvp/services.html?decision=pending');
  await page.waitForSelector('.svc');
  const [dc] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  const csv2 = fs.readFileSync(await dc.path(), 'utf8');
  check('decide: CSV includes the live list and team decision', csv2.includes('"Live list"') && csv2.includes('"Exclude completely"'), csv2.slice(0, 600));
  await page.click('#lock');
  check('decide: sign out hides the controls', (await page.locator('.decide').count()) === 0);
  await page.goto(ON + '/mvp/log.html');
  await page.fill('#pass', PASS);
  await page.click('#unlock');
  await page.waitForSelector('#app:not([hidden])');

  await page.click('#lock');
  check('log: lock returns to the gate', await page.locator('#gate').isVisible());
  await page.reload();
  check('log: still locked after reload', await page.locator('#gate').isVisible() && !(await page.locator('#app').isVisible()));

  // ---------- User feedback review page ----------
  await page.goto(ON + '/mvp/feedback.html');
  check('review: team bar marks the page', (await page.locator('.teambar a[aria-current="page"]').textContent()) === 'Feedback and usage');
  await page.fill('#pass', 'wrong');
  await page.click('#unlock');
  await page.waitForTimeout(200);
  check('review: wrong passcode refused', (await page.textContent('#gate-msg')).includes('not right') && !(await page.locator('#app').isVisible()));
  await page.fill('#pass', FB_PASS);
  await page.click('#unlock');
  await page.waitForSelector('#app:not([hidden])');
  const fbStats = await page.locator('#summary .stat b').allTextContents();
  check('review: totals (75% helpful, 3 yes, 1 no, 1 listing problem, 1 missing)', fbStats.slice(0, 5).join() === '75%,3,1,1,1', fbStats.join());
  check('review: list hides plain Yes answers', (await page.locator('#list .entry').count()) === 3);
  check('review: shows scheme names, not ids', (await page.textContent('#list')).includes('My Way Forward'));
  await page.locator('#list .entry').first().locator('select').selectOption('Actioned');
  await page.waitForTimeout(200);
  check('review: status change is saved', fbStore.find((x) => x.id === 6).status === 'Actioned');
  const fbDl = page.waitForEvent('download');
  await page.click('#export');
  check('review: CSV download', (await fbDl).suggestedFilename().endsWith('.csv'));
  await page.click('#lock');
  check('review: lock returns to the gate', await page.locator('#gate').isVisible());

  // ---------- feedback switched off on the Worker ----------
  feedbackFlag = false;
  await page.goto(ON + '/');
  await page.waitForTimeout(300);
  await page.fill('#message', 'I am 20 and anxious in Dewsbury');
  await chooseMode(page);
  await page.click('#send');
  await showCards(page);
  check('feedback off: no card link, no helpful buttons, no Tell us links', (await page.locator('.fb-card, .fb-reply, .fb-helpful').count()) === 0);
  check('feedback off: footer link hidden', !(await page.locator('#fb-footer').isVisible()) && (await page.locator('#fb-footer .fb-gap-link').count()) === 0);
  feedbackFlag = true;

  // ---------- feedback in Urdu (right to left) ----------
  await page.goto(ON + '/?lang=ur');
  await page.waitForSelector('#fb-footer .fb-gap-link');
  await page.fill('#message', 'I am 20 and anxious in Dewsbury');
  await chooseMode(page);
  await page.click('#send');
  await showCards(page);
  await page.waitForSelector('.card .fb-card .linkish');
  await page.locator('.card .fb-card .linkish').first().click();
  await page.locator('#fb-footer .fb-gap-link').click();
  const urCard = page.locator('form.fb-card-form').first();
  await urCard.waitFor();
  const dirs = await page.evaluate(() => [...document.querySelectorAll('form.fb-card-form, #fb-footer form.fb-gap-form')].map((f) => getComputedStyle(f).direction));
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
    await page.waitForSelector('#fb-footer .fb-gap-link');
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
  for (const [name, path] of [['main', '/'], ['help', '/mvp/help.html'], ['services', '/mvp/services.html'], ['feedback (gate)', '/mvp/feedback.html'], ['log (gate)', '/mvp/log.html']]) {
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
  const r4 = await off.goto(OFF + '/mvp/services.html');
  check('off: help, log, services list and starter list are not published (404)', [r1, r2, r3, r4].every((r) => r.status() === 404), [r1, r2, r3, r4].map((r) => r.status()).join());
  const cfg = await (await off.goto(OFF + '/config.js')).text();
  check('off: config says mvpTools false', cfg.includes('"mvpTools":false'), cfg);

  check('no console errors or CSP violations anywhere', problems.filter((p) => !/status of (401|404)/.test(p)).length === 0, problems.join(' || '));
  await browser.close();
  console.log(`passed=${ok} failed=${bad}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED:', e); process.exit(2); });
