# Kirklees Healthy Working Life Service Finder (prototype)

A proof of concept: a chat page that matches people to Healthy Working Life schemes and other work and health support in Kirklees.

**It is a prototype. The scheme details come from a draft pathways document and from web research, and may be out of date.**

## How it fits together

    browser  ->  GitHub Pages (site/)  ->  Cloudflare Worker (worker/)  ->  Claude API
                 static page + data         holds the API key, no storage

- `site/` is the page. GitHub Pages serves it. It is public.
- `data/services/` holds the scheme data, one file per scheme (215 at the moment: 31 Healthy Working Life schemes, 137 other services on the live list, and 47 waiting for the MVP team to review). Each has a `listing` decision: `include`, `review` or `exclude`. On deploy they are checked and combined into `services.json`, **the live list (only `include`)**, which is copied into the site and bundled into the Worker, so the page and the AI only ever see included services. Every service, whatever its decision, also goes into `services-all.json` for the MVP team's All services page.
- `prompt/system.md` is the instructions Claude follows. Bundled into the Worker.
- `worker/` is a small Cloudflare Worker. It holds the Anthropic API key, sends the scheme data and the conversation to Claude, and returns a short message, a list of matches (scheme id, how well it fits, a short reason and what to check first) and flags for urgent support and identifying details. The page draws the cards from `services.json`, so contact details are never written by the AI, and unknown or closed schemes are dropped.
- Nothing about a conversation is stored or logged. Workers Logs are switched off.
- People can send short feedback on a listing or a reply, and tell us what's missing. That is stored on the Worker, without any of the conversation (see [User feedback](#user-feedback)).

## Spend and abuse protection

The page is public, so these matter:

1. The Worker only accepts requests from the Pages origin (`ALLOWED_ORIGIN` in `worker/wrangler.toml`).
2. Per-IP limit of 10 requests a minute (Rate Limiting binding).
3. A hard global cap of `MAX_PER_DAY` chat requests a day (a small Durable Object holding a date and a number).
4. **Set a monthly spend limit in the Anthropic Console.** That is the real backstop.

## One-off setup

1. **Repo and Pages.** Settings > Pages > Build and deployment > Source: GitHub Actions.
2. **Cloudflare API token.** Cloudflare dashboard > My Profile > API Tokens > Create Token > "Edit Cloudflare Workers" template. In this repo: Settings > Secrets and variables > Actions > Secrets, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. **Deploy the Worker.** Actions > "Deploy Worker to Cloudflare" > Run workflow. Note the `https://hwl-service-finder.<your-subdomain>.workers.dev` address it creates.
4. **API key.** Cloudflare dashboard > Workers & Pages > hwl-service-finder > Settings > Variables and Secrets > add a secret called `ANTHROPIC_API_KEY`.
5. **Point the page at the Worker.** Settings > Secrets and variables > Actions > Variables, add `WORKER_URL` with the workers.dev address (no trailing slash).
6. **Deploy the page.** Actions > "Deploy site to GitHub Pages" > Run workflow. The page appears at `https://healthy-working-life-kirklees.github.io/<repo-name>/`.

If the repo name or organisation changes, update `ALLOWED_ORIGIN` in `worker/wrangler.toml`.

## Updating the data or prompt

Each scheme is its own file in `data/services/`, named after its id (for example `data/services/elevate.json`). To change a scheme, edit its file. To add one, add a file. The rules every file must follow are in `data/schema.json`, and the field-by-field guide is [`docs/data-dictionary.md`](docs/data-dictionary.md).

Before pushing, check and build:

    npm install          # once
    npm run check-data   # checks every scheme file against the schema and the other rules
    npm run build-data   # combines them into data/services.json (generated, not kept in the repository)

Push to a branch and open a pull request. The **Checks** workflow runs the data check and the Worker tests on every pull request. When it's merged to `main`, both deploys run the check again, build `services.json`, and publish. If the check fails, nothing is deployed. Editing `prompt/system.md` works the same way.

To make sure every change goes through a pull request, including changes made later by an automated maintenance agent: Settings > Branches > add a rule for `main` that requires a pull request and requires the **Checks** workflow to pass.

**Listing decisions.** A service's `listing.decision` says whether it's on the live list. Only `include` reaches the page and the AI. `review` (needs further review) and `exclude` (left out completely) stay in the data, so the reasons and research aren't lost, and show only on the MVP team's All services page. A service whose file still says "To be completed" can't be `include`: the check fails until someone fills in its details. The MVP team records decisions on the All services page (see [Reviewing which services are live](#reviewing-which-services-are-live)).

Keep `lastUpdated` honest: the page flags entries older than about 4.5 months, and `npm run check-data` lists them. Entries with `"open": false` are never recommended. Each scheme's `provenance` records where its details came from, so they can be rechecked.

The Worker sends Claude every scheme with each message, but without contact details, trigger words or provenance (`NOT_FOR_AI` in `worker/src/index.js`), which is about 45,000 tokens. The data block is cached between messages. If the list grows to several hundred schemes, the Worker should filter it (by area and audience, say) before sending it.

### What the Worker sends back to the page

`{ status, message, recommendations: [{ id, why, fit, check_first }], safety_concern, urgent_types, pii_detected, understood_needs, follow_up_questions }`

- `status` is `results` or `needs_more_info`. A reply that asks questions has no cards.
- At most two follow-up questions are asked in a whole chat. The page adds `(Follow-up questions asked: N)` to the history after a reply that asked questions, and the Worker counts it.
- When `safety_concern` is true there are never cards or questions. The crisis wording backstop in the Worker sets it even if the model doesn't.

### Urgent support contacts

The red panel always shows 999 and NHS 111, and the Single Point of Access number for mental health. For domestic abuse, child safeguarding and adult safeguarding there are no specific helplines yet. Add them to `URGENT_CONTACTS` at the top of the crisis panel code in `site/app.js` (one whole sentence each) once the programme team has checked them from an official source. Don't copy them from a general web search.

## Languages (English, Polish, Urdu)

The page has a language switcher in the header: English, Polski and اردو (Urdu). Urdu switches the page to right-to-left.

- All the page's own wording is in `site/i18n.js`, one block per language. To change a translation, edit it there and keep the keys the same in every language.
- The example questions on the landing page are in `chipsSelf` (someone looking for support for themselves) and `chipsStaff` (someone helping another person). The page shows them alternately, and clicking one also sets "Who is this for?" to match. Keep the two lists the same length so the mix stays even.
- **The Polish and Urdu text is a first draft. Have a qualified translator check it before the wider test**, especially the urgent support wording (the `crisis...` and `footer...` lines) and the feedback wording (the `fb...` lines: `fbCardLink`, `fbCardLegend`, the `fbReason...`, `fbNo...` and `fbGap...` lines, `fbTextLabel`, `fbTextNote`, `fbRedactWarn`, the `fbThanks...` lines, `fbServiceName`, `fbServiceWebsite`, `fbServiceArea`, `fbSupportLegend`, `fbSupportArea` and the button and error wording).
- The chosen language goes in the address (`?lang=pl` or `?lang=ur`), not in browser storage, so the page still stores nothing. A link ending `?lang=ur` opens the page in Urdu, which is handy for posters or leaflets.
- The page sends the language to the Worker, and the Worker tells Claude to reply in that language (`LANG_NOTES` in `worker/src/index.js`).
- Scheme details on the cards (names, who it is for, eligibility, routes) come from `services.json` and stay in English. They are marked as English so screen readers read them correctly.
- The crisis wording backstop (`CRISIS_RE`) and the `requiresMention` words in the scheme files include Polish and Urdu phrases, so the safety panel and the condition-specific schemes still work when someone writes in those languages. These lists are also a first draft for a translator to check and add to.
- Fonts for Polish letters and for Urdu (Noto Nastaliq Urdu) are in `site/fonts/`. A browser only downloads them when the page shows those characters.
- Switching language part-way through a chat leaves earlier messages and cards as they were. New replies come back in the new language.
- The MVP help page and issues log are English only.

## Accessibility options (text size, high contrast, read aloud)

A bar under the header lets people choose a larger text size (A, A+, A++) and switch on high contrast. The code is in `site/access.js`, the styles at the end of `site/style.css`, and the wording in `site/i18n.js` (`textSize`, `sizeNormal`, `sizeLarge`, `sizeLarger`, `contrast`, `listen`, `stop`, `listenTo`).

- The choices go in the address (`?size=2`, `?size=3`, `?contrast=high`), like the language, not in browser storage, so the page still stores nothing. A link such as `?size=3&contrast=high` opens the page that way.
- Each AI reply and each scheme card has a **Listen** button that reads it aloud using the voices built into the person's own device (the browser's speech synthesis). There is no extra service or cost. Device voices are preferred; some browsers (for example Chrome on a desktop) also offer online voices, which send the text to the browser maker to be spoken, and are only used when the device has no voice of its own for that language.
- Replies are read in the page's language and cards in English. If a device has no voice for a language (Urdu voices are often missing), the Listen buttons for that language are hidden.

## Local test of the Worker

    npm install && npm run build-data
    cd worker && npm install
    node test/mock-anthropic.mjs &
    npx wrangler dev --port 8787 --var ANTHROPIC_API_KEY:test-key --var ANTHROPIC_API_URL:http://127.0.0.1:9999
    # in another terminal
    bash test/smoke.sh

The mock stands in for the Anthropic API, so no real key or spend is involved.

## MVP team tools (help page and issues log)

For the initial MVP team only, not for the wider test.

- `mvp/help.html` is a help page for testers: how to use the finder, scenarios to try, what good looks like, known limits, and a table of the scheme data with overdue entries flagged.
- `mvp/services.html` lists every scheme and service, including those not on the live list, with search and filters (live list, team decision, type, level, area, category, health focus, audience, self-referral, review status, confidence, and gaps such as no phone). Each one links to its file on GitHub to edit it. Filters are kept in the address, so a filtered view can be shared as a link, and the list can be downloaded as CSV. Signed in with the team passcode, it's also where the team decides which services are live (below).
- `mvp/log.html` is a shared issues and actions log. Entries are stored on the Worker (one Durable Object), not in the repo, and are protected by a shared passcode. Add, filter, search, change status and priority, set an owner, add notes, and download everything as CSV. If the log is empty it offers to load the starter list in `mvp/seed-log.json`.
- `mvp/suggested-entries.json` holds packs of suggested log entries (for example the data-freshness options). The log page offers to add any whose title isn't already in the log, using the signed-in person's own session, and can append a note to an existing entry. To suggest more entries, add a pack to that file and push.
- These pages are deployed only when the repository variable `MVP_TOOLS` is exactly `true`. When it is, the main page also shows a small "MVP team only" bar linking to them.

### Reviewing which services are live

For each service, the MVP team decides one of three things on the All services page:

- **Include on the live list**: shown on the finder and given to the AI.
- **Needs further review**: kept off the live list until someone checks it. A reason is required.
- **Exclude completely**: kept off the live list for good (closed, out of area, not a service, a duplicate). A reason is required.

How it works:

1. Open **All services**, enter the team passcode (the same one as the issues log; signing in on either page signs in on both, for that browser tab) and your name or initials.
2. Filter to what you want to work through. "Live list: Waiting for review" shows the 47 services added for review. "Team decision: Not yet decided by the team" shows everything nobody has decided on yet.
3. For each service, choose include, further review or exclude, add a reason, and save. Decisions are stored on the Worker with the team log, so everyone sees them straight away, and a changed decision keeps the earlier ones as history. Nothing about a person is stored, only the service, the decision, the reason, the name or initials given and the time.
4. **Applying them.** A decision doesn't change the live finder by itself. Someone with the repository runs:

        WORKER_URL=https://hwl-service-finder.<subdomain>.workers.dev TEAM_PASSCODE='...' npm run apply-decisions

   (or saves the file from "Download the team's decisions" on the page and runs `npm run apply-decisions -- --input <file>`; add `--dry-run` to preview). It writes each decision, reason, name and date into the service's `listing` in `data/services/<id>.json` and prints a summary to paste into the pull request. Once the pull request is merged, the deploys rebuild the live list. Until then the page shows the service as "Decided, waiting to be applied". A service chosen for the live list whose details still say "To be completed" isn't applied; the summary lists it, so its details can be filled in first.

**Switch on:**
1. Cloudflare dashboard > Workers & Pages > hwl-service-finder > Settings > Variables and Secrets: add a **secret** called `TEAM_PASSCODE` (a long passphrase, 16+ characters). Share it with the team directly, not by chat or email to people outside the team.
2. GitHub repo > Settings > Secrets and variables > Actions > Variables: add `MVP_TOOLS` = `true`.
3. Re-run "Deploy site to GitHub Pages".

**Switch off (for the wider test):**
1. Set `MVP_TOOLS` to `false` (or delete it) and re-run the Pages deploy. The pages and the links disappear.
2. Delete the `TEAM_PASSCODE` secret. The log and decision routes then return 404.
3. Apply any outstanding listing decisions first (`npm run apply-decisions`), as they are stored with the log.
4. Export the log first if you want to keep it (Download as CSV on the log page).

The log must never hold personal or identifying information.

## User feedback

People who use the finder are often the first to notice that a listing is out of date, and coaches and frontline staff know services we haven't heard of. The page gives them three short ways to tell us:

1. **"Report a problem with this listing"** at the bottom of every scheme card. Tick boxes for what's wrong (closed, wrong contact details, wrong eligibility, no reply, not in my area, something useful missing, something else) and an optional comment.
2. **"Was this helpful?"** with Yes and No under every reply that shows cards. Not under urgent support replies or replies that ask questions. No opens a few tick boxes; "It missed a service I know about" opens the form below.
3. **"Know a service that should be here? Tell us"** under every result reply and in the page footer, so it can be used at any time. In staff mode it says "Do you refer people to a service that isn't listed? Tell us". It asks about a service that isn't listed (name, website, area), a kind of support someone looked for and couldn't find (a category and an area), or something else.

The code is in `site/feedback.js` (the page) and `worker/src/feedback.js` (the Worker). The wording is in `site/i18n.js` (the `fb...` keys).

**What is collected:** which kind of feedback it is, the date (no time), the scheme id (and the date the listing shown had last been checked), or the ids of the schemes shown in a reply, the boxes ticked, a comment of up to 300 characters, the details of a suggested service, the categories and area of a gap, the page's mode and language, and whether anything was removed from the text. Each entry also has a status (`New`, `Reviewed`, `Actioned`, `Not actioned`) and a reviewer note.

**What is deliberately not collected:** any of the conversation (no messages, no "what I have understood", nothing the AI wrote), IP addresses, browser details, times of day, names or contact details. The page asks people not to include names, contact details or anything about their own situation. Even so, email addresses, UK phone numbers, UK postcodes and National Insurance numbers are replaced with `[removed]`, first in the page before sending (the page tells the person it will do this) and again in the Worker before storing. The patterns are `REDACT_PATTERNS` in `worker/src/feedback.js`, with a copy in `site/feedback.js`; the tests check the two match. They can't catch everything (a person's name, for example), so read comments with that in mind. The page still stores nothing in the browser: no cookies, no local storage, no analytics.

**Protection:** sending feedback has the same checks as the chat: the Pages origin only, a 4 KB size limit, 5 a minute from one address (`FEEDBACK_LIMITER`), and a global cap of `MAX_FEEDBACK_PER_DAY` a day (300 by default, in `worker/wrangler.toml`). The Worker checks every value against fixed lists and the data (scheme ids, areas and categories), and rejects anything else.

**Where it is stored:** its own Durable Object (`FeedbackStore`, binding `FEEDBACK_STORE`), separate from the team log, so it keeps working when the log is switched off for the wider test.

**Retention:** entries older than 12 months are deleted. The check runs every time feedback is written or read.

**Switch on and off:** feedback is on unless `FEEDBACK_ENABLED` in `worker/wrangler.toml` is `"false"`. To switch it off, change it to `"false"` and merge (the Worker redeploys). Sending then returns 404, `/health` says `feedback: false`, and the page hides all the feedback links. Change it back to `"true"` to switch it on again. Entries already stored are kept, and can still be read.

**Reading the feedback (one-off setup):** Cloudflare dashboard > Workers & Pages > hwl-service-finder > Settings > Variables and Secrets: add a **secret** called `FEEDBACK_PASSCODE` (a long passphrase, 16+ characters). Share it only with the people who do the triage. Without it the read routes return 404, but people can still send feedback. The routes, with the passcode in an `X-Feedback-Passcode` header:

- `GET /feedback/items`, optionally `?status=New` and `?since=YYYY-MM-DD`
- `PATCH /feedback/items/<id>` with `{"status": "Actioned", "note": "Fixed in PR 23"}`
- `GET /feedback/export.csv`

**The digest:** a Markdown summary of the `New` entries, for the weekly triage (and later for the maintenance agent). It only reads; it changes nothing.

    WORKER_URL=https://hwl-service-finder.<subdomain>.workers.dev FEEDBACK_PASSCODE='...' npm run feedback-digest > digest.md

It has two parts. **What's wrong**: reports grouped by scheme, most reported first, with the reasons, the comments and the path to the scheme's file, and schemes with 2 or more reports in 30 days flagged at the top. **What's missing**: suggested services (grouped and counted, and checked against the names and websites of existing schemes, with likely duplicates marked), listings missing useful details, and the kinds of support people couldn't find, counted by category and area and compared with how many open schemes the data has for each category, so thin areas stand out. Then a count of Yes and No by mode and language. `--input <file>` works from a saved copy of `/feedback/items` instead.

**Weekly triage:**

1. Run the digest.
2. Decide what to do with each entry. Check the details with the service or its website; feedback is a lead, not a fact.
3. For a problem with a listing, change `data/services/<id>.json` (and its `lastUpdated` and `provenance`) in a pull request. For a suggested service, research it, and if it checks out add a new scheme file in a pull request (see `docs/data-dictionary.md`). Nothing is ever applied to the data automatically.
4. Mark each entry `Actioned` (with the pull request in the note) or `Not actioned` (with the reason), or `Reviewed` if it needs more time. For example:

        curl -X PATCH "$WORKER_URL/feedback/items/12" -H "X-Feedback-Passcode: $FEEDBACK_PASSCODE" -H 'content-type: application/json' -d '{"status":"Actioned","note":"PR 31"}'

**Before the wider test, the information governance lead should review this approach** (what is collected, the removal of personal details, the 12-month retention, and who holds the passcode).

## Tests

    npm run check-data             # the scheme data
    node worker/test/logic.mjs     # Worker logic, offline (model handling, guards, crisis backstop, team log, feedback, digest)
    bash test/run-ui.sh            # headless-browser test of the pages, with MVP tools on and off, and the feedback forms (Docker, or a local Playwright)
    python3 worker/test/live_chat.py   # real conversations against the live Worker (spends a few pence)

