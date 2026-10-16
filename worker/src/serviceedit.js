// Checks a change to a service's details sent from the All services page (MVP team only), before it is stored.
//
// Only the fields below can be edited this way. The allowed values (areas, categories and so on) come from
// data/schema.json, so they stay in step with the data. The full check against the schema runs again when the
// change is written into the data (scripts/apply-decisions.mjs) and in the pull request's checks.
//
// It also checks a whole new service added there (checkNew).
//
// A change is a set of fields with their new values. null means "remove this optional detail" (for example no
// phone number any more). Fields not in the change are left as they are.

// The Worker passes data/schema.json in (see index.js), so this file has no bundler-only imports.
export function makeChecker(schema) {
  const P = schema.properties;
  const enumOf = (prop) => (prop.items ? prop.items.enum : prop.enum);

  // field -> how to check it
  const TEXT = { name: 150, organisation: 150, status: 200, whoFor: 600, workExperience: 300 };
  const NULLABLE_TEXT = { age: 60, phone: 200 };
  const OPTIONAL_TEXT = { cost: 200, languages: 300, notes: 1500 };
  const ENUM = { level: enumOf(P.level), reviewCycle: enumOf(P.reviewCycle) };
  const ENUM_LIST = { audience: [enumOf(P.audience), 1], categories: [enumOf(P.categories), 1], areas: [enumOf(P.areas), 1], healthFocus: [enumOf(P.healthFocus), 0] };
  const TEXT_LIST = { social: 0, locations: 0, eligibility: 0, exclusions: 0, gate: 0, referralRoutes: 1 };
  const SELF = enumOf(P.selfReferral.properties.allowed);

  const EDITABLE = [
    ...Object.keys(TEXT), ...Object.keys(NULLABLE_TEXT), ...Object.keys(OPTIONAL_TEXT), ...Object.keys(ENUM), ...Object.keys(ENUM_LIST),
    ...Object.keys(TEXT_LIST), 'open', 'webpage', 'email', 'selfReferral', 'activities',
  ];

  const URL_RE = /^https?:\/\/\S+$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const LABEL = {
    name: 'Name', organisation: 'Organisation', status: 'Status', whoFor: "Who it's for", workExperience: 'Work experience', age: 'Age',
    phone: 'Phone', cost: 'Cost', languages: 'Languages', notes: 'Notes', level: 'Level', reviewCycle: 'Review cycle', audience: 'Audience',
    categories: 'Categories', areas: 'Areas', healthFocus: 'Health focus', social: 'Social media', locations: 'Where', eligibility: 'Eligibility',
    exclusions: "Can't help", gate: 'Must already be', referralRoutes: 'How to get in', open: 'Open', webpage: 'Web page', email: 'Email',
    selfReferral: 'Self-referral', activities: 'What it offers',
  };

  const str = (v) => (typeof v === 'string' ? v.trim() : null);

  // Returns { changes } with every value cleaned, or { error } saying what's wrong in plain words.
  function checkChanges(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Nothing to change.' };
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      const label = LABEL[k] || k;
      if (!EDITABLE.includes(k)) return { error: `"${k}" can't be changed here.` };
      if (k in TEXT) {
        const t = str(v);
        if (!t) return { error: `${label} can't be empty.` };
        if (t.length > TEXT[k]) return { error: `${label} is too long (at most ${TEXT[k]} characters).` };
        out[k] = t;
      } else if (k in NULLABLE_TEXT || k in OPTIONAL_TEXT) {
        const max = NULLABLE_TEXT[k] || OPTIONAL_TEXT[k];
        const t = v === null ? '' : str(v);
        if (t === null) return { error: `${label} must be text.` };
        if (t.length > max) return { error: `${label} is too long (at most ${max} characters).` };
        out[k] = t || null;
      } else if (k === 'webpage' || k === 'email') {
        const t = v === null ? '' : str(v);
        if (t === null) return { error: `${label} must be text.` };
        if (t && k === 'webpage' && (!URL_RE.test(t) || t.length > 500)) return { error: 'The web page must start with http:// or https:// and have no spaces.' };
        if (t && k === 'email' && (!EMAIL_RE.test(t) || t.length > 200)) return { error: "The email address doesn't look right." };
        out[k] = t || null;
      } else if (k === 'open') {
        if (typeof v !== 'boolean') return { error: 'Open must be yes or no.' };
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
        if (!Array.isArray(v) || v.length > 30) return { error: `${label} must be a list of up to 30 lines.` };
        const list = v.map(str);
        if (list.some((x) => !x)) return { error: `${label} has an empty line.` };
        if (list.some((x) => x.length > 500)) return { error: `A line in ${label} is too long (at most 500 characters).` };
        if (list.length < TEXT_LIST[k]) return { error: `${label} needs at least one line.` };
        out[k] = list;
      } else if (k === 'selfReferral') {
        if (!v || typeof v !== 'object') return { error: 'Self-referral is missing.' };
        if (!SELF.includes(v.allowed)) return { error: `Self-referral must be one of: ${SELF.join(', ')}.` };
        const note = str(v.note);
        if (!note || note.length > 300) return { error: 'Say a little about self-referral (up to 300 characters).' };
        const url = str(v.url || '') || '';
        if (url && (!URL_RE.test(url) || url.length > 500)) return { error: 'The self-referral link must start with http:// or https://.' };
        out[k] = url ? { allowed: v.allowed, note, url } : { allowed: v.allowed, note };
      } else if (k === 'activities') {
        if (!Array.isArray(v) || v.length < 1 || v.length > 12) return { error: 'Give between 1 and 12 things it offers.' };
        const list = [];
        for (const a of v) {
          const name = str(a && a.name);
          const summary = str(a && a.summary);
          const duration = str((a && a.duration) || '') || '';
          if (!name || !summary) return { error: 'Each thing it offers needs a name and a summary.' };
          if (name.length > 150 || summary.length > 800 || duration.length > 150) return { error: 'A thing it offers is too long.' };
          list.push({ name, summary, duration });
        }
        out[k] = list;
      }
    }
    if (!Object.keys(out).length) return { error: 'Nothing has changed.' };
    return { changes: out };
  }

  // A whole new service added on the All services page: every editable field the schema requires must be there
  // (an empty list or null where nothing applies). The apply script adds the rest (id, provenance, listing...).
  const NEEDED = EDITABLE.filter((k) => schema.required.includes(k));
  function checkNew(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'The new service is missing.' };
    const missing = NEEDED.filter((k) => !(k in input));
    if (missing.length) return { error: 'Missing: ' + missing.map((k) => LABEL[k] || k).join(', ') + '.' };
    const r = checkChanges(input);
    return r.error ? r : { service: r.changes };
  }

  return { EDITABLE, checkChanges, checkNew };
}
