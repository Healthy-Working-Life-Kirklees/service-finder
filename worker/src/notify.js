// Emails the team inbox when feedback arrives, so nobody has to keep checking the review page.
//
// Sent through a Cloudflare send_email binding called FEEDBACK_EMAIL, to FEEDBACK_EMAIL_TO, from
// FEEDBACK_EMAIL_FROM (an address on a domain set up for Cloudflare Email Sending). If any of the three is
// missing, nothing is sent and feedback is still stored as normal. See "Feedback emails" in README.md.
//
// The email holds only what was stored for the entry (already checked and with personal details removed),
// plus scheme names. Nothing from the conversation. A plain "Yes, it was helpful" is not emailed, as it would
// only be noise; it still shows in the totals on the review page.
//
// Errors are swallowed on purpose: a failed email must never stop feedback being saved, and nothing about the
// entry is logged.

const KIND_LABELS = {
  pilot: 'Pilot feedback',
  card: 'Problem with a listing',
  reply: 'Results not helpful',
  gap: "Something's missing",
};

// Plain-English labels, matching the wording people saw on the page.
export const LABELS = {
  // pilot
  'found-useful': 'Found something useful',
  'missed-service': 'Missed a service',
  unsuitable: 'Suggested something unsuitable',
  'hard-to-use': 'Hard to use',
  broken: "Something's broken or wrong",
  idea: 'Idea or suggestion',
  // reply "No"
  'none-fit': 'None of these fit',
  'info-wrong': 'The information looked wrong',
  'hard-to-understand': 'It was hard to understand',
  // card
  closed: "It has closed or isn't running",
  'contact-wrong': 'Phone, email or website is wrong',
  'eligibility-wrong': "Who it's for or eligibility is wrong",
  'no-reply': "Couldn't get through or got no reply",
  'not-in-area': "It isn't available in my area",
  'missing-details': 'Something useful is missing from the listing',
  other: 'Something else',
  // gap
  'missing-service': "A service that isn't listed",
  'missing-support': "A kind of support they couldn't find",
  'missing-other': 'Something else missing',
};
const ROLE_LABELS = { provider: 'Someone from the service', suggester: 'Someone who knows the service' };
const SERVICE_LABELS = {
  organisation: 'Organisation', description: 'Description', activities: 'What happens', running: 'Running', dates: 'Dates',
  age: 'Age range', eligibility: 'Who can join', exclusions: "Who it can't help", healthNeed: 'Health need', conditions: 'Conditions',
  audience: 'Who it is for', categories: 'Kinds of support', addresses: 'Addresses', noMap: 'No map', level: 'Level', phone: 'Phone',
  email: 'Email', social: 'Social media', referral: 'How people get referred', selfReferral: 'Self-referral', cost: 'Cost',
  languages: 'Languages', workExperience: 'Work experience', logoOk: 'OK to use their logo', contactName: 'Contact name',
};
const CONTACTED_LABELS = { yes: 'Yes', no: 'No', 'not-yet': 'Not yet', 'not-applicable': 'Not applicable' };
const LANG_LABELS = { en: 'English', pl: 'Polish', ur: 'Urdu' };
const MODE_LABELS = { public: 'For themselves', staff: 'Helping someone else' };

// Whether an entry is worth an email.
export const shouldEmail = (entry) => !(entry.kind === 'reply' && entry.helpful === true);

// Builds { subject, text } for an entry. names: Map of scheme id -> name.
export function buildEmail(entry, names = new Map(), reviewUrl = '') {
  const label = (r) => LABELS[r] || r;
  const scheme = (id) => (names.get(id) ? `${names.get(id)} (${id})` : id);
  const lines = [];
  const add = (k, v) => {
    if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) lines.push(`${k}: ${v}`);
  };

  const kind = KIND_LABELS[entry.kind] || entry.kind;
  const about = entry.kind === 'pilot' || entry.kind === 'gap' ? entry.reasons.map(label).join(', ') : entry.schemeIds.map((id) => names.get(id) || id).join(', ');
  const site = entry.site === 'preview' ? ' [preview]' : '';
  const subject = `Support Finder feedback #${entry.id}${site}: ${kind}${about ? ' – ' + about : ''}`.slice(0, 200);

  add('Type', kind);
  add('Date', entry.date);
  add('Site', entry.site === 'preview' ? 'Preview (experimental)' : 'Live');
  if (entry.kind !== 'pilot' && entry.kind !== 'gap') add('Scheme(s)', entry.schemeIds.map(scheme).join('; '));
  if (entry.kind === 'card') add('Listing last checked', entry.recordLastUpdated);
  if (entry.kind === 'pilot' || entry.kind === 'card' || entry.kind === 'gap' || entry.kind === 'reply') add(entry.kind === 'pilot' ? 'Best describes it' : 'Reasons', entry.reasons.map(label).join('; '));
  if (entry.kind === 'pilot') {
    add('Results shown at the time', entry.schemeIds.map(scheme).join('; '));
    add('Went on to contact a suggested service', CONTACTED_LABELS[entry.contacted]);
    add('Ease of use this time (1–5)', entry.ease);
  }
  if (entry.missedService) {
    const ms = entry.missedService;
    add('Missed service', [ms.name, ms.website, ms.area].filter(Boolean).join(', '));
    add('Sent in by', ROLE_LABELS[ms.role]);
    // The fuller details from "Suggest a service", in the order the form asks for them.
    for (const [k, v] of Object.entries(ms)) {
      if (['name', 'website', 'area', 'role'].includes(k)) continue;
      add(SERVICE_LABELS[k] || k, v === true ? 'Yes' : Array.isArray(v) ? v.join(', ') : v);
    }
  }
  add('Kinds of support looked for', entry.gapCategories);
  add('Area', entry.gapArea);
  add('Mode', MODE_LABELS[entry.mode]);
  add('Language', LANG_LABELS[entry.lang]);
  if (entry.redacted) lines.push('Note: some personal details were removed from the comment before it was saved.');

  const body = [
    ...lines,
    '',
    entry.text ? 'Comment:\n' + entry.text : 'No comment was added.',
    '',
    entry.contact ? `Happy to be contacted: ${[entry.contact.name, entry.contact.email].filter(Boolean).join(', ')}` : 'Not asked to be contacted.',
    '',
    reviewUrl ? `Review, set a status or add a note: ${reviewUrl}` : 'Review it on the Feedback and usage page.',
    '',
    '— Sent automatically by the HWL Support Finder.',
  ].join('\n');

  return { subject, text: body };
}

// Sends the email. Never throws.
export async function notifyFeedback(env, entry, names, reviewUrl) {
  try {
    if (!env.FEEDBACK_EMAIL || !env.FEEDBACK_EMAIL_TO || !env.FEEDBACK_EMAIL_FROM || !shouldEmail(entry)) return false;
    const { subject, text } = buildEmail(entry, names, reviewUrl);
    const msg = {
      to: env.FEEDBACK_EMAIL_TO,
      from: { email: env.FEEDBACK_EMAIL_FROM, name: 'HWL Support Finder' },
      subject,
      text,
    };
    // Replying goes straight to a pilot tester who asked to be contacted.
    if (entry.contact && entry.contact.email) msg.replyTo = entry.contact.name ? { email: entry.contact.email, name: entry.contact.name } : entry.contact.email;
    await env.FEEDBACK_EMAIL.send(msg);
    return true;
  } catch {
    return false;
  }
}
