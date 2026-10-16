# Checks after the October 2026 import

137 services were added from the "Kirklees additional services" spreadsheet (v3). Contact details, names and descriptions were copied exactly. The other fields (areas, age, eligibility, gates, health focus, self-referral) were worked out from the spreadsheet's wording and then independently spot-checked. This is the list of things a person should check. Tick them off, or delete this file once they're done.

Each scheme's file is `data/services/<id>.json`, and its `provenance.source` gives the spreadsheet row.

## 1. Repeated rows that disagree

Rows 146–151 repeated earlier rows. The earlier row was kept in every case, because it has the fuller evidence and sources. Check which details are right:

- [ ] **Kirklees Wellness Service** (`kirklees-wellness-service`, rows 26 and 148). Phone 01484 234095 or 01484 234096? Age 16+ or 18+? Run by Kirklees Council alone, or with Locala? The later row has no email.
- [ ] **Carers Count** (`carers-count`, rows 44 and 150). The later row adds working-carer support (18+), which would overlap with the existing Supporting Working Carers scheme. Address: Empire House, Dewsbury (provider site) or Brian Jackson House (directory)?
- [ ] **CFO Evolution** (`cfo-evolution-huddersfield`, rows 68 and 147). The later row widens who it's for to anyone in the justice system, and has no phone or email.
- [ ] **West Yorkshire Suicide Bereavement Service** (`wy-suicide-bereavement`, rows 74 and 149). The later row says anyone in West Yorkshire, including employers, and has no contact details.
- [ ] **Access to Work** (row 151) combined the grant and both mental health support providers into one row. The three separate entries were kept instead: `access-to-work-grant`, `atw-mental-health-able-futures` and `atw-mental-health-maximus`.
- Adult and Community Learning (rows 2 and 146): identical, nothing to check.

## 2. May not be a service someone can be referred to

These are guidance pages, funding streams, websites or a recruitment scheme. Decide whether to keep each one (delete its file to remove it):

- [ ] Guidance: `hse-disabled-workers-guidance`, `fit-note-guidance`, `dwp-employee-health-disability`, `acas-managing-disability`
- [ ] `adult-skills-fund`: a funding stream delivered through providers, which may overlap with the Kirklees College and adult learning entries
- [ ] Websites or forms: `every-mind-matters`, `find-a-job-dwp`, `health-adjustment-passport`
- [ ] `veterans-guaranteed-interview`: recruitment for council jobs

## 3. May have closed, changed or be out of date

- [ ] `local-welfare-provision`: the Household Support Fund and Discretionary Housing Payments ended on 31 March 2026, so the wording should reflect the Crisis Resilience Fund.
- [ ] `citizens-advice-kirklees`: the AdviceLine may not be answered from 1 June, but the council page still lists 0808 278 7896.
- [ ] `national-careers-service`: moved in-house to DWP in October 2026. Check the name and phone.
- [ ] `mind-helplines`: the provider lists closures in 2026.
- [ ] `pers-employment-support`, `kirklees-in-recovery`, `better-in-kirklees`, `rural-veterans-hubs-kirklees`: little or no sign of activity in 2026.
- [ ] `kirklees-success-centre`, `project-search-supported-internship`: no confirmed next intake.
- [ ] `jobcentre-plus-work-coach`: the source page still mentions old programmes.
- [ ] `metrorover-jobseeker-permit`: the Weaver Network rebrand is coming, so the link may change.
- [ ] `ck-careers-adult-guidance`, `kirklees-employer-support`, `acas-managing-disability`: the latest evidence is from 2024–2025.

## 4. Contact details to confirm

- [ ] `nacro-criminal-record-support`: the phone number was cut off in the spreadsheet, so the card shows none.
- [ ] `op-nova`: MECC Link gives a different phone and email from the provider page.
- [ ] `op-courage-veterans`: the email is a CNTW address, but the service is listed under Leeds and York PFT.
- [ ] `together-against-pain`: the contact is a personal email address.
- [ ] `snackos-training-cafe`: the only contact is Facebook.
- [ ] `carers-count`: two different addresses (see section 1).

## 5. Based outside Kirklees, or reach unclear

Where phone or online support is offered, these are matched as `Kirklees-wide`. Check that Kirklees residents can really use them:

- [ ] `calderdale-credit-union` and `age-uk-information-advice`: offices in Halifax
- [ ] `northern-college`: Barnsley campus, with some online courses
- [ ] `smart-works-yorkshire`: Leeds only, or online appointments
- [ ] `get-started-kings-trust-fire`: the next course is in Leeds, with no remote option
- [ ] `wea-adult-learning`: "West Yorkshire" venues
- [ ] `op-restore`: run by a London NHS trust; where appointments happen isn't stated
- [ ] `timpson-interview-dry-cleaning`: no Kirklees shops named
- [ ] `cap-money-coaching`: run in local churches, but no confirmed course in Kirklees
- [ ] `andys-man-club-huddersfield`: only Ainley Top is on the official list
- [ ] `cap-huddersfield-debt-centre`: HD postcodes only, so not for WF residents. Matched to Huddersfield, Colne Valley, Holme Valley and Kirkburton.

## 6. Judgement calls worth a second look

- [ ] Possible overlap with existing schemes: `employment-skills-service-kirklees` and `wyca-finding-a-job` with Employment Kirklees and Kirklees Employment Service.
- [ ] `changes-inspire-north`: the spreadsheet says both "offended in the last 12 months" and "offended or at risk of offending". The gate allows either.
- [ ] `families-together`: mainly a children and families service, so it may not suit working-age adults.
- [ ] `here-for-you-touchstone`: sources disagree on age (16+ or 18+) and opening hours.
- [ ] `steps-ahead-mentoring`: the 18–30 age limit may apply only to jobseekers.
- [ ] `macmillan-at-work`, `macmillan-help-with-work` and `alzheimers-dementia-support-line` use health focus `any`, as there's no cancer or dementia value.
- [ ] `northern-gambling-service`, `national-gambling-helpline` and `gamstop` are only shown when the person mentions gambling, like the substance use services.
- [ ] Self-referral may be wrong for: `better-in-kirklees` and `kirklees-hips` (marked "to be confirmed"), `howarth-foundation`, `cfo-evolution-huddersfield`, `smart-works-yorkshire` and `social-prescribing-kirklees` (marked "partly"), and `connect-housing-young-people` (marked "yes", but may need a referral).

## 7. Translation

- [ ] The new card wording (regional/national service, needs a referral, cost, languages and formats) and the new trigger words for convictions, bereavement and gambling have first-draft Polish and Urdu. Add them to the translator's list.

## 8. Services added for the MVP team to review (16 October 2026)

47 more services were added with `"listing": {"decision": "review"}`, so they are **not** on the live finder until the team decides. Work through them on the All services page (filter "Live list: Waiting for review"), choosing include, further review or exclude for each.

- [ ] The 40 from the spreadsheet's "Not verified or closed" tab. Each file's `notes` says why it wasn't confirmed. Before including one, check it's running and fill in everything that says "To be completed" with "Edit details" on the same page (the check won't let it go live otherwise). Its categories, level, areas and health focus were guessed from the name, so check those too.
- [ ] 5 of them were found closed: HOPELINE247 (Papyrus), the West Yorkshire Staff Mental Health and Wellbeing Hub, the Working Families helpline, WorkWell (not a West Yorkshire pilot) and Works Better. The research advised not listing them; they're there so the team can confirm and exclude them.
- [ ] Two overlap with services already live: Connect to Work (delivered in Kirklees through REAL Employment) and the Employment West Yorkshire page (delivered as Employment Kirklees).
- [ ] The 3 crisis lines (Samaritans, CALM, Shout). If included, the AI could suggest them as cards. The crisis panel already shows urgent contacts, and gives no cards when someone mentions suicide or self-harm, so think about whether they add anything outside a crisis.
- [ ] The 4 directories (Kirklees Welcomes, MECC Link, the District Provision Tool, Hub of Hope). They list other services rather than offering support themselves. MECC Link and the District Provision Tool are written for practitioners.
