# Kirklees Healthy Working Life Service Finder (prototype)

A proof of concept: a chat page that matches people to Healthy Working Life schemes and other work and health support in Kirklees.

**It is a prototype. The scheme details come from a draft pathways document and from web research, and may be out of date.**

## How it fits together

    browser  ->  GitHub Pages (site/)  ->  Cloudflare Worker (worker/)  ->  Claude API
                 static page + data         holds the API key, no storage

- `site/` is the page. GitHub Pages serves it. It is public.
- `data/services/` holds the scheme data, one file per scheme (168 at the moment: 31 Healthy Working Life schemes and 137 other local, regional and national services). On deploy they are checked and combined into `services.json`, which is copied into the site and bundled into the Worker.
- `prompt/system.md` is the instructions Claude follows. Bundled into the Worker.
- `worker/` is a small Cloudflare Worker. It holds the Anthropic API key, sends the scheme data and the conversation to Claude, and returns a short message, a list of matches (scheme id, how well it fits, a short reason and what to check first) and flags for urgent support and identifying details. The page draws the cards from `services.json`, so contact details are never written by the AI, and unknown or closed schemes are dropped.
- Nothing about a conversation is stored or logged. Workers Logs are switched off.

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
- **The Polish and Urdu text is a first draft. Have a qualified translator check it before the wider test**, especially the urgent support wording (the `crisis...` and `footer...` lines).
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
- `mvp/services.html` lists every scheme and service, with search and filters (type, level, area, category, health focus, audience, self-referral, review status, confidence, and gaps such as no phone). Each one links to its file on GitHub to edit it. Filters are kept in the address, so a filtered view can be shared as a link, and the list can be downloaded as CSV.
- `mvp/log.html` is a shared issues and actions log. Entries are stored on the Worker (one Durable Object), not in the repo, and are protected by a shared passcode. Add, filter, search, change status and priority, set an owner, add notes, and download everything as CSV. If the log is empty it offers to load the starter list in `mvp/seed-log.json`.
- `mvp/suggested-entries.json` holds packs of suggested log entries (for example the data-freshness options). The log page offers to add any whose title isn't already in the log, using the signed-in person's own session, and can append a note to an existing entry. To suggest more entries, add a pack to that file and push.
- These pages are deployed only when the repository variable `MVP_TOOLS` is exactly `true`. When it is, the main page also shows a small "MVP team only" bar linking to them.

**Switch on:**
1. Cloudflare dashboard > Workers & Pages > hwl-service-finder > Settings > Variables and Secrets: add a **secret** called `TEAM_PASSCODE` (a long passphrase, 16+ characters). Share it with the team directly, not by chat or email to people outside the team.
2. GitHub repo > Settings > Secrets and variables > Actions > Variables: add `MVP_TOOLS` = `true`.
3. Re-run "Deploy site to GitHub Pages".

**Switch off (for the wider test):**
1. Set `MVP_TOOLS` to `false` (or delete it) and re-run the Pages deploy. The pages and the links disappear.
2. Delete the `TEAM_PASSCODE` secret. The log routes then return 404.
3. Export the log first if you want to keep it (Download as CSV on the log page).

The log must never hold personal or identifying information.

## Tests

    npm run check-data             # the scheme data
    node worker/test/logic.mjs     # Worker logic, offline (model handling, guards, crisis backstop, team log)
    bash test/run-ui.sh            # headless-browser test of the pages, with MVP tools on and off (needs Docker)
    python3 worker/test/live_chat.py   # real conversations against the live Worker (spends a few pence)

