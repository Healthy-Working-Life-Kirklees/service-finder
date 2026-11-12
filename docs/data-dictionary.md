# Scheme data dictionary

This describes the scheme data: everything the Support Finder knows about each scheme or service. Each one is a file in `data/services/`, named after its id (for example `data/services/elevate.json`). The AI is given every service on the live list (`"listing": {"decision": "include"}`) with every message (without contact details), and the scheme cards on the page are drawn from them. If it isn't in these files, the finder doesn't know about it.

There are 215 at the moment (16 October 2026):

- **31 Healthy Working Life schemes**, converted by hand from the "Kirklees HWL Pathways Aug 26 v2.1" document (`"hwlFunded": true`). On the live list.
- **137 other local, regional and national services**, imported from the "Kirklees additional services" spreadsheet (v3, web research in October 2026). On the live list.
- **47 services waiting for the development team to review** (`"decision": "review"`), not on the live list:
  - the 40 on the spreadsheet's "Not verified or closed" tab: 35 the research couldn't confirm as running, and 5 it found closed. Only what the spreadsheet gave is filled in (name, organisation, link and why it wasn't confirmed, in `notes`). Everything else the research didn't find says "To be completed", and the categories, level, areas and health focus are a first guess from the name. Confidence is `low`.
  - 7 rows left out of the October import: 3 crisis lines (Samaritans, CALM, Shout) and 4 directories (Kirklees Welcomes, MECC Link, the District Provision Tool, Hub of Hope). Their details are complete, copied from the spreadsheet.

## How a listing is organised (November 2026)

    organisation  >  service  >  project  >  session (optional)     and venues, shared by everyone

- An **organisation** has one record in `data/organisations.json`, shared by all its services: its name, a short overview and website. It never says whether something is a Healthy Working Life scheme: that is `hwlFunded` on each service, because an organisation can run other work too.
- A **service** (one file in `data/services/`) is what a coach refers someone to. Who it is for, how to get in and the contact details are given **once, here**.
- A service has one or more **projects**: what actually happens, where, when and for how long, with optional dates. A project only records what is *different* from the service (an extra criterion, a different age or audience). Most services have one project.
- A project says **how it runs** (`runs`: at set times and places, by appointment or around the person, online or by phone; any mix) and has **sessions**: the project at a **venue** on given days and times (Tuesdays 1pm to 3pm at Jo Cox House), or for a group of its own (Raise Your Game's session for ages 18 to 24 and its session for 50 and over, which were "cohorts" until November 2026). A session also only records what is different.
- A **venue** has one record in `data/venues.json`, shared by every session there: name, address and postcode, plus the ward and map position looked up from the postcode (`scripts/lookup-venues.mjs`, postcodes.io, run when the team's changes are applied). That is what makes the timetable, the map and the counts by ward on the "Across Kirklees" page.
- **Who it's for** (`groups`) is a fixed list to tick (women, young people 12 to 18, families, "everyone (no restriction)" and so on: `GROUPS` in `site/listing-logic.js`), so services can be counted and filtered. The written eligibility stays for people to read; each line can be ticked **Essential**, which is what `gate` holds.

Nothing was dropped when the data was moved into this shape: `scripts/convert-structure.mjs` (a record of the one-off conversion) checks that every piece of text in each old listing is still there.

### Dates and what is shown

Projects and sessions have four optional dates (`runsFrom`, `runsTo`, `referralsFrom`, `referralsUntil`, all `YYYY-MM-DD`). Blank means ongoing. A session without its own date uses its project's. The rules are in `site/listing-logic.js`, used by the page, the forms, the Worker, the directory and the checks:

- After `runsTo` or `referralsUntil`: closed. Not suggested, not on the cards or in the directory.
- `referralsFrom` within the next 31 days: suggested if it fits, marked "Referrals open from" the date.
- `referralsFrom` further ahead: not suggested; the AI only mentions it if someone asks for it by name.
- The AI says which projects or sessions fit the person. Sessions for a group of their own (an age, extra criteria or an essential criterion) that don't fit are left off the card: a 20-year-old sees Raise Your Game's first cohort; with no age given, both. Sessions that are only a time and place are all shown, the ones the AI picked (nearest, or at a time the person can make) first.
- Every morning the Worker emails the team about anything ending, or closing to referrals, in the next 30 days, with a fresh review link and an email to forward to the organisation (`worker/src/reminders.js`). The directory is rebuilt every morning too.

### Character limits on the forms

Organisation overview 300, "Who your service is for" 300, project overview 400, "Anything coaches should know" 500. Longer text already in the data is kept as it is: `npm run check-data` lists it, and Admin flags it, so it can be shortened when next checked.

## Files

| File | What it is |
|---|---|
| `data/services/<id>.json` | One scheme. The file name must be the scheme's `id`. |
| `data/venues.json` | One record per place: `id`, `name`, `address`, `postcode`, and from the postcode `ward`, `wardCode`, `lat` and `lng` (filled in by `scripts/lookup-venues.mjs`, never typed), plus optional `aliases` and team `notes`. Renaming, correcting and combining venues is done under Venues on the All services page; nothing is combined automatically. |
| `data/organisations.json` | One record per organisation: `id`, `name`, and optional `overview` (up to 300 characters), `website`, `aliases` (older names, so services and suggestions using them still match) and team `notes`. A service's `organisation` must be one of these names. Renaming and combining organisations is done on the All services page in Admin; nothing is combined automatically. |
| `data/meta.json` | `source`, `converted` and `notes` for the data as a whole. |
| `data/schema.json` | The rules every scheme file must follow (a JSON Schema). The checks use it, and so can any tool or agent that edits the data. |
| `data/services.json` | **Generated**, not kept in the repository. `npm run build-data` combines the scheme files on the live list (`listing.decision` is `include`) into it, sorted by id, for the page, the Worker and the tests. Don't edit it: changes are lost at the next build. |
| `data/services-all.json` | **Generated** in the same way, with every service whatever its decision, for the All services page in Admin. Published with the Admin pages. |

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
| `organisation` | text | Who runs it, as it appears under the name. Must be a `name` in `data/organisations.json`. The organisation's overview is added to the generated files as `organisationOverview`. |
| `logo` | text | Optional. The file name of the organisation's logo in `site/img/logos/`, for example `proper-job.webp`. Shown at the top left of the card. Several schemes can share one logo. Without it the card shows a coloured block instead. Keep logos small (about 320 pixels wide is plenty). `shared-goods.webp` is already in the folder, ready for when Shared Goods Charity's scheme is added. |
| `mapLinks` | true / false | Optional. Cards show a **Get directions** and **Show on map** button (Google Maps) next to every location that has a full postcode. Set this to `false` for a service whose address shouldn't be pointed to, for example a confidential venue: the address text still shows, without the buttons. Leave it out normally. |
| `open` | true / false | Whether the service is taking new referrals. The Worker only ever recommends services where this is `true` and at least one project or session is open (see "Dates and what is shown"). (The old `status` text was moved in November 2026: for Healthy Working Life schemes into the team `notes`, word for word, and for the others into `provenance.status`.) |
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
| `locations` | list of text | Places used by **every** project (venues, addresses, or how it's delivered, for example "Phone and online"). A place used by one project goes in that project's `where`. With a full postcode, the card shows map and directions buttons. |
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
| `projects` | list | At least one. Each project has an `id` (lower-case with hyphens, unique in the service; the AI names it when only some projects fit), a `name` and an `overview` (what happens, up to 400 characters on the forms). Optional: `runs` (any of `set`, `appointment`, `online`), `area` (the area a project by appointment covers, in words), `where` (places without a postcode, in words, such as "Online"), `when` (days and times in words, when they don't fit sessions), `duration`, `places`, `age`, `audience` (list), `eligibility` and `gate` (lists, only what is extra to the service), the four dates, and `sessions`. |
| `projects[].sessions` | list | Optional. Each has an `id`, and optionally a `name`, a `venue` (an id in `data/venues.json`), `days` (`mon` to `sun`), `start` and `end` (24-hour, such as `13:30`), `frequency` (`weekly`, `fortnightly`, `monthly`, `once`, `varies`), a `note` (anything else about when or where, in words), `where`, `when`, `age`, `eligibility`, `gate`, `places` and the four dates: only what differs from the project. Sessions made from the addresses in the listings in November 2026 carry the original wording after the postcode (such as "Fri 10.30–2.30") as their `note`, for the service to turn into days and times. |
| `venues` | list | Optional. Venue ids (in `data/venues.json`) used by every project. |
| `groups` | list | Optional. Who it's for, from the fixed list (`everyone`, `children`, `young-people`, `young-adults`, `adults`, `adults-50`, `older-people`, `families`, `parents`, `mothers`, `fathers`, `women`, `men`, `carers`, `disabled`, `health-condition`, `mental-health`, `refugees`, `ethnic-minority`, `lgbtq`, `students`, `veterans`). Empty means not ticked yet. |
| `workExperience` | text | Whether the scheme offers volunteering or work experience, as free text (for example `No`, `Yes - volunteering and placements`). |
| `cost` | text | Optional. What it costs, for example `Free`, `Free if eligible; otherwise fees`, `£5 per 28 days`. Shown on the card. The AI mentions it when a service isn't free for everyone. |
| `languages` | text | Optional. Interpreting, BSL, Welsh or other formats offered. Shown on the card. |
| `coachNotes` | text | Optional. "Anything coaches should know", from the service: waiting times, what to bring and so on. Shown on the card as "Good to know" and given to the AI. |
| `notes` | text | Optional. **Team notes**: research and admin notes, including the old status wording of Healthy Working Life schemes. Never shown on cards or sent to the AI. |

### Keeping it fresh

| Field | Type | What it is |
|---|---|---|
| `lastUpdated` | date | When the scheme's entry was last checked, as `YYYY-MM-DD`. Shown on the card as "Information last checked". If it's more than 135 days old, the card carries a warning and `npm run check-data` lists it. The imported services use 14 October 2026, the date of the web research. |
| `reviewCycle` | text | How often the entry should be rechecked: `Quarterly`, `Six-monthly` or `Yearly`. At the moment it's `Quarterly` for every scheme. |
| `provenance` | object | Where the details came from, so they can be rechecked by a person or a maintenance agent. `source` (required): the document, or the spreadsheet and row. Optional: `foundVia` (how the service was found, for example "Kirklees Community Directory"), `checkedUrl` (the page the details were checked against), `evidence` (why it's thought to be current), `confidence` (`high`, `medium` or `low`), `status` (the October 2026 web research's status wording, kept word for word). Not sent to the AI or shown on cards; the Admin pages show the source and flags medium confidence. |

### On the live list or not

| Field | Type | What it is |
|---|---|---|
| `listing.decision` | text | `include` (on the live list: shown on the finder and given to the AI), `review` (needs further review, not live) or `exclude` (left out completely, not live). Only `include` reaches `services.json`. A service that still says "To be completed" anywhere can't be `include`. |
| `listing.reason` | text | Why. For the development team's decisions, the reason they gave. |
| `listing.by` | text | Optional. Who made the decision (name or initials, as entered on the All services page). Absent for the starting values set when the service was added. |
| `listing.date` | date | Optional. When the decision was made, as `YYYY-MM-DD`. |

The development team makes these decisions on the All services page, and can also edit most of a service's other fields and add new services there (a new service starts as `review`, with `provenance.source` saying who added it); `npm run apply-decisions` writes both into the scheme files (see the README). `open` is separate: it says whether a scheme is taking referrals. An included scheme that isn't open is shown but never recommended.

## Known quirks

These are worth knowing before you build anything that reads or filters the data.

- **Several fields are free text and can't be reliably filtered:** `age`, `when`, `duration`, `workExperience`, `cost` and `referralRoutes` are worded differently from scheme to scheme.
- **Dates written as words.** Before November 2026 dates were only in the text. Four were turned into real dates by hand (Audio Boost, the two P2P schemes and Shared Hope); the wording is still in `duration`. Others may still have dates in words only, for the services to set when they check their listings.
- **`listing` and `open` are different things.** `listing` decides whether the finder knows about a service at all; `open` whether it can be recommended.
- **Some schemes are missing a web page, email or phone.** The cards simply leave out what isn't there.
- **`areas` mixes towns with `Kirklees-wide` and `Online`** in the same list.
- **The imported services were filled in partly by hand and partly with AI help.** Contact details, names and descriptions were copied from the spreadsheet exactly. Areas, age, eligibility, gates, health focus, self-referral and the activity name were worked out from the spreadsheet's text. What still needs a person to check is listed in [`import-review-2026-10.md`](import-review-2026-10.md).
- **The crisis wording check runs before matching.** Someone who writes the word "suicide" sees the crisis panel and no cards, so the West Yorkshire Suicide Bereavement Service won't be shown in that conversation, even to someone bereaved by suicide.
