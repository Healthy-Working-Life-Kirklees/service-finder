// Checks a change to a service's details before it is stored: from the All services page (Admin, development team)
// and from a provider's review link (providerlink.js, which also blocks the team-only fields).
//
// Only the fields below can be edited this way. The allowed values (areas, categories and so on) come from
// data/schema.json, so they stay in step with the data. The full check against the schema runs again when the
// change is written into the data (scripts/apply-decisions.mjs) and in the pull request's checks.
//
// It also checks a whole new service added there (checkNew).
//
// A change is a set of fields with their new values. null means "remove this optional detail" (for example no
// phone number any more). Fields not in the change are left as they are.
//
// "organisation" is the organisation's name. A name that isn't an organisation yet becomes a new one when the
// change is applied. "organisationOverview" is the organisation's own overview: it is stored once, on the
// organisation, so changing it from one service changes it for all of that organisation's services.
//
// Character limits (LIMITS in site/listing-logic.js) apply to text that has been changed. Text already in the
// data that is over a limit is kept as it is, and can be sent back unchanged.
//
// A venue (on a session, or in "venues", the places used by every project) is either the id of a venue already in
// data/venues.json, or a new one written out as { name, address, postcode }. A new venue becomes a venue record when
// the change is applied (or is matched to one already there with the same address).

import '../../site/listing-logic.js';

const { LIMITS, checkParts, DATE_KEYS, DAYS, FREQUENCY, RUNS } = globalThis.LISTING;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i;

// The Worker passes data/schema.json in (see index.js), so this file has no bundler-only imports.
export function makeChecker(schema) {
  const P = schema.properties;
  const enumOf = (prop) => (prop.items ? prop.items.enum : prop.enum);

  // field -> how to check it
  const TEXT = { name: 150, organisation: 150, whoFor: 600, workExperience: 300 };
  const NULLABLE_TEXT = { age: 60, phone: 200 };
  const OPTIONAL_TEXT = { cost: 200, languages: 300, coachNotes: 1000, notes: 3000, organisationOverview: 600 };
  // Stricter limits for text that has changed (the forms show these as people type).
  const HWL_RE = /healthy\s+working\s+life|\bhwl\b/i;
  const STRICT = { whoFor: LIMITS.whoFor, coachNotes: LIMITS.coachNotes, organisationOverview: LIMITS.orgOverview };
  const ENUM = { level: enumOf(P.level), reviewCycle: enumOf(P.reviewCycle) };
  const AUDIENCE = enumOf(P.audience);
  const ENUM_LIST = { audience: [AUDIENCE, 1], categories: [enumOf(P.categories), 1], areas: [enumOf(P.areas), 1], healthFocus: [enumOf(P.healthFocus), 0], groups: [enumOf(P.groups), 0] };
  const TEXT_LIST = { social: 0, locations: 0, eligibility: 0, exclusions: 0, gate: 0, referralRoutes: 1 };
  const BOOL = ['open', 'hwlFunded', 'mapLinks'];
  const SELF = enumOf(P.selfReferral.properties.allowed);

  const EDITABLE = [
    ...Object.keys(TEXT), ...Object.keys(NULLABLE_TEXT), ...Object.keys(OPTIONAL_TEXT), ...Object.keys(ENUM), ...Object.keys(ENUM_LIST),
    ...Object.keys(TEXT_LIST), ...BOOL, 'webpage', 'email', 'selfReferral', 'projects', 'venues', 'logo', 'requiresMention',
  ];
  // Fields a provider can't change: how the team sorts, reviews and maintains the data.
  const TEAM_ONLY = ['level', 'reviewCycle', 'areas', 'categories', 'notes', 'hwlFunded', 'mapLinks', 'logo', 'requiresMention'];

  const URL_RE = /^https?:\/\/\S+$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const DATE_RE = /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  const LABEL = {
    name: 'Name of the service', organisation: 'Organisation', organisationOverview: 'Organisation overview', whoFor: "Who your service is for", workExperience: 'Volunteering or work experience', age: 'Age',
    phone: 'Phone', cost: 'Cost', languages: 'Languages and formats', coachNotes: 'Anything coaches should know', notes: 'Team notes', level: 'Level', reviewCycle: 'Review cycle', audience: 'Who you work with',
    categories: 'Categories', areas: 'Where it runs', healthFocus: 'Health needs', social: 'Social media', locations: 'Places used by every project', eligibility: 'Who your service is for (one per line)',
    exclusions: 'Anyone you can\'t support', gate: 'Anything you\'d turn someone away for not having', referralRoutes: 'How people are referred or apply', open: 'Taking referrals', webpage: 'Website', email: 'Email',
    selfReferral: 'Self-referral', projects: 'Projects', hwlFunded: 'Healthy Working Life funded', mapLinks: 'Map buttons', logo: 'Logo', requiresMention: 'Only shown when mentioned',
    groups: "Who it's for (groups)", venues: 'Venues used by every project',
  };

  const str = (v) => (typeof v === 'string' ? v.trim() : null);
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

  function lines(v, label, max = 30) {
    if (!Array.isArray(v) || v.length > max) return { error: `${label} must be a list of up to ${max} lines.` };
    const list = v.map(str);
    if (list.some((x) => !x)) return { error: `${label} has an empty line.` };
    if (list.some((x) => x.length > 500)) return { error: `A line in ${label} is too long (at most 500 characters).` };
    return { value: list };
  }

  // A venue: an id already in the data, or a new one { name, address, postcode }.
  function venue(v, where) {
    if (typeof v === 'string') {
      if (!ID_RE.test(v) || v.length > 50) return { error: `The venue for ${where} isn't one we know.` };
      return { value: v };
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: `The venue for ${where} is missing.` };
    const bad = Object.keys(v).find((k) => !['name', 'address', 'postcode'].includes(k));
    if (bad) return { error: `The venue for ${where} has a detail that can't be set ("${bad}").` };
    const name = str(v.name);
    const address = str(v.address);
    const postcode = str(v.postcode);
    if (!name || name.length > 150) return { error: `Please give the venue for ${where} a name (up to 150 characters).` };
    if (!address || address.length > 300) return { error: `Please give the address of ${name} (up to 300 characters).` };
    if (!postcode || !POSTCODE_RE.test(postcode)) return { error: `Please give the full postcode of ${name}, such as WF17 5DR.` };
    const pc = postcode.toUpperCase().replace(/\s+/g, '').replace(/^(.+)(\d[A-Z]{2})$/, '$1 $2');
    return { value: { name, address, postcode: pc } };
  }

  // A project or session. "was" is the same project as it is in the data now (by id), if there is one, so text
  // already over a limit can be kept.
  const PROJECT_KEYS = ['id', 'name', 'overview', 'runs', 'area', 'where', 'when', 'duration', 'places', 'age', 'audience', 'eligibility', 'gate', ...DATE_KEYS, 'sessions'];
  const SESSION_KEYS = ['id', 'name', 'venue', 'where', 'days', 'start', 'end', 'frequency', 'note', 'when', 'places', 'age', 'eligibility', 'gate', ...DATE_KEYS];
  function part(x, keys, what, was) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { error: `A ${what} is missing.` };
    const bad = Object.keys(x).find((k) => !keys.includes(k));
    if (bad) return { error: `A ${what} has a detail that can't be set ("${bad}").` };
    const isProject = keys.includes('overview');
    const out = {};
    const id = str(x.id);
    if (!id || !ID_RE.test(id) || id.length > 50) return { error: `Each ${what} needs an id of lower-case letters, numbers and hyphens.` };
    out.id = id;
    const name = str(x.name || '');
    if (!name && isProject) return { error: `Each ${what} needs a name.` };
    if (name.length > 150) return { error: `A ${what} name is too long (at most 150 characters).` };
    if (name) out.name = name;
    const label = name || 'a session';
    if (isProject) {
      const ov = str(x.overview);
      if (!ov) return { error: `Each project needs an overview ("${name}").` };
      const limit = was && was.overview === ov ? 800 : LIMITS.projectOverview;
      if (ov.length > limit) return { error: `The overview for "${name}" is too long (at most ${LIMITS.projectOverview} characters).` };
      out.overview = ov;
      if ('runs' in x && x.runs != null) {
        if (!Array.isArray(x.runs) || x.runs.some((r) => !(r in RUNS))) return { error: `How "${name}" runs has a value that isn't allowed.` };
        if (x.runs.length) out.runs = [...new Set(x.runs)];
      }
    }
    for (const [k, max] of [['area', 300], ['when', 300], ['duration', 300], ['places', 200], ['age', 60], ['note', 300]]) {
      if (!keys.includes(k) || !(k in x) || x[k] == null || x[k] === '') continue;
      const t = str(x[k]);
      if (t === null) return { error: `"${k}" for "${label}" must be text.` };
      if (t.length > max) return { error: `"${k}" for "${label}" is too long (at most ${max} characters).` };
      if (t) out[k] = t;
    }
    if (keys.includes('venue') && x.venue != null && x.venue !== '') {
      const r = venue(x.venue, `"${label}"`);
      if (r.error) return r;
      out.venue = r.value;
    }
    if (keys.includes('days') && x.days != null) {
      if (!Array.isArray(x.days) || x.days.some((d) => !DAYS.includes(d))) return { error: `The days for "${label}" aren't right.` };
      if (x.days.length) out.days = DAYS.filter((d) => x.days.includes(d));
    }
    for (const k of ['start', 'end']) {
      if (!keys.includes(k) || x[k] == null || x[k] === '') continue;
      if (typeof x[k] !== 'string' || !TIME_RE.test(x[k])) return { error: `The ${k === 'start' ? 'start' : 'finish'} time for "${label}" needs to be like 13:30.` };
      out[k] = x[k];
    }
    if (keys.includes('frequency') && x.frequency != null && x.frequency !== '') {
      if (!(x.frequency in FREQUENCY)) return { error: `How often "${label}" runs isn't one of the choices.` };
      out.frequency = x.frequency;
    }
    for (const k of ['where', 'eligibility', 'gate']) {
      if (!(k in x) || x[k] == null) continue;
      const r = lines(x[k], `"${k}" for "${label}"`);
      if (r.error) return r;
      if (r.value.length) out[k] = r.value;
    }
    if ('audience' in x && x.audience != null) {
      if (!Array.isArray(x.audience) || x.audience.some((a) => !AUDIENCE.includes(a))) return { error: `Who "${label}" works with has a value that isn't allowed.` };
      if (x.audience.length) out.audience = [...new Set(x.audience)];
    }
    for (const k of DATE_KEYS) {
      if (!(k in x) || x[k] == null || x[k] === '') continue;
      if (typeof x[k] !== 'string' || !DATE_RE.test(x[k]) || Number.isNaN(Date.parse(x[k]))) return { error: `A date for "${label}" isn't a real date.` };
      out[k] = x[k];
    }
    if (keys.includes('sessions') && 'sessions' in x && x.sessions != null) {
      if (!Array.isArray(x.sessions) || x.sessions.length > 40) return { error: `"${name}" can have up to 40 sessions.` };
      const cs = [];
      for (const c of x.sessions) {
        const r = part(c, SESSION_KEYS, 'session', null);
        if (r.error) return r;
        cs.push(r.value);
      }
      if (cs.length) out.sessions = cs;
    }
    return { value: out };
  }

  // Returns { changes } with every value cleaned, or { error } saying what's wrong in plain words.
  // current: the service as it is in the data now, if it is there (for the character limits).
  function checkChanges(input, current) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Nothing to change.' };
    const cur = current || {};
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      const label = LABEL[k] || k;
      if (!EDITABLE.includes(k)) return { error: `"${k}" can't be changed here.` };
      if (k in TEXT) {
        const t = str(v);
        if (!t) return { error: `${label} can't be empty.` };
        const max = k in STRICT && t !== cur[k] ? STRICT[k] : TEXT[k];
        if (t.length > max) return { error: `${label} is too long (at most ${max} characters).` };
        out[k] = t;
      } else if (k in NULLABLE_TEXT || k in OPTIONAL_TEXT) {
        const t = v === null ? '' : str(v);
        if (t === null) return { error: `${label} must be text.` };
        const max = k in STRICT && t !== cur[k] ? STRICT[k] : NULLABLE_TEXT[k] || OPTIONAL_TEXT[k];
        if (t.length > max) return { error: `${label} is too long (at most ${max} characters).` };
        // The organisation overview is about the organisation as a whole, shown with all its services. Whether a
        // service is a Healthy Working Life scheme is marked on that service only (hwlFunded), never here.
        if (k === 'organisationOverview' && t !== cur[k] && HWL_RE.test(t)) return { error: "The organisation overview describes the whole organisation, so please don't mention Healthy Working Life there. It is shown on each service that is part of it." };
        out[k] = t || null;
      } else if (k === 'webpage' || k === 'email') {
        const t = v === null ? '' : str(v);
        if (t === null) return { error: `${label} must be text.` };
        if (t && k === 'webpage' && (!URL_RE.test(t) || t.length > 500)) return { error: 'The website must start with http:// or https:// and have no spaces.' };
        if (t && k === 'email' && (!EMAIL_RE.test(t) || t.length > 200)) return { error: "The email address doesn't look right." };
        out[k] = t || null;
      } else if (BOOL.includes(k)) {
        if (typeof v !== 'boolean') return { error: `${label} must be yes or no.` };
        out[k] = v;
      } else if (k in ENUM) {
        if (!ENUM[k].includes(v)) return { error: `${label} must be one of: ${ENUM[k].join(', ')}.` };
        out[k] = v;
      } else if (k in ENUM_LIST) {
        const [allowed, min] = ENUM_LIST[k];
        if (!Array.isArray(v) || v.some((x) => !allowed.includes(x))) return { error: `${label} has a value that isn't allowed.` };
        const list = [...new Set(v)];
        if (list.length < min) return { error: `Choose at least one for ${label}.` };
        out[k] = list;
      } else if (k in TEXT_LIST) {
        const r = lines(v, label);
        if (r.error) return r;
        if (r.value.length < TEXT_LIST[k]) return { error: `${label} needs at least one line.` };
        out[k] = r.value;
      } else if (k === 'requiresMention') {
        if (v === null || (Array.isArray(v) && !v.length)) { out[k] = null; continue; }
        const r = lines(v, label, 200);
        if (r.error) return r;
        try { new RegExp(r.value.join('|'), 'iu'); } catch { return { error: `${label} isn't a valid list of words.` }; }
        out[k] = r.value;
      } else if (k === 'logo') {
        const t = v === null ? '' : str(v);
        if (t && !/^[\w.-]+\.(png|jpe?g|webp|svg)$/.test(t)) return { error: 'The logo must be a file name in site/img/logos/, such as example.webp.' };
        out[k] = t || null;
      } else if (k === 'selfReferral') {
        if (!v || typeof v !== 'object') return { error: 'Self-referral is missing.' };
        if (!SELF.includes(v.allowed)) return { error: `Self-referral must be one of: ${SELF.join(', ')}.` };
        const note = str(v.note);
        if (!note || note.length > 300) return { error: 'Say a little about self-referral (up to 300 characters).' };
        const url = str(v.url || '') || '';
        if (url && (!URL_RE.test(url) || url.length > 500)) return { error: 'The self-referral link must start with http:// or https://.' };
        out[k] = url ? { allowed: v.allowed, note, url } : { allowed: v.allowed, note };
      } else if (k === 'projects') {
        if (!Array.isArray(v) || v.length < 1 || v.length > 20) return { error: 'Give between 1 and 20 projects.' };
        const was = new Map((cur.projects || []).map((p) => [p.id, p]));
        const list = [];
        for (const p of v) {
          const r = part(p, PROJECT_KEYS, 'project', p && was.get(p.id));
          if (r.error) return r;
          list.push(r.value);
        }
        const problems = checkParts(list);
        if (problems.length) return { error: problems[0] + '.' };
        out[k] = list;
      } else if (k === 'venues') {
        if (v === null) { out[k] = null; continue; }
        if (!Array.isArray(v) || v.length > 30) return { error: `${label} must be a list of up to 30 venues.` };
        const list = [];
        for (const x of v) {
          const r = venue(x, 'every project');
          if (r.error) return r;
          list.push(r.value);
        }
        out[k] = list.length ? list : null;
      }
    }
    if (!Object.keys(out).length) return { error: 'Nothing has changed.' };
    return { changes: out };
  }

  // A whole new service added on the All services page: every editable field the schema requires must be there
  // (an empty list or null where nothing applies). The apply script adds the rest (id, provenance, listing...).
  const NEEDED = EDITABLE.filter((k) => schema.required.includes(k) && k !== 'hwlFunded');
  function checkNew(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'The new service is missing.' };
    const missing = NEEDED.filter((k) => !(k in input));
    if (missing.length) return { error: 'Missing: ' + missing.map((k) => LABEL[k] || k).join(', ') + '.' };
    const r = checkChanges(input);
    return r.error ? r : { service: r.changes };
  }

  return { EDITABLE, TEAM_ONLY, LABEL, checkChanges, checkNew, same };
}
