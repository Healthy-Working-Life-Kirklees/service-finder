# Kirklees Healthy Working Life Service Finder (prototype)

A proof of concept: a chat page that matches people to Healthy Working Life schemes in Kirklees.

**It is a prototype. The scheme details come from a draft pathways document and may be out of date.**

## How it fits together

    browser  ->  GitHub Pages (site/)  ->  Cloudflare Worker (worker/)  ->  Claude API
                 static page + data         holds the API key, no storage

- `site/` is the page. GitHub Pages serves it. It is public.
- `data/services.json` is the scheme data (17 schemes). It is copied into the site on deploy and bundled into the Worker.
- `prompt/system.md` is the instructions Claude follows. Bundled into the Worker.
- `worker/` is a small Cloudflare Worker. It holds the Anthropic API key, sends the scheme data and the conversation to Claude, and returns a short message plus a list of scheme ids. The page draws the cards from `services.json`, so contact details are never written by the AI, and unknown ids are dropped.
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

Edit `data/services.json` or `prompt/system.md` and push to `main`. Both workflows redeploy. Keep `lastUpdated` honest: the page flags entries older than about 4.5 months. Entries with `"open": false` are never recommended.

## Local test of the Worker

    cd worker && npm install
    node test/mock-anthropic.mjs &
    npx wrangler dev --port 8787 --var ANTHROPIC_API_KEY:test-key --var ANTHROPIC_API_URL:http://127.0.0.1:9999
    # in another terminal
    bash test/smoke.sh

The mock stands in for the Anthropic API, so no real key or spend is involved.
