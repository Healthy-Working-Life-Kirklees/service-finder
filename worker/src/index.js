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

const MODE_NOTES = {
  public:
    'MODE: The person is looking for support for themselves or a family member. Use plain, friendly language (reading age around 11) and explain any jargon. Lead with how they can refer themselves.',
  staff:
    'MODE: The person is a frontline worker or partner helping someone else. Be concise and practical. In "why", flag the key eligibility or exclusion points the referrer should check, and mention the best referral route.',
};

const SERVICES = data.services;
const IDS = SERVICES.map((s) => s.id);
const ID_SET = new Set(IDS);

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

function respondTool() {
  return {
    name: 'respond',
    description: 'Give your reply to the person. Always answer by calling this tool.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Your reply in plain text (no markdown). Short.' },
        recommendations: {
          type: 'array',
          maxItems: 4,
          description: 'Services to show as cards, best fit first. Empty if none fit or you need more information first.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', enum: IDS },
              why: { type: 'string', description: 'One or two plain sentences on why this fits and what to check.' },
            },
            required: ['id', 'why'],
          },
        },
        safety_concern: {
          type: 'boolean',
          description: 'True only if the person describes an emergency, risk to life, suicide, self-harm or risk to others.',
        },
      },
      required: ['message', 'recommendations', 'safety_concern'],
    },
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
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        }
      : { Vary: 'Origin' };

    if (request.method === 'OPTIONS') return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (url.pathname === '/health') return json({ ok: true, aiConfigured: Boolean(env.ANTHROPIC_API_KEY) }, 200, cors);
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

    const payload = {
      model: env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: [
        { type: 'text', text: SYSTEM_PROMPT.trim() },
        {
          type: 'text',
          text: `SERVICE DATA (JSON). Source: ${data.source}.\n${JSON.stringify(SERVICES)}`,
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: MODE_NOTES[mode] },
      ],
      tools: [respondTool()],
      tool_choice: { type: 'tool', name: 'respond' },
      messages,
    };

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
      return json({ error: busy ? 'The AI service is busy. Please try again in a moment.' : 'Something went wrong on our side. Please try again.' }, busy ? 503 : 502, cors);
    }

    const out = await r.json();
    const block = (out.content || []).find((b) => b.type === 'tool_use' && b.name === 'respond');
    if (!block || typeof (block.input && block.input.message) !== 'string') {
      return json({ error: 'Something went wrong on our side. Please try again.' }, 502, cors);
    }

    const input = block.input;
    const seen = new Set();
    const safety = input.safety_concern === true;
    const recommendations = safety
      ? []
      : (Array.isArray(input.recommendations) ? input.recommendations : [])
          .filter((x) => x && ID_SET.has(x.id) && !seen.has(x.id) && seen.add(x.id))
          .slice(0, 4)
          .map((x) => ({ id: x.id, why: String(x.why || '').slice(0, 600) }));

    return json({ message: input.message.slice(0, 3000), recommendations, safety_concern: safety }, 200, cors);
  },
};
