// "Apply changes now" on the All services page (Admin pages, development team only).
//
// POST /log/apply         starts the Apply team changes workflow on GitHub with auto_merge on: it writes the team's
//                         decisions, edits and new services into data/services/, runs the data check and the Worker
//                         tests, merges the pull request if they pass, and starts both deploys.
// GET  /log/apply/status  how the latest run is going, and the deploys it started.
//
// Both sit behind the team passcode (handleLog checks it before calling these). Off unless the Worker secret
// GH_ACTIONS_TOKEN is set: a fine-grained GitHub token for this repository only, with Actions: read and write and
// nothing else. It can start and read workflow runs; it can't change code or data itself. The repository is the
// GH_REPO variable in wrangler.toml.

const WORKFLOW = 'apply-team-changes.yml';
const DEPLOYS = { site: 'pages.yml', worker: 'worker.yml' };

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
  });
}

export const applyOn = (env) => Boolean(env.GH_ACTIONS_TOKEN && env.GH_REPO);

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.GH_REPO}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GH_ACTIONS_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'hwl-service-finder-worker',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

// The newest run of a workflow (optionally only ones started at or after `since`), in a small, safe shape.
async function latestRun(env, file, since) {
  const res = await gh(env, `/actions/workflows/${file}/runs?branch=main&per_page=5`);
  if (!res.ok) throw Object.assign(new Error('GitHub said ' + res.status), { status: res.status });
  const runs = ((await res.json()).workflow_runs || []).filter((r) => !since || r.created_at >= since);
  const r = runs[0];
  return r ? { status: r.status, conclusion: r.conclusion, url: r.html_url, created: r.created_at, updated: r.updated_at, title: r.display_title } : null;
}

const running = (run) => run && run.status !== 'completed';

// Names go into the run's title on GitHub, so keep them to plain characters.
const safeName = (v) => (typeof v === 'string' ? v.replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40) : '');

export async function handleApply(request, env, path, body, cors) {
  if (!applyOn(env)) return json({ error: 'Applying from this page is not switched on yet. Ask Phil.', off: true }, 404, cors);

  try {
    if (request.method === 'GET' && path === '/log/apply/status') {
      const apply = await latestRun(env, WORKFLOW);
      let site = null;
      let worker = null;
      // The deploys this run started: the first ones created after it began.
      if (apply) [site, worker] = await Promise.all([latestRun(env, DEPLOYS.site, apply.created), latestRun(env, DEPLOYS.worker, apply.created)]);
      return json({ on: true, apply, site, worker }, 200, cors);
    }

    if (request.method === 'POST' && path === '/log/apply') {
      const by = safeName(body.by);
      if (!by) return json({ error: 'Please give your name or initials first.' }, 400, cors);
      const last = await latestRun(env, WORKFLOW);
      if (running(last)) return json({ error: 'Changes are already being applied. Please wait for that to finish.', apply: last }, 409, cors);
      const res = await gh(env, `/actions/workflows/${WORKFLOW}/dispatches`, {
        method: 'POST',
        body: JSON.stringify({ ref: 'main', inputs: { auto_merge: 'true', requested_by: by } }),
      });
      if (res.status !== 204) return json({ error: 'GitHub would not start the update (' + res.status + '). Ask Phil.' }, 502, cors);
      return json({ ok: true, started: new Date().toISOString() }, 202, cors);
    }
  } catch (e) {
    return json({ error: 'Could not reach GitHub just now. Please try again in a minute.' }, 502, cors);
  }
  return json({ error: 'Not found.' }, 404, cors);
}
