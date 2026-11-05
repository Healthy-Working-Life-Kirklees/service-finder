# Kirklees Healthy Working Life Support Finder (prototype)

A proof of concept: a chat page that matches people to Healthy Working Life schemes and other work and health support in Kirklees.

**It is a prototype. The scheme details come from a draft pathways document and from web research, and may be out of date.**

The tool's name is **Healthy Working Life Support Finder** (it was called the Service Finder until November 2026). The GitHub repo, the web address and the Cloudflare Worker (`hwl-service-finder`) still use the old name on purpose: renaming those would change the live addresses and lose the Worker's secrets.

## How it fits together

    browser  ->  GitHub Pages (site/)  ->  Cloudflare Worker (worker/)  ->  Claude API
                 static page + data         holds the API key, no storage

- `site/` is the page. GitHub Pages serves it. It is public.
- `data/services/` holds the scheme data, one file per scheme (215 at the moment: 31 Healthy Working Life schemes, 137 other services on the live list, and 47 waiting for the development team to review). Each has a `listing` decision: `include`, `review` or `exclude`. On deploy they are checked and combined into `services.json`, **the live list (only `include`)**, which is copied into the site and bundled into the Worker, so the page and the AI only ever see included services. Every service, whatever its decision, also goes into `services-all.json` for the All services page in Admin.
- `prompt/system.md` is the instructions Claude follows. Bundled into the Worker.
- `worker/` is a small Cloudflare Worker. It holds the Anthropic API key, sends the scheme data and the conversation to Claude, and returns a short message, a list of matches (scheme id, how well it fits, a short reason and what to check first) and flags for urgent support and identifying details. The page draws the cards from `services.json`, so contact details are never written by the AI, and unknown or closed schemes are dropped.
- Nothing about a conversation is stored or logged. Workers Logs are switched off.
- People can send short feedback on a listing or a reply, and tell us what's missing. That is stored on the Worker, without any of the conversation (see [User feedback](#user-feedback)).

## Spend and abuse protection

The page is public, so these matter:

1. The Worker only accepts requests from the site's own addresses (`ALLOWED_ORIGIN` in `worker/wrangler.toml`, a comma-separated list: https://hwlsupportfinder.org.uk and the GitHub Pages address).
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

If the site's domain, the repo name or the organisation changes, update `ALLOWED_ORIGIN` in `worker/wrangler.toml`, or the page can't reach the Worker: searches fail and the feedback links don't appear.

## "Who is this for?"

There is no default: the person has to choose "for myself" or "helping someone else" before searching, so the reply is worded for the right person. If they don't, the page asks them to and sends nothing. Start again clears the choice. After every set of results there is an "other options" button; the prompt tells the AI not to repeat services already shown.

## Updating the data or prompt

Each scheme is its own file in `data/services/`, named after its id (for example `data/services/elevate.json`). To change a scheme, edit its file. To add one, add a file. The rules every file must follow are in `data/schema.json`, and the field-by-field guide is [`docs/data-dictionary.md`](docs/data-dictionary.md).

Before pushing, check and build:

    npm install          # once
    npm run check-data   # checks every scheme file against the schema and the other rules
    npm run build-data   # combines them into data/services.json (generated, not kept in the repository)

Push to a branch and open a pull request. The **Checks** workflow runs the data check and the Worker tests on every pull request. When it's merged to `main`, both deploys run the check again, build `services.json`, and publish. If the check fails, nothing is deployed. Editing `prompt/system.md` works the same way.

To make sure every change goes through a pull request, including changes made later by an automated maintenance agent: Settings > Branches > add a rule for `main` that requires a pull request and requires the **Checks** workflow to pass.

**Listing decisions.** A service's `listing.decision` says whether it's on the live list. Only `include` reaches the page and the AI. `review` (needs further review) and `exclude` (left out completely) stay in the data, so the reasons and research aren't lost, and show only on the All services page in Admin. A service whose file still says "To be completed" can't be `include`: the check fails until someone fills in its details. The development team records decisions on the All services page (see [Reviewing which services are live](#reviewing-which-services-are-live)).

Keep `lastUpdated` honest: the page flags entries older than about 4.5 months, and `npm run check-data` lists them. Entries with `"open": false` are never recommended. Each scheme's `provenance` records where its details came from, so they can be rechecked.

The Worker sends Claude every scheme with each message, but without contact details, trigger words or provenance (`NOT_FOR_AI` in `worker/src/index.js`), which is about 45,000 tokens. The data block is cached between messages. If the list grows to several hundred schemes, the Worker should filter it (by area and audience, say) before sending it.

### What the Worker sends back to the page

`{ status, message, recommendations: [{ id, why, fit, check_first }], safety_concern, urgent_types, pii_detected, understood_needs, follow_up_questions }`

- `status` is `results` or `needs_more_info`. A reply that asks questions has no cards.
- At most two follow-up questions are asked in a whole chat. The page adds `(Follow-up questions asked: N)` to the history after a reply that asked questions, and the Worker counts it.
- When `safety_concern` is true there are never cards or questions. The crisis wording backstop in the Worker sets it even if the model doesn't.

### Urgent support contacts

The red panel always shows 999 and NHS 111, and the Single Point of Access number for mental health. For domestic abuse, child safeguarding and adult safeguarding there are no specific helplines yet. Add them to `URGENT_CONTACTS` at the top of the crisis panel code in `site/app.js` (one whole sentence each) once the programme team has checked them from an official source. Don't copy them from a general web search.

## "What's changed" page

`site/changes.html` lists the changes coaches testing the prototype might notice, newest first. It's linked from the prototype notice at the top of the main page ("See what's changed"). When you make a change they'll notice, add a plain-English line to the top of it in the same commit. Leave out behind-the-scenes and Admin-only work. The page is in English only; the link says "(EN)" in Polish and Urdu.

## Languages (English, Polish, Urdu)

The page has a language switcher in the header: English, Polski and اردو (Urdu). Urdu switches the page to right-to-left.

- All the page's own wording is in `site/i18n.js`, one block per language. To change a translation, edit it there and keep the keys the same in every language.
- **The Polish and Urdu text is a first draft. Have a qualified translator check it before the wider test**, especially the urgent support wording (the `crisis...` and `footer...` lines) and the feedback wording (the `fb...` lines: `fbCardLink`, `fbCardLegend`, the `fbReason...`, `fbNo...` and `fbGap...` lines, `fbTextLabel`, `fbTextNote`, `fbRedactWarn`, the `fbThanks...` lines, `fbServiceName`, `fbServiceWebsite`, `fbServiceArea`, `suggest...`, `fbRole...`, `fbNeedRole`, `fbProviderPrompt` and the other service-detail lines, `fbSupportLegend`, `fbSupportArea` and the button and error wording).
- The chosen language goes in the address (`?lang=pl` or `?lang=ur`), not in browser storage, so the page still stores nothing. A link ending `?lang=ur` opens the page in Urdu, which is handy for posters or leaflets.
- The page sends the language to the Worker, and the Worker tells Claude to reply in that language (`LANG_NOTES` in `worker/src/index.js`).
- Scheme details on the cards (names, who it is for, eligibility, routes) come from `services.json` and stay in English. They are marked as English so screen readers read them correctly.
- The crisis wording backstop (`CRISIS_RE`) and the `requiresMention` words in the scheme files include Polish and Urdu phrases, so the safety panel and the condition-specific schemes still work when someone writes in those languages. These lists are also a first draft for a translator to check and add to.
- Fonts for Polish letters and for Urdu (Noto Nastaliq Urdu) are in `site/fonts/`. A browser only downloads them when the page shows those characters.
- Switching language part-way through a chat leaves earlier messages and cards as they were. New replies come back in the new language.
- The Admin pages are English only.

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

## Admin (for the development team)

The Admin section (`admin/`) is for the Support Finder development team (Phil, Lewis and anyone else given the team passcode). The main page has one small **Admin** link at the bottom, which goes to the Admin home page, `admin/index.html`. Every Admin page needs you to sign in with the team passcode first: see [One sign-in for Admin](#one-sign-in-for-admin).

- `admin/index.html` is the Admin home: the sign-in, then links to the pages below.
- `admin/help.html` is a help page for testers: how to use the finder, scenarios to try, what good looks like, known limits, and a table of the scheme data with overdue entries flagged.
- `admin/services.html` lists every scheme and service, including those not on the live list, with search and filters (live list, team decision, type, level, area, category, health focus, audience, self-referral, review status, confidence, and gaps such as no phone). Each one links to its file on GitHub to edit it. Filters are kept in the address, so a filtered view can be shared as a link, and the list can be downloaded as CSV. Signed in with the team passcode, it's also where the team decides which services are live and edits a service's details (below).
- `admin/log.html` is a shared issues and actions log. Entries are stored on the Worker (one Durable Object), not in the repo, and are protected by a shared passcode. Add, filter, search, change status and priority, set an owner, add notes, and download everything as CSV. If the log is empty it offers to load the starter list in `admin/seed-log.json`.
- `admin/suggested-entries.json` holds packs of suggested log entries (for example the data-freshness options). The log page offers to add any whose title isn't already in the log, using the signed-in person's own session, and can append a note to an existing entry. To suggest more entries, add a pack to that file and push.
- `admin/feedback.html` shows the anonymous usage counts and the feedback people sent (below).
- The Admin pages are always deployed with the site. Until November 2026 they were at `/mvp/` and only deployed when the repository variable `MVP_TOOLS` was `true`. That variable is no longer used and can be deleted; the old `/mvp/` addresses redirect to Admin.

### Reviewing which services are live, editing details and adding services

For each service, the development team decides one of three things on the All services page:

- **Include on the live list**: shown on the finder and given to the AI.
- **Needs further review**: kept off the live list until someone checks it. A reason is required.
- **Exclude completely**: kept off the live list for good (closed, out of area, not a service, a duplicate). A reason is required.

How it works:

1. Sign in on the Admin home page with the team passcode and your name or initials (see [One sign-in for Admin](#one-sign-in-for-admin)), then open **All services**.
2. Filter to what you want to work through. "Live list: Waiting for review" shows the 47 services added for review. "Team changes: Not yet decided by the team" shows everything nobody has decided on yet.
3. For each service, choose include, further review or exclude, add a reason, and save. Decisions are stored on the Worker with the team log, so everyone sees them straight away, and a changed decision keeps the earlier ones as history. Nothing about a person is stored, only the service, the decision, the reason, the name or initials given and the time.
4. **Editing details.** "Edit details" on any service opens a form with its details: name, contact details, who it's for, areas, categories, eligibility, how to get in, self-referral, what it offers and so on. Boxes still saying "To be completed" are highlighted. Say what changed and why, and tick "I have checked these details are current" if you checked them with the provider or its website (that sets the "last checked" date when applied). Only the fields that differ from the data are saved, with what the data said at the time. The changes show on the service, old and new, until they are applied, and can be discarded. One set of waiting changes is kept per service; editing again replaces it. The Worker checks every value against the same rules as the data (`worker/src/serviceedit.js`, using `data/schema.json`). The id, logo, trigger words (`requiresMention`), HWL flag and listing decision can't be changed this way.
5. **Adding a new service.** "Add a service" (above the list, once signed in) opens the same form, empty, plus an id for its file (made from the name). Say where the service came from and why it should be added. Before saving, the page checks for a service with the same or a very similar name, or the same web site, and asks you to confirm if it finds one. A new service is listed as **"New: not yet in the data"** (the "Live list" filter has an option for these). The team reviews it exactly like any other: anyone can edit it, decide include, further review or exclude, or discard it. It is stored on the Worker until the team's changes are next applied, when it becomes `data/services/<id>.json`, as "waiting for review" unless the team has already decided. **A new service never goes live without a team decision to include it.**
6. **Applying them.** New services, decisions and edits don't change the live finder by themselves. To apply them, on GitHub go to **Actions > Apply team changes > Run workflow** (tick "Preview only" first to see what would change). It fetches the team's new services, decisions and edits from the Worker, creates a file for each new service, writes the edited details and then each decision, reason, name and date into `data/services/<id>.json`, runs the data check and the Worker tests, and opens a pull request whose description lists every change, with old and new values. Merge that pull request and the deploys rebuild the live list. Until then the page shows "waiting to be applied". Running it again when nothing is new opens nothing.

   One-off setup for the button: in Settings > Secrets and variables > Actions, add a **secret** called `TEAM_PASSCODE` with the same value as the Worker's `TEAM_PASSCODE` (the `WORKER_URL` variable is already there for the Pages deploy). In Settings > Actions > General > Workflow permissions, tick **Allow GitHub Actions to create and approve pull requests**. Pull requests opened by the workflow don't trigger the Checks workflow (GitHub doesn't let one workflow's pull request start another), which is why the workflow runs the same checks itself; both deploys check the data again on merge.

   **Apply changes now (the quick way).** Once it's switched on (below), anyone signed in on the All services page can press **Apply changes now** under the sign-in box. The Worker (`worker/src/applynow.js`) starts this same workflow with `auto_merge` on: if the data check and Worker tests pass, it opens the pull request, merges it straight away and starts both deploys (a merge made by the workflow doesn't start them by itself), so the changes are live on the finder, the AI and the printable directory in about 3 minutes. The page follows the run and says when the changes are live, or that the check failed and nothing changed, with a link to the run. If the check fails nothing is merged, and the team's changes stay saved. The merged pull request stays on GitHub as the record of what changed and who asked. Run from GitHub's Actions tab, the workflow still opens a pull request and waits for you to merge it (unless you tick "Put the changes live straight away").

   This means anyone with the team passcode can put changes live without a review on GitHub. To switch it off, delete the `GH_ACTIONS_TOKEN` secret: the button disappears and the page goes back to saying "Phil: Actions > Apply team changes".

   One-off setup to switch it on:
   1. On GitHub, create a fine-grained personal access token (your picture > Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token). Resource owner: **Healthy-Working-Life-Kirklees**. Repository access: **Only select repositories** > `service-finder`. Permissions: **Repository permissions > Actions: Read and write**, nothing else. It can start and read workflow runs in this repository only; it can't change code or data itself. Pick an expiry (up to a year) and note when it runs out: the button stops working then, and says GitHub wouldn't start the update. If the organisation needs to approve fine-grained tokens, an owner approves it under the organisation's Settings > Personal access tokens.
   2. In Cloudflare: Workers > hwl-service-finder > Settings > Variables and Secrets > Add, type **Secret**, name `GH_ACTIONS_TOKEN`, value the token. Save and deploy.
   3. "Allow GitHub Actions to create and approve pull requests" (above) needs to be ticked, as it already is for the workflow.

   The repository is the `GH_REPO` variable in `worker/wrangler.toml`.

   The same thing can be run from a copy of the repository: `WORKER_URL=... TEAM_PASSCODE='...' npm run apply-decisions`, or `npm run apply-decisions -- --input <file>` with the file from "Download the team's changes" (add `--dry-run` to preview). It prints the same summary.

   It holds back, and lists in the summary: a new service whose id is already taken, or with the same name and organisation as one already in the data; an edit to a field that has been changed in the data since the edit was made (so nobody's change is overwritten), an edit that wouldn't pass the data check, and a service chosen for the live list whose details still say "To be completed".

### One sign-in for Admin

There is **one team passcode**, the Worker secret `TEAM_PASSCODE`, for every Admin page: Help, All services (decisions, edits, new services, Apply changes now), the issues and actions log, and feedback and usage. You sign in on the Admin home page, which checks the passcode with the Worker; the other pages then open without asking again. Opening any Admin page without signing in takes you to the Admin home to sign in, and then back to that page. The passcode and your name or initials are kept in that browser tab only (sessionStorage) until it's closed, and "Sign out" in the Admin bar, or on any page, signs you out of all of them. The shared code is `admin/team-auth.js`, loaded in the `<head>` of every Admin page.

The pages themselves are plain files on GitHub Pages (and the code is public), so the sign-in is a front door rather than a lock: what actually protects the team's data (the log, decisions, edits, feedback and usage) is that the Worker only sends it with the right passcode. The Help page and the list of every service hold nothing that isn't already in the public repository. The Worker checks the same secret on `/log/*`, `/feedback/*` (reading) and `/usage/*` (reading); it accepts it in an `X-Team-Passcode` header, or `X-Feedback-Passcode` for older scripts.

Until November 2026 feedback and usage had a separate `FEEDBACK_PASSCODE`. It is no longer used: delete it from the Worker's secrets.

**Switch on:** Cloudflare dashboard > Workers & Pages > hwl-service-finder > Settings > Variables and Secrets: add a **secret** called `TEAM_PASSCODE` (a long passphrase, 16+ characters). Share it with the team directly, not by chat or email to people outside the team. To add someone to the team, give them the passcode; to remove someone, change the passcode and give the new one to everyone else.

**Switch off:**
1. Delete the `TEAM_PASSCODE` secret. The log, decision, edit, new-service, feedback-reading and usage-reading routes then return 404 (people can still send feedback).
3. Apply any outstanding new services, decisions and edits first (Actions > Apply team changes), as they are stored with the log.
4. Export the log first if you want to keep it (Download as CSV on the log page).

The log must never hold personal or identifying information.

## Anonymous usage counts

The Worker keeps **daily tallies only**, for the review team to see how the finder is used: page visits, conversations started, searches (and whether they found services, found none, asked a question or showed urgent support), which services were shown, which links on a card were opened (referral, website, phone, email, directions, map), "Copy details", Listen, text size and high contrast, "other options", and the answers to "Did you get in touch?". The code is `worker/src/usage.js` (Worker) and `site/usage.js` (page).

**What is not collected:** IP addresses, any user or session id, cookies or browser storage, times of day, browser details, or anything anyone typed. Each count is just a date, the kind of event, and where relevant a scheme id, the kind of link or answer, the page language and "who is this for". The Worker checks every event against fixed lists and the scheme ids and rejects anything else. Searches are counted by the Worker itself when it answers, not by the page. The privacy note under the chat box says these counts are kept.

**Unique users:** the site deliberately doesn't recognise returning visitors, so it can't count unique people. "Conversations started" (a first message) is the nearest honest measure; "page visits" counts every page load.

**"Did you get in touch?":** when someone comes back to the page after opening a card's referral, website, phone or email link, that card asks (once) "Did you get in touch with ...?" (staff: "Did you make a referral to ...?") with Yes / Not yet / No. Nothing stops them on the way out.

**Where and how long:** its own Durable Object (`UsageStore`, binding `USAGE_STORE`). Tallies older than 24 months are deleted. A daily cap (`MAX_USAGE_PER_DAY`, 20,000 by default) and a per-address limit (`USAGE_LIMITER`, 60 a minute) stop the counts being flooded.

**Reading:** on the Feedback and usage page, signed in with the team passcode, or `GET /usage/days` (optionally `?since=YYYY-MM-DD`) and `GET /usage/export.csv` with the team passcode in an `X-Team-Passcode` header.

**Switch off:** set `USAGE_ENABLED` in `worker/wrangler.toml` to `"false"` and merge. The page then sends nothing.

## User feedback

People who use the finder are often the first to notice that a listing is out of date, and coaches and frontline staff know services we haven't heard of. The page gives them three short ways to tell us:

1. **"Report a problem with this listing"** at the bottom of every scheme card. Tick boxes for what's wrong (closed, wrong contact details, wrong eligibility, no reply, not in my area, something useful missing, something else) and an optional comment.
2. **"Was this helpful?"** with Yes and No under every reply that shows cards. Not under urgent support replies or replies that ask questions. No opens a few tick boxes; "It missed a service I know about" opens the form below.
3. **"Know a service that should be here? Tell us"** under every result reply. In staff mode it says "Do you refer people to a service that isn't listed? Tell us". It asks about a service that isn't listed, a kind of support someone looked for and couldn't find (a category and an area), or something else.
4. **"Suggest a service"** in the header bar, so it can be used at any time (an icon button at phone width). It opens the same form in a panel at the top of the page, with nothing chosen. "What's missing?" is a choice of one: a service, a kind of support, or something else. It is not in the emergency footer. At laptop widths (about 1150 to 1500 pixels) the logo is a little smaller, "Text size" is read out but not shown, and below 1300 pixels the high contrast button shows its icon only, so the logo and all the header buttons fit on one line.

**Suggesting a service:** three things are needed: whether the person is from the service or suggesting it, the service's name, and the organisation that runs it. The form first asks only "Are you from this service, or suggesting it?"; nothing else shows until they answer, and the Worker refuses a suggestion without all three. The two names are labelled "(mandatory)"; if either is left empty, the form puts a red box and "This is mandatory" on it and jumps back to the first one. Nothing on the form is labelled "optional". Someone **suggesting** a service sees five boxes (name of the service, name of organisation, website, phone number, area it covers), then "Know more about it? Add what you know (optional)", folded and closed until they open it, with the other listing questions. Someone **from the service** sees a prompt to fill in as much as they can, then the full questionnaire in five sections, in the order of a listing: About the service (name, organisation, website, what it does, what happens and where, running now, dates); Who it's for (who it is for, age range, who can use it with two examples, who it isn't for, whether a health condition is needed, and "Which conditions?" when they choose "Yes, a specific condition", kinds of support); Where it runs (area, area covered, addresses, online or phone only); Contact and referral (phone, email, social media, how to get referred, self-referral, cost, languages, work experience or volunteering); And finally (permission to use the logo, an optional work contact name). The same boxes are moved between the two layouts, so nothing typed is lost if someone changes their answer.

**From suggestion to listing:** suggestions show in full on the Feedback and usage page, which can filter to "Services sent in by the service itself" or "Services suggested by someone who knows them". **Start a new listing from this** opens "Add a service" on All services with the boxes filled in from the suggestion (name, organisation, website, contact details, who it's for, eligibility, areas, categories, self-referral, status and so on) and a note saying where it came from and what to check. The details pass through this browser tab only and are removed as soon as the form opens; the contact name is never passed on. The team checks everything with the service and finishes the listing; it is added for review like any other, never put live automatically.

The code is in `site/feedback.js` (the page) and `worker/src/feedback.js` (the Worker). The wording is in `site/i18n.js` (the `fb...` keys).

During the pilot there is a fourth, fuller form for testers:

4. **"Give pilot feedback"**, a band near the top of the page with a button that opens the form. It asks which best describes the feedback (found something useful, missed a service, suggested something unsuitable, hard to use, something broken, an idea, something else), what happened (required, up to 1,500 characters), whether they or the person went on to contact a suggested service, how easy the tool was to use this time (1 to 5), and, only if they tick "Yes, you can contact me", their name and work email. It also sends the ids of the schemes in the latest reply (never what was typed), so we know what they were shown. It is English only, like the Admin pages. It appears only when `PILOT_FEEDBACK` is `"true"`, which is set in `[vars]` in `worker/wrangler.toml`. To hide it after the pilot, change it to `"false"` and merge. Testers can send as many as they like: feedback is ongoing, not a survey at the end.

**What is collected:** which kind of feedback it is, the date (no time), the scheme id (and the date the listing shown had last been checked), or the ids of the schemes shown in a reply, the boxes ticked, a comment of up to 300 characters, the details of a suggested service (including the service's own phone, email and address, and an optional work contact name for someone from the service), the categories and area of a gap, the page's mode and language, and whether anything was removed from the text. Each entry also has a status (`New`, `Reviewed`, `Actioned`, `Not actioned`) and a reviewer note.

**What is deliberately not collected:** any of the conversation (no messages, no "what I have understood", nothing the AI wrote), IP addresses, browser details, times of day, or the names or contact details of the people using the finder. The page asks people not to include names, contact details or anything about their own situation. Even so, email addresses, UK phone numbers, UK postcodes and National Insurance numbers are replaced with `[removed]` in the comment and the suggested service's name, first in the page before sending (the page tells the person it will do this) and again in the Worker before storing. The patterns are `REDACT_PATTERNS` in `worker/src/feedback.js`, with a copy in `site/feedback.js`; the tests check the two match. They can't catch everything (a person's name, for example), so read comments with that in mind. A suggested service's contact details are kept as written, since they are the service's own work details; the form asks people not to give anyone's personal details. The page still stores nothing in the browser: no cookies, no local storage, no analytics. The one exception is a pilot tester's own name and work email, kept only when they tick "Yes, you can contact me". Those are about the tester, not anyone they were helping, and are not removed. They show on the review page and in the CSV, but not in the digest.

**Protection:** sending feedback has the same checks as the chat: the Pages origin only, a 4 KB size limit (16 KB for a "what's missing" entry, so a full service suggestion fits), 5 a minute from one address (`FEEDBACK_LIMITER`), and a global cap of `MAX_FEEDBACK_PER_DAY` a day (300 by default, in `worker/wrangler.toml`). The Worker checks every value against fixed lists and the data (scheme ids, areas and categories), and rejects anything else.

**Where it is stored:** its own Durable Object (`FeedbackStore`, binding `FEEDBACK_STORE`), separate from the team log, so it keeps working when the log is switched off for the wider test.

**Retention:** entries older than 12 months are deleted. The check runs every time feedback is written or read.

**Switch on and off:** feedback is on unless `FEEDBACK_ENABLED` in `worker/wrangler.toml` is `"false"`. To switch it off, change it to `"false"` and merge (the Worker redeploys). Sending then returns 404, `/health` says `feedback: false`, and the page hides all the feedback links. Change it back to `"true"` to switch it on again. Entries already stored are kept, and can still be read.

**Feedback emails:** each new entry, apart from a plain "Yes, it was helpful", is also emailed to the admins after it is stored, with a link to the review page. The email holds only what was stored (with personal details already removed) plus scheme names, and replying to a pilot entry goes straight to the tester if they asked to be contacted. A failed email never loses the feedback. The code is `worker/src/notify.js`. It needs three things: the `FEEDBACK_EMAIL` binding and `FEEDBACK_EMAIL_FROM` (`feedback@hwlsupportfinder.org.uk`), both in `worker/wrangler.toml`, and the `FEEDBACK_EMAIL_TO` **secret**: the admins' addresses, comma-separated. It is a secret so personal addresses stay out of this public repo. If any of the three is missing, nothing is sent.

The emails go straight to the admins' own addresses, not to `admin@hwlsupportfinder.org.uk`. Sending to **verified destination addresses** is free on the Workers Free plan, even with only Email Routing switched on; sending anywhere else needs Email Sending, which is only on Workers Paid. One-off setup in Cloudflare:

1. Email Service > Email Routing > Destination addresses: add each admin's address. Each admin clicks the link in Cloudflare's verification email.
2. Workers & Pages > hwl-service-finder > Settings > Variables and Secrets: add a **secret** called `FEEDBACK_EMAIL_TO` with the addresses, comma-separated (for example `first@example.org,second@example.org`).
3. Send a test from the "Give pilot feedback" form on the live page, and check it arrives for everyone (and isn't in spam).

To add or remove an admin, verify the new address (step 1) and edit the secret. To stop emails without touching feedback, delete the secret.

**The Feedback and usage page (for the development team):** `admin/feedback.html`, linked from the Admin home page. The top part shows the anonymous usage counts with charts (see [Anonymous usage counts](#anonymous-usage-counts)); the rest is the feedback. Like the other Admin pages it needs the team passcode. It shows, for the last 7, 30 or 90 days or everything: how many people said results were helpful (split by who it was for and by language), why people said No, which services have problem reports, and what people said was missing. Below that is the feedback to read (plain "Yes" answers are hidden by default), with a status and a reviewer note on each entry, and a button to download everything as CSV. The code is `admin/feedback.js`; it uses the same routes as below, so the Worker needs no change.

**Reading the feedback:** uses the team passcode (`TEAM_PASSCODE`; see [One sign-in for Admin](#one-sign-in-for-admin)). Without it the read routes return 404, but people can still send feedback. The routes, with the passcode in an `X-Team-Passcode` header:

- `GET /feedback/items`, optionally `?status=New` and `?since=YYYY-MM-DD`
- `PATCH /feedback/items/<id>` with `{"status": "Actioned", "note": "Fixed in PR 23"}`
- `GET /feedback/export.csv`

**The digest:** a Markdown summary of the `New` entries, for the weekly triage (and later for the maintenance agent). It only reads; it changes nothing.

    WORKER_URL=https://hwl-service-finder.<subdomain>.workers.dev TEAM_PASSCODE='...' npm run feedback-digest > digest.md

It has two parts. **What's wrong**: reports grouped by scheme, most reported first, with the reasons, the comments and the path to the scheme's file, and schemes with 2 or more reports in 30 days flagged at the top. **What's missing**: suggested services (grouped and counted, and checked against the names and websites of existing schemes, with likely duplicates marked), listings missing useful details, and the kinds of support people couldn't find, counted by category and area and compared with how many open schemes the data has for each category, so thin areas stand out. Then a count of Yes and No by mode and language. `--input <file>` works from a saved copy of `/feedback/items` instead.

**Weekly triage:**

1. Run the digest.
2. Decide what to do with each entry. Check the details with the service or its website; feedback is a lead, not a fact.
3. For a problem with a listing, change `data/services/<id>.json` (and its `lastUpdated` and `provenance`) in a pull request. For a suggested service, research it, and if it checks out add a new scheme file in a pull request (see `docs/data-dictionary.md`). Nothing is ever applied to the data automatically.
4. Mark each entry `Actioned` (with the pull request in the note) or `Not actioned` (with the reason), or `Reviewed` if it needs more time. For example:

        curl -X PATCH "$WORKER_URL/feedback/items/12" -H "X-Team-Passcode: $TEAM_PASSCODE" -H 'content-type: application/json' -d '{"status":"Actioned","note":"PR 31"}'

**Before the wider test, the information governance lead should review this approach** (what is collected, the removal of personal details, the 12-month retention, and who holds the passcode).

## Tests

    npm run check-data             # the scheme data
    node worker/test/logic.mjs     # Worker logic, offline (model handling, guards, crisis backstop, team log, feedback, digest)
    bash test/run-ui.sh            # headless-browser test of the main page, the Admin pages and the feedback forms (Docker, or a local Playwright)
    python3 worker/test/live_chat.py   # real conversations against the live Worker (spends a few pence)

