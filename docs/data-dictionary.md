# Scheme data dictionary

This describes `data/services.json`, the one file that holds everything the Service Finder knows about each scheme. The AI is given the whole file with every message, and the scheme cards on the page are drawn from it. If it isn't in this file, the finder doesn't know about it.

The file was converted by hand from the "Kirklees HWL Pathways Aug 26 v2.1" document. It currently holds 17 schemes (checked 8 October 2026).

## Updating the data

Edit `data/services.json` and push to `main`. Both deploys (GitHub Pages and the Cloudflare Worker) are triggered by changes to the `data/` folder, so the site and the AI pick up the change together. There's no other copy to keep in step.

JSON is fussy: a stray comma or missing quote will break the file. Check it parses before you push (for example by pasting it into a JSON validator). Dates are always `YYYY-MM-DD`.

## Top level

| Field | What it is |
|---|---|
| `source` | Which document the data came from, and its version or date. |
| `converted` | The date the data was first converted from that document. |
| `notes` | A short reminder about the file, kept inside the file itself. |
| `services` | The list of schemes. Everything below describes one scheme in this list. |

## Fields for each scheme

Every scheme has every field below, except where it says "optional". An empty list is `[]`, and a missing contact detail is `null`.

### Identity

| Field | Type | What it is |
|---|---|---|
| `id` | text | A short, unique, lower-case label with hyphens, for example `employment-kirklees`. The AI picks schemes by this ID, so don't change one casually. |
| `name` | text | The scheme's name as it appears on the card. |
| `organisation` | text | Who runs it, as it appears under the name. |
| `status` | text | The scheme's status in the pathways document's own words, for example "Live - open to referrals". |
| `open` | true / false | Whether the scheme is live. **This is the one that matters.** The Worker only ever recommends schemes where this is `true`, and cards for others say "Not open yet". |
| `audience` | list | Who the scheme is for: `individual`, `employer`, `organisation` or `student`. A scheme can have more than one. One that is only for a particular group (students, say) doesn't list `individual`. The AI only recommends a non-individual scheme when the person clearly is that kind of person. |

### Who it's for

| Field | Type | What it is |
|---|---|---|
| `whoFor` | text | A plain-English sentence describing who the scheme helps. |
| `age` | text | The age range, as free text (for example `18+`, `16-25`, `Adults`). |
| `eligibility` | list of text | The criteria someone needs to meet. |
| `exclusions` | list of text | Anyone the scheme can't help. Often empty. |
| `gate` | list of text | Things a person must already be, or already be using, to get in: for example being a Kirklees College student, or being in treatment with Change Grow Live. Empty means no gate. If someone clearly doesn't meet a gate, the AI leaves the scheme out. If it's unclear, the scheme can still be suggested as a "possible", with a note on what to check. |
| `healthFocus` | list of text | Which health needs the scheme is for. Empty means no health requirement. `any` means any health condition or disability. Otherwise one or more of `mental-health`, `severe-mental-illness`, `musculoskeletal-pain`, `substance-use`, `learning-disability-autism`, `unpaid-caring`. Specific ones are only matched when the person has said or clearly described the need. |
| `requiresMention` | list of text | Optional (only 3 schemes have it). Words or patterns the person's own messages must match before the scheme can appear, so condition-specific schemes are never suggested unprompted. The Worker joins the list into one case-insensitive regular expression and tests it against what the person typed. Because it's JSON, a word boundary is written `\\b`. |

### Contact

| Field | Type | What it is |
|---|---|---|
| `webpage` | text or `null` | The scheme's web page. |
| `email` | text or `null` | A contact email address. |
| `phone` | text or `null` | A contact phone number, sometimes with opening hours or a second number in the same text. |
| `social` | list of text | Social media links or handles. Usually empty. |

### Where

| Field | Type | What it is |
|---|---|---|
| `locations` | list of text | The venues, addresses and times where the scheme runs. |
| `areas` | list of text | The areas used for matching. At the moment: Batley, Colne Valley, Dewsbury, Huddersfield, Spen Valley, plus `Kirklees-wide` and `Online`. The finder works at town level only, not postcode. |

### How to get in

| Field | Type | What it is |
|---|---|---|
| `referralRoutes` | list of text | The ways someone can be referred, as free text. Some include a link. |
| `selfReferral.allowed` | text | `yes`, `partly` or `tbc`. Drives the badge on the card: "You can refer yourself", "Self-referral with a link from a professional" or "Self-referral: to be confirmed". |
| `selfReferral.note` | text | A short explanation of the self-referral position. |
| `selfReferral.url` | text | Optional (only 4 schemes have it). A direct link for self-referral. |

### What it does

| Field | Type | What it is |
|---|---|---|
| `activities` | list | What the scheme offers. Each item has a `name`, a `summary` and a `duration`, all text. |
| `workExperience` | text | Whether the scheme offers volunteering or work experience, as free text (for example `No`, `Yes - volunteering and placements`). |
| `notes` | text | Optional (only 4 schemes have it). Anything else worth knowing. |

### Keeping it fresh

| Field | Type | What it is |
|---|---|---|
| `lastUpdated` | date | When the scheme's entry was last checked, as `YYYY-MM-DD`. Shown on the card as "Information last checked". If it's more than 135 days old, the card carries a warning. |
| `reviewCycle` | text | How often the entry should be rechecked. At the moment it's `Quarterly` for every scheme. |

## Known quirks

These are worth knowing before you build anything that reads or filters the data.

- **Several fields are free text and can't be reliably filtered:** `age`, `status`, `workExperience` and `referralRoutes` are worded differently from scheme to scheme.
- **`status` and `open` overlap.** `open` is the one the code uses. Only HWL Community Grants is currently `false`.
- **Eight schemes are missing at least one of web page, email or phone.** The cards simply leave out what isn't there.
- **`areas` mixes towns with `Kirklees-wide` and `Online`** in the same list.
- **The `notes` line at the top of the file is the only other description of the structure.** This document is the fuller one, so update it when the fields change.
