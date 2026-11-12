---
name: check-scheme-entry
description: Check and update one Support Finder scheme entry (a file in data/services/) against the provider's own current sources, then propose or apply the edit with honest provenance.
---

# Check one Support Finder scheme entry

Use this when asked to check, verify, refresh or update a single scheme or service in the Healthy Working Life Support Finder. One scheme per run. For a batch, run it once per scheme.

## 0. Find the entry

- The person may give an id (`kirklees-success-centre`), a name, or a rough description. Find the file in `data/services/` (file name = id). If several match, ask which one.
- Read the whole file, plus `docs/data-dictionary.md` and `data/schema.json` if not already read this session. They are the source of truth for field meanings and allowed values.

## 1. Gather evidence

**Every scheme, HWL-funded or not, is checked against the provider's own website.** Start with `webpage` and `provenance.checkedUrl`, then the organisation's main site.

Other sources, in order of weight:
1. **What the person tells you** (e.g. a reply from the scheme's named contact). This beats everything else.
2. **For HWL-funded schemes (`hwlFunded: true`)**: also check `docs/programme/Kirklees HWL Pathways Aug 26 v2.1.docx` (or a newer version the person names). Compare it field by field with the provider's website:
   - If they agree: confirmed.
   - If they differ: don't silently pick one. Show both versions with sources and ask the person which stands, or whether to raise it with the programme team. Note which document is newer where you can tell.
3. Official directories (Kirklees Council, NHS, GOV.UK, Kirklees Community Directory) as backup only.

Never take contact details, eligibility or opening times from aggregators, forums or AI summaries. If the only source is weak, say so and lower confidence rather than changing the data.

## 2. Check each field

Work through the entry and note for each: **confirmed**, **changed** (old → new, with source URL), **sources disagree** (HWL schemes), or **couldn't confirm**.

Priority order:
- **Still running?** → `open` and each project's (and session's) dates: `runsFrom`, `runsTo`, `referralsFrom`, `referralsUntil`. If it has closed, propose an end date (it then stops showing by itself) or `open: false` if it isn't taking referrals at all. Note the source in the team `notes`. Don't delete the file.
- **Contact**: `webpage` (does it load, is it the right page?), `email`, `phone`, `selfReferral.url`. Copy exactly from the provider; never tidy or guess.
- **Who it's for**: `whoFor`, `age`, `eligibility`, `exclusions`, `gate`, `healthFocus`, `audience`.
- **Where**: each project's `where` (and `locations` for places every project uses), `areas` (allowed values only: Batley, Colne Valley, Dewsbury, Holme Valley, Huddersfield, Kirkburton, Mirfield, Spen Valley, Kirklees-wide, Online).
- **How to get in**: `referralRoutes`, `selfReferral.allowed` (`yes`/`partly`/`no`/`tbc`) and `note`.
- **What it does**: `projects` (name, overview up to 400 characters, how it runs, `duration`, `places`, and sessions: each venue with its days and times, or a group of its own such as an age cohort; a project or session only records what differs from the service). Venues go in `data/venues.json` with a full postcode; never type a ward. Tick `groups` only from what the provider says, `cost`, `workExperience`, `languages`, `coachNotes`.
- **The organisation**: its overview and website live in `data/organisations.json`, shared by all its services. Never mention Healthy Working Life there.
- Any remaining `"To be completed"` placeholders.
- `categories`: only from the schema list, most important first.

## 3. Report before editing

Show the person a short table: field | now | proposed | source (for HWL schemes add a column for the Pathways doc). Then list anything you couldn't confirm and any disagreements. Ask for a go-ahead before writing, unless they've already said "just update it".

Rules for the proposed values:
- House style: plain, informal, UK spelling, reading age about 11 for anything shown on cards (`whoFor`, project overviews, `coachNotes`). `notes` are team notes and never shown.
- **Never change `id`.** The model, tests and smoke checks depend on it.
- **Never add a helpline or urgent phone number to the prompt or `URGENT_CONTACTS`.** Scheme `phone` fields are fine if copied from the provider.
- Don't change `listing.decision` yourself. That's the development team's call via the All services page. You can recommend one, e.g. "suggest exclude: service closed March 2026".
- `requiresMention` lists are shared by groups of schemes. If one needs changing, flag it; don't edit just one.
- Don't invent missing details. Leave the field as it is (or `null`/`[]`) and list it as a gap.

## 4. Apply the edit

With the go-ahead:
- Edit only the fields that changed. Keep the JSON shape and field order.
- `lastUpdated`: set to today **only if the entry was actually checked against the provider's current website** (or a confirmed reply from the provider). For HWL schemes, checking the Pathways doc alone does not reset it.
- `provenance`: set `checkedUrl` to the provider page used, `evidence` to a one-line why-it's-current (e.g. "Provider page updated Oct 2026; matches Pathways v2.1"), and `confidence` (`high` = provider confirmed or page clearly current and, for HWL schemes, matching the Pathways doc; `medium` = page exists but undated/ambiguous, or an unresolved difference; `low` = couldn't confirm). Keep `source`; add to `foundVia` only if useful.
- Run:

      npm run check-data
      npm run build-data

  Fix anything `check-data` reports before going on.
- Commit on a branch named `data/ID-check-YYYY-MM-DD`, with a message like `Check ID: what changed`, and open a pull request (or tell the person the commands if you can't push). Don't push to `main` directly.
- Only add a line to `site/changes.html` if coaches would notice (scheme closed, reopened, big eligibility change). Contact tweaks don't need one.

## 5. Optional: summary for the scheme's contact

The team checks local schemes with a named contact at the provider, without giving them site access. If asked (or if confidence is below high), draft a short plain-English email the person can send: the scheme name, what the Support Finder currently says (who it's for, how to get in, contact details, locations, cost), and three questions: "Is this right?", "Anything missing?", "Who should we check with next time?". No internal fields (`provenance`, `listing`, `requiresMention`, ids). Don't send it; hand the draft over.

## 6. Finish

One short summary: what changed, what's still unconfirmed or disputed, the confidence level, and the PR link or next command. Don't recap the steps.
