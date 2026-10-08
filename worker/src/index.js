// Kirklees HWL Service Finder - Cloudflare Worker proxy.
//
// The static page (GitHub Pages) calls this Worker. The Worker holds the Anthropic
// API key, sends the scheme data plus the conversation to Claude, and returns a
// short message and a list of scheme ids. It stores nothing about the conversation
// and logs nothing (observability is switched off in wrangler.toml).
//
// Abuse / spend protection, in layers:
//   1. Origin must match ALLOWED_ORIGIN (stops casual use from other sites).
//   2. Per-IP burst limit (Rate Limiting binding).
//   3. A hard global daily cap (one Durable Object holding a date and a number).
//   4. Set a monthly spend limit in the Anthropic Console as the real backstop.

import data from '../../data/services.json';
import SYSTEM_PROMPT from '../../prompt/system.md';
import { handleLog } from './teamlog.js';

// The team issues log lives in its own Durable Object class (see teamlog.js).
export { LogStore } from './teamlog.js';

const MODE_NOTES = {
  public:
    'MODE: The person is looking for support for themselves or a family member. Use plain, friendly language (reading age around 11) and explain any jargon. Lead with how they can refer themselves.',
  staff:
    'MODE: The person is a frontline worker or partner helping someone else. Be concise and practical. In "reason" and "check_first", flag the key eligibility or exclusion points the referrer should check, and mention the best referral route.',
};

// Backstop for the most obvious crisis wording, so the crisis panel never depends on the model alone.
const CRISIS_RE = /suicid|kill myself|killing myself|end my life|take my own life|want to die|wanna die|self[- ]harm|hurt myself|harm myself|better off dead|better off without me|can't see the point|cant see the point|don't want to be here|dont want to be here|no point (in )?(going on|living|anymore|any more)/i;

const SERVICES = data.services;
const IDS = SERVICES.map((s) => s.id);
const ID_SET = new Set(IDS);
// Only schemes that are open to referrals can ever be shown as cards.
const OPEN_SET = new Set(SERVICES.filter((s) => s.open === true).map((s) => s.id));
// Schemes built for a specific circumstance are only shown if the person's own words mention it.
const MENTION = new Map(
  SERVICES.filter((s) => Array.isArray(s.requiresMention) && s.requiresMention.length).map((s) => [s.id, new RegExp(s.requiresMention.join('|'), 'i')])
);

// The model may ask at most this many follow-up questions across a whole conversation. The page writes
// "(Follow-up questions asked: N)" into the history after a reply that asked questions, and the Worker
// counts those, so the limit does not depend on the model keeping count.
const MAX_QUESTIONS = 2;
const ASKED_RE = /\(Follow-up questions asked: (\d+)\)/g;
const URGENT_TYPES = ['medical', 'mental_health_crisis', 'domestic_abuse', 'child_safeguarding', 'adult_safeguarding'];

function questionsAsked(messages) {
  let n = 0;
  for (const m of messages) if (m.role === 'assistant') for (const x of m.content.matchAll(ASKED_RE)) n += Number(x[1]) || 0;
  return Math.min(n, MAX_QUESTIONS);
}

// ---------- global daily counter (holds a date and a number, nothing else) ----------
export class DailyCap {
  constructor(ctx) {
    this.ctx = ctx;
  }
  async fetch(request) {
    const { max } = await request.json();
    const today = new Date().toISOString().slice(0, 10);
    let day = await this.ctx.storage.get('day');
    let n = (await this.ctx.storage.get('n')) || 0;
    if (day !== today) {
      day = today;
      n = 0;
    }
    n += 1;
    await this.ctx.storage.put({ day, n });
    return Response.json({ allowed: n <= max, n });
  }
}

// ---------- helpers ----------
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 24) return null;
  const out = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
    const max = m.role === 'user' ? 1500 : 4000;
    const content = m.content.trim();
    if (!content || content.length > max) return null;
    out.push({ role: m.role, content });
  }
  if (out[0].role !== 'user' || out[out.length - 1].role !== 'user') return null;
  for (let i = 1; i < out.length; i++) if (out[i].role === out[i - 1].role) return null;
  return out;
}

function respondTool(questionsLeft) {
  const properties = {
    status: {
      type: 'string',
      enum: questionsLeft > 0 ? ['results', 'needs_more_info'] : ['results'],
      description: 'results = you are giving your answer (matches may be empty). needs_more_info = you are asking a follow-up question and returning no matches.',
    },
    message: { type: 'string', description: 'Your reply to the person in plain text (no markdown). Short. If you are asking a question, it goes here too.' },
    urgent_support: { type: 'boolean', description: 'True only if the text suggests a medical emergency, suicidal thoughts, self-harm, abuse, domestic violence, or anyone at risk of serious harm.' },
    urgent_types: { type: 'array', items: { type: 'string', enum: URGENT_TYPES }, description: 'The kinds of urgent support. Empty unless urgent_support is true.' },
    pii_detected: { type: 'boolean', description: 'True if the text contains a name, address, phone number, date of birth or NHS number.' },
    understood_needs: { type: 'array', maxItems: 5, items: { type: 'string' }, description: 'Two to five short phrases on what you took from the conversation. No identifying details.' },
    matches: {
      type: 'array',
      maxItems: 5,
      description: 'Services to show as cards, best fit first (specialist before general). Empty if none fit, if you are asking a question, or if urgent_support is true.',
      items: {
        type: 'object',
        properties: {
          service_id: { type: 'string', enum: IDS },
          fit: { type: 'string', enum: ['strong', 'possible'] },
          reason: { type: 'string', description: 'Plain English, under 30 words, neutral wording.' },
          check_first: { type: 'string', description: 'What to check before relying on this match. Empty for a strong match with nothing to check.' },
        },
        required: ['service_id', 'fit', 'reason', 'check_first'],
      },
    },
  };
  const required = ['status', 'message', 'urgent_support', 'urgent_types', 'pii_detected', 'understood_needs', 'matches'];
  if (questionsLeft > 0) {
    properties.follow_up_questions = { type: 'array', maxItems: questionsLeft, items: { type: 'string' }, description: 'The question or questions you are asking. Empty when you are giving results.' };
    required.push('follow_up_questions');
  }
  return {
    name: 'respond',
    description: 'Give your reply to the person. Always answer by calling this tool.',
    input_schema: { type: 'object', properties, required },
  };
}

// ---------- worker ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowed = env.ALLOWED_ORIGIN || '';
    const origin = request.headers.get('Origin') || '';
    const originOk = Boolean(allowed) && origin === allowed;
    const cors = originOk
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type, x-team-passcode',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        }
      : { Vary: 'Origin' };

    if (request.method === 'OPTIONS') return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (url.pathname === '/health') return json({ ok: true, aiConfigured: Boolean(env.ANTHROPIC_API_KEY), teamLog: Boolean(env.TEAM_PASSCODE) }, 200, cors);
    // MVP-team issues log: off unless the TEAM_PASSCODE secret is set.
    if (url.pathname.startsWith('/log/')) return originOk ? handleLog(request, env, url, cors) : json({ error: 'Not allowed.' }, 403, cors);
    if (url.pathname !== '/chat' || request.method !== 'POST') return json({ error: 'Not found.' }, 404, cors);
    if (!originOk) return json({ error: 'Not allowed.' }, 403, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'The AI service is not configured yet.' }, 503, cors);

    // Size limit before parsing.
    const text = await request.text();
    if (text.length > 65536) return json({ error: 'That request was too large.' }, 413, cors);

    // Per-IP burst limit.
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (env.IP_LIMITER) {
      const { success } = await env.IP_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'You are sending messages quite quickly. Please wait a minute and try again.' }, 429, cors);
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'That request could not be read.' }, 400, cors);
    }
    const mode = body.mode === 'staff' ? 'staff' : 'public';
    const messages = validateMessages(body.messages);
    if (!messages) return json({ error: 'That message was empty, too long, or in the wrong order.' }, 400, cors);

    // Global daily cap.
    const max = Number(env.MAX_PER_DAY || 100);
    const stub = env.CAP_COUNTER.get(env.CAP_COUNTER.idFromName('global'));
    const cap = await (await stub.fetch('https://cap/hit', { method: 'POST', body: JSON.stringify({ max }) })).json();
    if (!cap.allowed) return json({ error: 'The prototype has reached its daily limit. Please try again tomorrow.' }, 503, cors);

    const questionsLeft = MAX_QUESTIONS - questionsAsked(messages);
    const payload = {
      model: env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: [
        { type: 'text', text: SYSTEM_PROMPT.trim() },
        {
          type: 'text',
          text: `SERVICE DATA (JSON). Source: ${data.source}.\n${JSON.stringify(SERVICES)}`,
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: `${MODE_NOTES[mode]}
Today's date: ${new Date().toISOString().slice(0, 10)}.
FOLLOW-UP QUESTIONS LEFT: ${questionsLeft} (of ${MAX_QUESTIONS} across the whole conversation).` },
      ],
      tools: [respondTool(questionsLeft)],
      messages,
    };
    // Sonnet/Opus 5.x reject a forced tool call and think up front by default. For those, let the model
    // choose (the prompt tells it to always call `respond`) and turn up-front thinking off. Other models
    // (e.g. Haiku) keep the forced tool call.
    if (/^claude-(sonnet|opus)-5/.test(payload.model)) payload.thinking = { type: 'between_tools' };
    else payload.tool_choice = { type: 'tool', name: 'respond' };

    let r;
    try {
      r = await fetch(`${env.ANTHROPIC_API_URL || 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(40_000),
      });
    } catch {
      return json({ error: 'Could not reach the AI service. Please try again.' }, 502, cors);
    }

    if (!r.ok) {
      const busy = r.status === 429 || r.status === 529 || r.status === 503;
      // Upstream error message (Anthropic's own wording, never the user's text) to help diagnose problems.
      let detail = '';
      try {
        const e = await r.json();
        detail = String((e.error && e.error.message) || '').slice(0, 300);
      } catch {}
      return json({ error: busy ? 'The AI service is busy. Please try again in a moment.' : 'Something went wrong on our side. Please try again.', upstream: r.status, detail }, busy ? 503 : 502, cors);
    }

    const out = await r.json();
    const block = (out.content || []).find((b) => b.type === 'tool_use' && b.name === 'respond');
    let input = block && block.input && typeof block.input.message === 'string' ? block.input : null;
    if (!input) {
      // The model answered in plain text instead of calling the tool: show it as the message, with no cards.
      const text = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      if (!text) return json({ error: 'Something went wrong on our side. Please try again.' }, 502, cors);
      input = { status: 'results', message: text, urgent_support: false, matches: [] };
    }
    const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
    const list = (v) => (Array.isArray(v) ? v : []);
    const userText = messages.filter((m) => m.role === 'user').map((m) => m.content).join(' ');
    const lastUser = String(messages[messages.length - 1].content).split(String.fromCharCode(8217)).join("'");

    // Urgent support: the model's flag, or the crisis wording backstop. Either way no cards and no questions.
    const crisisWords = CRISIS_RE.test(lastUser);
    const urgent = input.urgent_support === true || crisisWords;
    const urgentTypes = list(input.urgent_types).filter((t, i, a) => URGENT_TYPES.includes(t) && a.indexOf(t) === i);
    if (crisisWords && !urgentTypes.includes('mental_health_crisis')) urgentTypes.push('mental_health_crisis');

    // Follow-up questions: at most the number left, and only when the model is really asking.
    let questions = list(input.follow_up_questions).map((q) => clean(q, 300)).filter(Boolean).slice(0, Math.max(questionsLeft, 0));
    let status = input.status === 'needs_more_info' && questions.length && !urgent ? 'needs_more_info' : 'results';
    if (status === 'results') questions = [];

    // Cards: only real, open schemes; condition-specific schemes only if the person mentioned the circumstance.
    const seen = new Set();
    const recommendations =
      urgent || status === 'needs_more_info'
        ? []
        : list(input.matches)
            .filter((x) => x && ID_SET.has(x.service_id) && OPEN_SET.has(x.service_id) && (!MENTION.has(x.service_id) || MENTION.get(x.service_id).test(userText)) && !seen.has(x.service_id) && seen.add(x.service_id))
            .slice(0, 5)
            .map((x) => ({ id: x.service_id, why: clean(x.reason, 600), fit: x.fit === 'strong' ? 'strong' : 'possible', check_first: clean(x.check_first, 400) }));

    return json(
      {
        status,
        message: input.message.slice(0, 3000),
        recommendations,
        safety_concern: urgent,
        urgent_types: urgent ? urgentTypes : [],
        pii_detected: input.pii_detected === true,
        understood_needs: urgent ? [] : list(input.understood_needs).map((x) => clean(x, 100)).filter(Boolean).slice(0, 5),
        follow_up_questions: questions,
      },
      200,
      cors
    );
  },
};
