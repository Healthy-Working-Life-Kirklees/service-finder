// Morning reminders to the team (run by the cron in wrangler.toml, from index.js "scheduled").
//
// Finds projects and sessions that end, or stop taking referrals, in the next 30 days (site/listing-logic.js), and
// emails the team ONE message listing them. For each service it makes a fresh provider review link (as on the All
// services page) and writes a ready-to-send email for the team to forward to the organisation. Nothing is sent to
// the organisation from here: the team forwards it themselves, which keeps the relationship personal.
//
// Each project or session date is only reminded about once (remembered in the team store, LogStore), so a day the
// email isn't sent is caught up the next morning.
//
// Needs the same email settings as the feedback emails (FEEDBACK_EMAIL binding, FEEDBACK_EMAIL_FROM,
// FEEDBACK_EMAIL_TO), the team store (TEAM_PASSCODE, LOG_STORE) and SITE_URL (the address of the finder, for the
// links). Without any of them, it does nothing. Never throws.

import '../../site/listing-logic.js';

const LINK_DAYS = 60;

function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The message the team forwards to the organisation.
export function draftEmail(s, items, link, longDate) {
  const lines = items.map((x) => `- ${x.project.name}${x.session ? ' (' + (x.session.name || globalThis.LISTING.timeWords(x.session) || 'a session') + ')' : ''}: ${x.kind === 'ends' ? 'due to end on' : 'due to stop taking referrals on'} ${longDate(x.date)}`);
  return [
    'Hello,',
    '',
    `We noticed that ${s.name} has dates coming up on the Healthy Working Life Support Finder:`,
    '',
    ...lines,
    '',
    'Is that still right? If the project has been extended, has new funding, or the referral dates have changed, please update your listing using this link (it works until ' + longDate(link.expires.slice(0, 10)) + '):',
    '',
    link.url,
    '',
    'Please note that projects stop showing in the Support Finder after their end date.',
    '',
    'Are you running anything else that could help people in Kirklees stay in, return to or find work? You can tell us about it using "Suggest a service" on the Support Finder: ' + link.site,
    '',
    'Thank you,',
  ].join('\n');
}

export async function sendReminders(env, services, today) {
  try {
    const L = globalThis.LISTING;
    const to = String(env.FEEDBACK_EMAIL_TO || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10);
    const site = String(env.SITE_URL || '').replace(/\/?$/, '/');
    if (!env.FEEDBACK_EMAIL || !env.FEEDBACK_EMAIL_FROM || !to.length || !env.TEAM_PASSCODE || !env.LOG_STORE || !/^https:\/\//.test(site)) return { sent: false, reason: 'not set up' };

    const stub = env.LOG_STORE.get(env.LOG_STORE.idFromName('team-log'));
    const call = async (path, payload) => (await stub.fetch('https://log' + path, { method: 'POST', body: JSON.stringify(payload || {}) })).json();

    const items = services.filter((s) => s.open === true).flatMap((s) => L.endingSoon(s, today));
    if (!items.length) return { sent: false, reason: 'nothing due' };
    const key = (x) => [x.service.id, x.project.id, x.session ? x.session.id : '', x.kind, x.date].join('|');
    const { unseen } = await call('/remind/check', { keys: items.map(key) });
    const due = items.filter((x) => (unseen || []).includes(key(x)));
    if (!due.length) return { sent: false, reason: 'already reminded' };

    // One link and one draft email per service.
    const { links } = await call('/plinks/list');
    const byService = new Map();
    for (const x of due) {
      if (!byService.has(x.service.id)) byService.set(x.service.id, []);
      byService.get(x.service.id).push(x);
    }
    const parts = [];
    for (const [id, list] of byService) {
      const s = list[0].service;
      const last = (links || []).filter((l) => l.id === id).sort((a, b) => b.created.localeCompare(a.created))[0];
      const contact = last ? last.contact : 'the service contact';
      const expires = new Date(Date.now() + LINK_DAYS * 86400000).toISOString();
      const made = await call('/plinks/create', { token: newToken(), id, contact, by: 'Morning reminder', expires });
      if (made.error) continue;
      const link = { url: site + 'provider-check.html#' + made.link.token, expires, site };
      parts.push(
        `${s.name} (${s.organisation})`,
        ...list.map((x) => `  ${x.project.name}${x.session ? ', ' + (x.session.name || L.timeWords(x.session) || 'a session') : ''}: ${x.kind === 'ends' ? 'ends' : 'stops taking referrals'} ${L.longDate(x.date)} (in ${x.daysLeft} day${x.daysLeft === 1 ? '' : 's'})`),
        `  Review link made for ${contact}, works for ${LINK_DAYS} days.`,
        '',
        '  ----- Email to forward -----',
        ...draftEmail(s, list, link, L.longDate).split('\n').map((l) => '  ' + l),
        '  ----------------------------',
        ''
      );
    }
    if (!parts.length) return { sent: false, reason: 'no links made' };

    const n = byService.size;
    await env.FEEDBACK_EMAIL.send({
      to: to.length === 1 ? to[0] : to,
      from: { email: env.FEEDBACK_EMAIL_FROM, name: 'HWL Support Finder' },
      subject: `[Support Finder] ${n} service${n === 1 ? ' has' : 's have'} projects ending or closing to referrals soon`,
      text: [
        'These projects or sessions end, or stop taking referrals, in the next 30 days. They stop showing in the Support Finder after that date.',
        '',
        'For each one, check with the organisation: forward the email below (adding their email address), or get in touch your own way. The link lets them update their listing; their reply comes back to All services for the team to check.',
        '',
        ...parts,
        'All services in Admin also shows what is ending soon and what has closed.',
        '',
        '— Sent automatically by the HWL Support Finder each morning.',
      ].join('\n'),
    });
    await call('/remind/mark', { keys: due.map(key) });
    return { sent: true, services: n, items: due.length };
  } catch {
    return { sent: false, reason: 'error' };
  }
}
