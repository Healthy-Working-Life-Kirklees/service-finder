# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is a Healthy Working Life Kirklees project. Programme and scheme background:

@C:/Users/phill/brain/context/hwl/AGENTS.md

## What this is

A public prototype chat page that matches people to Healthy Working Life schemes in Kirklees. No build step and no framework: plain HTML/JS/CSS on GitHub Pages, plus one Cloudflare Worker that holds the Anthropic API key and calls Claude.

    browser -> GitHub Pages (site/, + mvp/ when switched on) -> Cloudflare Worker (worker/) -> Claude API

`README.md` has the one-off setup, the MVP tools switch on/off steps, and the response shape. `docs/data-dictionary.md` is the field-by-field guide to `data/services.json`.

## Commands

    node worker/test/logic.mjs          # main test: Worker logic offline, mocked fetch, no spend
    bash test/run-ui.sh                 # headless Playwright test of the pages, MVP on and off (needs Docker)
    python3 worker/test/live_chat.py 4 7   # live scenarios against the deployed Worker; spends real credit
    REPEAT=3 python3 worker/test/live_chat.py 4

Local Worker with a mock Anthropic API (no key, no spend):

    cd worker && npm install
    node test/mock-anthropic.mjs &
    npx wrangler dev --port 8787 --var ANTHROPIC_API_KEY:test-key --var ANTHROPIC_API_URL:http://127.0.0.1:9999
    bash test/smoke.sh

There is no linter or single-test runner. `logic.mjs` is one script of `check(...)` calls; to focus on one case, run it and read the PASS/FAIL lines. Ask before running `live_chat.py`, as it costs money and hits the per-IP limit of 10 requests a minute.

Deploys happen on push to `main` via `.github/workflows/`: `pages.yml` (site/, mvp/, data/) and `worker.yml` (worker/, data/, prompt/). A change to `data/` redeploys both. Pushes to `experimental` deploy a separate preview instead (`preview.yml`: one Worker, `[env.preview]` in `worker/wrangler.toml`, serving the pages and `/chat` together); it never touches the live site or Worker.

## Architecture that spans files

- **One data file, two consumers.** `data/services.json` is bundled into the Worker (sent to Claude on every request, with prompt caching) and copied into the site as `services.json`. The model only returns scheme ids; the page draws the cards, including contact details, from `services.json`. The AI never writes contact details.
- **The Worker is the guardrail, not the prompt.** `worker/src/index.js` post-processes the model's `respond` tool call: it drops unknown ids, schemes with `open: false`, duplicates, and `requiresMention` schemes the person's own words don't match. It also runs a `CRISIS_RE` backstop that forces `safety_concern` with no cards, whatever the model said. Rules that matter for safety belong in the Worker; `prompt/system.md` is the soft layer.
- **Follow-up question limit is counted from the transcript.** The page appends `(Follow-up questions asked: N)` to assistant turns; the Worker sums these (`ASKED_RE`, `MAX_QUESTIONS = 2`) and narrows the tool schema when none are left. Changing either side means changing both.
- **Model-dependent request shape.** For `claude-(sonnet|opus)-5*` the Worker sets `thinking: { type: 'between_tools' }` and does not force `tool_choice`; other models get a forced tool call. The model is `ANTHROPIC_MODEL` in `worker/wrangler.toml`. If the model answers in plain text, the Worker shows it as a message with no cards.
- **Bundler imports.** The Worker imports `.json` and `.md` directly (wrangler `[[rules]]` Text rule). `logic.mjs` rewrites those two exact import lines into file reads and writes `worker/src/.under-test.mjs` (git-ignored). If you change those import lines, update the `.replace(...)` calls in `logic.mjs` too.
- **Site config is generated.** `site/config.js` in the repo is a placeholder. The Pages workflow (and `test/run-ui.sh`) overwrite it with `{ apiBase, mvpTools }` from the `WORKER_URL` and `MVP_TOOLS` repo variables.
- **MVP team log.** `worker/src/teamlog.js` is a separate Durable Object (`LogStore`) behind `/log/*`. Every route returns 404 unless the `TEAM_PASSCODE` secret is set. `mvp/` pages are only deployed when `MVP_TOOLS` is exactly `true`.
- **Spend and abuse layers:** origin check (`ALLOWED_ORIGIN`), per-IP rate limit, `DailyCap` Durable Object (`MAX_PER_DAY`), then the Anthropic Console spend limit.

## Rules for this repo

- Nothing about a conversation is stored or logged. Keep `[observability] enabled = false`, keep the page's state in memory only, and don't add logging of user text. The team log must never hold identifying details.
- The only phone numbers the model may write are 999, 111 and 01924 316830 (in `prompt/system.md`). Extra helplines go in `URGENT_CONTACTS` in `site/app.js`, and only once the programme team has checked them from an official source. Never add one from a web search.
- Scheme content comes from `docs/programme/Kirklees HWL Pathways Aug 26 v2.1.docx`. Don't invent or "tidy" scheme names, eligibility or contacts. Flag gaps instead.
- Keep `lastUpdated` honest. The page and `mvp/help.js` both flag entries older than `STALE_DAYS = 135`; if you change the threshold, change it in both.
- Scheme `id`s are what the model returns and what `test/smoke.sh` and `logic.mjs` assert on. Don't rename them casually.
- User-facing text follows the house style: plain, informal, UK spelling. The public mode aims for a reading age of about 11 (`MODE_NOTES` in the Worker).
- `docs/background/` holds the option appraisals and source prompt (.docx/.pptx). They are history, not specs.

## Accessibility and translation scope

- Only the public-facing page (https://healthy-working-life-kirklees.github.io/service-finder/)
  and the results it shows need accessibility features and translation / language options.
- Everything else, including review tools, commenting, admin and internal pages, is English only
  and doesn't need translation or the public accessibility options.

