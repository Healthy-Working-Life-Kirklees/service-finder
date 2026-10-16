# Scheme data dictionary

This describes the scheme data: everything the Service Finder knows about each scheme or service. Each one is a file in `data/services/`, named after its id (for example `data/services/elevate.json`). The AI is given every service on the live list (`"listing": {"decision": "include"}`) with every message (without contact details), and the scheme cards on the page are drawn from them. If it isn't in these files, the finder doesn't know about it.

There are 215 at the moment (16 October 2026):

- **31 Healthy Working Life schemes**, converted by hand from the "Kirklees HWL Pathways Aug 26 v2.1" document (`"hwlFunded": true`). On the live list.
- **137 other local, regional and national services**, imported from the "Kirklees additional services" spreadsheet (v3, web research in October 2026). On the live list.
- **47 services waiting for the MVP team to review** (`"decision": "review"`), not on the live list:
  - the 40 on the spreadsheet's "Not verified or closed" tab: 35 the research couldn't confirm as running, and 5 it found closed. Only what the spreadsheet gave is filled in (name, organisation, link and why it wasn't confirmed, in `notes`). Everything else the research didn't find says "To be completed", and the categories, level, areas and health focus are a first guess from the name. Confidence is `low`.
  - 7 rows left out of the October import: 3 crisis lines (Samaritans, CALM, Shout) and 4 directories (Kirklees Welcomes, MECC Link, the District Provision Tool, Hub of Hope). Their details are complete, copied from the spreadsheet.

## Files

| File | What it is |
|---|---|
| `data/services/<id>.json` | One scheme. The file name must be the scheme's `id`. |
| `data/meta.json` | `source`, `converted` and `notes` for the data as a whole. |
| `data/schema.json` | The rules every scheme file must follow (a JSON Schema). The checks use it, and so can any tool or agent that edits the data. |
| `data/services.json` | **Generated**, not kept in the repository. `npm run build-data` combines the scheme files on the live list (`listing.decision` is `include`) into it, sorted by id, for the page, the Worker and the tests. Don't edit it: changes are lost at the next build. |
| `data/services-all.json` | **Generated** in the same way, with every service whatever its decision, for the MVP team's All services page. Published only with the MVP pages. |

## Updating the data

Edit a scheme's file, or add a new one, then run:

    npm run check-data
    npm run build-data

`check-data` checks every file against `data/schema.json`, and also that the file name matches the id, logos exist, `requiresMention` patterns are valid, no date is in the future, and nothing on the live list still says "To be completed". It lists live entries overdue for a check without failing, and counts how many services are included, waiting for review and excluded.

Push to a branch and open a pull request. The **Checks** workflow runs the same check. Both deploys (GitHub Pages and the Cloudflare Worker) check and build again when changes reach `main`, and stop if the data has a problem, so the site and the AI always pick up the same data.

JSON is fussy: a stray comma or missing quote will break a file, but the check names the file and the line. Dates are always `YYYY-MM-DD`.

To add a new allowed value (a new area, category or health focus), change `data/schema.json`, this document, and, for health focus, the `HF` list in `worker/test/logic.mjs` and the matching rules in `prompt/system.md`.

## meta.json

| Field | What it is |
|---|---|
| `source` | Which documents the data came from, and their versions or dates. Each scheme also has its own `provenance`. |
| `converted` | The date the data was first converted. |
| `notes` | A short reminder about how the data is stored. |

## Fields for each scheme

Every scheme has every field below, except where it says "optional". An empty list is `[]`, and a missing contact detail is `null`. No other fields are allowed: the check rejects a misspelt field name.

### Identity

| Field | Type | What it is |
|---|---|---|
| `id` | text | A short, unique, lower-case label with hyphens, for example `employment-kirklees`. The file name is the id. The AI picks schemes by this ID, so don't change one casually. |
| `name` | text | The scheme's name as it appears on the card. |
| `organisation` | text | Who runs it, as it appears under the name. |
| `logo` | text | Optional. The file name of the organisation's logo in `site/img/logos/`, for example `proper-job.webp`. Shown at the top left of the card. Several schemes can share one logo. Without it the card shows a coloured block instead. Keep logos small (about 320 pixels wide is plenty). `shared-goods.webp` is already in the folder, ready for when Shared Goods Charity's scheme is added. |
| `status` | text | The scheme's status in words, for example "Live - open to referrals". For the imported services it says they were found running by web research in October 2026. |
| `open` | true / false | Whether the scheme is live. **This is the one that matters.** The Worker only ever recommends schemes where this is `true`, and cards for others say "Not open yet". |
| `hwlFunded` | true / false | `true` for the Healthy Working Life programme's own schemes. When an HWL scheme and another service fit about as well, the AI lists the HWL scheme first. |
| `level` | text | `local` (based in Kirklees), `regional` (West Yorkshire or the wider region) or `national` (UK or England, usually by phone or online). Regional and national services get a badge on the card, and the AI prefers a local service when two fit about as well. |
| `audience` | list | Who the scheme is for: `individual`, `employer`, `organisation` or `student`. A scheme can have more than one. One that is only for a particular group (students, say) doesn't list `individual`. The AI only recommends a non-individual scheme when the person clearly is that kind of person. |
| `categories` | list | What the service covers, from a fixed list: Apprenticeships, Benefits and money, Bereavement, Carers, Debt, Digital skills, Disability & neurodiversity, Drug/alcohol, Employers, Employment rights, ESOL, Finding work, Health linked to work, Housing, Long-term conditions, Men, Mental health, MSK, Older workers, Prison leavers, Refugees and new arrivals, Returning to learning, Self-employment, Skills, Staying in work, Travel, Veterans, Volunteering, Wellbeing, Women, Young people. Most important first. A quick guide for the AI and for filtering; the other fields decide who can use it. |

### Who it's for

| Field | Type | What it is |
|---|---|---|
| `whoFor` | text | A plain-English sentence describing who the scheme helps. |
| `age` | text or `null` | The age range, as free text (for example `18+`, `16-25`, `Under 25`). `null` when the source doesn't say. |
| `eligibility` | list of text | The criteria someone needs to meet. |
| `exclusions` | list of text | Anyone the scheme can't help. Often empty. |
| `gate` | list of text | Things a person must already be, or already be using, to get in, written as "Is ..." or "Has ...": for example being a Kirklees College student, a Kirklees Council tenant, a veteran, or in treatment with Change Grow Live. Empty means no gate. If someone clearly doesn't meet a gate, the AI leaves the scheme out. If it's unclear, the scheme can still be suggested as a "possible", with a note on what to check. Women-only services say so in `eligibility`, not as a gate. |
| `healthFocus` | list of text | Which health needs the scheme is for. Empty means no health requirement. `any` means any health condition or disability. Otherwise one or more of `mental-health`, `severe-mental-illness`, `musculoskeletal-pain`, `substance-use`, `learning-disability-autism`, `unpaid-caring`. Specific ones are only matched when the person has said or clearly described the need. There is no separate value for cancer, dementia or gambling: those services use `any` or `[]` and say so in their eligibility. |
| `requiresMention` | list of text | Optional. Words or patterns the person's own messages must match before the scheme can appear, so schemes for a sensitive circumstance are never suggested unprompted. The Worker joins the list into one case-insensitive regular expression and tests it against what the person typed. It's applied by the Worker, not sent to the AI. Because it's JSON, a word boundary is written `\\b`. At the moment the lists cover substance use, severe mental illness, learning disability and autism, people with convictions, bereavement and gambling. Every scheme in a group uses the same list, so update them together. The Polish and Urdu words are a first draft for a translator to check. |

### Contact

| Field | Type | What it is |
|---|---|---|
| `webpage` | text or `null` | The scheme's web page, starting `http://` or `https://`. |
| `email` | text or `null` | A contact email address. |
| `phone` | text or `null` | A contact phone number, sometimes with opening hours or a second number in the same text. |
| `social` | list of text | Social media links or handles. Usually empty. |

### Where

| Field | Type | What it is |
|---|---|---|
| `locations` | list of text | The venues, addresses and times where the scheme runs, or how it's delivered (for example "Phone and online"). |
| `areas` | list of text | The areas used for matching: `Batley`, `Colne Valley`, `Dewsbury`, `Holme Valley`, `Huddersfield`, `Kirkburton`, `Mirfield`, `Spen Valley`, plus `Kirklees-wide` and `Online`. Phone, regional and national services that any Kirklees resident can use are `Kirklees-wide`. `Online` means the support itself is online, not just a referral form. The finder works at town level only, not postcode. |

### How to get in

| Field | Type | What it is |
|---|---|---|
| `referralRoutes` | list of text | The ways someone can be referred, as free text. Some include a link. At least one. |
| `selfReferral.allowed` | text | `yes`, `partly`, `no` or `tbc`. Drives the badge on the card: "You can refer yourself", "Self-referral with a link from a professional", "Needs a referral" or "Self-referral: to be confirmed". |
| `selfReferral.note` | text | A short explanation of the self-referral position. |
| `selfReferral.url` | text | Optional. A direct link for self-referral. |

### What it does

| Field | Type | What it is |
|---|---|---|
| `activities` | list | What the scheme offers. Each item has a `name`, a `summary` and a `duration`, all text. `duration` can be empty (the imported services have one activity, with the spreadsheet's "What it does" as the summary). |
| `workExperience` | text | Whether the scheme offers volunteering or work experience, as free text (for example `No`, `Yes - volunteering and placements`). |
| `cost` | text | Optional. What it costs, for example `Free`, `Free if eligible; otherwise fees`, `£5 per 28 days`. Shown on the card. The AI mentions it when a service isn't free for everyone. |
| `languages` | text | Optional. Interpreting, BSL, Welsh or other formats offered. Shown on the card. |
| `notes` | text | Optional. Anything else worth knowing. |

### Keeping it fresh

| Field | Type | What it is |
|---|---|---|
| `lastUpdated` | date | When the scheme's entry was last checked, as `YYYY-MM-DD`. Shown on the card as "Information last checked". If it's more than 135 days old, the card carries a warning and `npm run check-data` lists it. The imported services use 14 October 2026, the date of the web research. |
| `reviewCycle` | text | How often the entry should be rechecked: `Quarterly`, `Six-monthly` or `Yearly`. At the moment it's `Quarterly` for every scheme. |
| `provenance` | object | Where the details came from, so they can be rechecked by a person or a maintenance agent. `source` (required): the document, or the spreadsheet and row. Optional: `foundVia` (how the service was found, for example "Kirklees Community Directory"), `checkedUrl` (the page the details were checked against), `evidence` (why it's thought to be current), `confidence` (`high`, `medium` or `low`). Not sent to the AI or shown on cards; the MVP help page shows the source and flags medium confidence. |

### On the live list or not

| Field | Type | What it is |
|---|---|---|
| `listing.decision` | text | `include` (on the live list: shown on the finder and given to the AI), `review` (needs further review, not live) or `exclude` (left out completely, not live). Only `include` reaches `services.json`. A service that still says "To be completed" anywhere can't be `include`. |
| `listing.reason` | text | Why. For the MVP team's decisions, the reason they gave. |
| `listing.by` | text | Optional. Who made the decision (name or initials, as entered on the All services page). Absent for the starting values set when the service was added. |
| `listing.date` | date | Optional. When the decision was made, as `YYYY-MM-DD`. |

The MVP team makes these decisions on the All services page, and can also edit most of a service's other fields there; `npm run apply-decisions` writes both into the scheme files (see the README). `open` is separate: it says whether a scheme is taking referrals. An included scheme that isn't open is shown but never recommended.

## Known quirks

These are worth knowing before you build anything that reads or filters the data.

- **Several fields are free text and can't be reliably filtered:** `age`, `status`, `workExperience`, `cost` and `referralRoutes` are worded differently from scheme to scheme.
- **`status` and `open` overlap.** `open` is the one the code uses. On the live list, only HWL Community Grants is currently `false`. The 5 closed services waiting for review are also `false`.
- **`listing` and `open` are different things.** `listing` decides whether the finder knows about a service at all; `open` whether it can be recommended.
- **Some schemes are missing a web page, email or phone.** The cards simply leave out what isn't there.
- **`areas` mixes towns with `Kirklees-wide` and `Online`** in the same list.
- **The imported services were filled in partly by hand and partly with AI help.** Contact details, names and descriptions were copied from the spreadsheet exactly. Areas, age, eligibility, gates, health focus, self-referral and the activity name were worked out from the spreadsheet's text. What still needs a person to check is listed in [`import-review-2026-10.md`](import-review-2026-10.md).
- **The crisis wording check runs before matching.** Someone who writes the word "suicide" sees the crisis panel and no cards, so the West Yorkshire Suicide Bereavement Service won't be shown in that conversation, even to someone bereaved by suicide.
