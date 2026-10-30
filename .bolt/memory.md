# Project memory

## Product intent & audience

- Healthy Working Life Support Finder — prototype web app for people in Kirklees, West Yorkshire to find employment and health support services
- AI-powered matching: user describes a situation in natural language, app returns relevant local services
- Two audience paths: self-support vs. helping someone else (staff/partner)
- Prototype phase for testing only

## Brand personality & voice

- Public-service / civic tone: warm, accessible, trustworthy
- Clear plain-English instructions; emphasis on inclusivity and accessibility
- Emergency/safety context always present (footer)

## Visual design & UX direction

- Primary colour: teal `#0b6b6b` on warm cream background
- Header: mint-green bar with logo left, accessibility tools right
- Typography: DM Sans (headings), Noto Sans (body); Noto Nastaliq for Urdu RTL
- Components: prototype notice banner, example question chips, chat bubbles (user white, AI light-teal), service cards with fit badges, expandable eligibility/activities sections
- Accessibility: language switcher (English/Urdu), text-size controls (A/A+/A++), high-contrast toggle, keyboard focus styles, screen-reader support
- Footer: mint-green with emergency contacts (999, Kirklees mental health line, NHS 111)
- Responsive with mobile breakpoints

## Decisions, constraints & rationale

- Static site (plain HTML/CSS/JS in `site/` folder) — no build step
- Backend: Cloudflare Worker handles AI matching via Claude
- Privacy: messages route through Cloudflare to Claude AI and are not saved
- Service cards include: name, organisation, fit badges, why-matches note, contact details, Google Maps links, referral routes, expandable sections

## Open questions & assumptions

- Vite dev server not yet set up for live preview — proposed but user hasn't confirmed
- User hasn't indicated specific changes yet
- Deployment target/environment unconfirmed
- Whether the `site/` folder is the sole frontend codebase or if other assets exist