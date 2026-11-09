# Table Planner

A small personal web app (iPhone-first) for planning restaurant bookings
**without scraping booking sites**. Pick a restaurant, meals (breakfast /
lunch / dinner), days (midweek / weekend / any), party size and a range, and
it lists every candidate date with:

- **Bookable now**, **Opens <date> 00:00**, or **Release unknown**
- a one-tap link to the booking page, with the date, time and party size filled in
- a **map pin** that opens the restaurant on Google Maps, where "Reserve a table"
  can show Google's own slot picker (often covering several booking platforms)
- whether you're **busy** that evening (from your calendar feed)
- a **"Takes bookings online" / "No online booking"** flag from Google Places

It also sends an **alert just after each new date opens** (push, email or webhook),
and turns OpenTable / Resy **"Notify me" emails** in your Gmail into ⚡ alerts on
the right date, with a push if you're free.

**New here? Follow [SETUP.md](SETUP.md) step by step.**

When you add a restaurant, the app **researches its booking rules automatically**
(booking window, release time, platform, opening hours, phone line) using
Mistral with web search. Every fact links to its source and gets a confidence
badge. A fact that no found page supports is never guessed: it is shown as
*estimated* or *unknown*.

## What it never does

- Never loads, books, holds or cancels anything on OpenTable, Resy, SevenRooms,
  Tock or DesignMyNight, and never signs in to them.
- Live free times are seen by **you**, when you tap through to the booking page.

Why: OpenTable's [robots.txt](https://www.opentable.co.uk/robots.txt) blocks all
automated agents (`User-agent: * / Disallow: /`) and names its availability
endpoints specifically, and its [Terms of Use](https://www.opentable.co.uk/c/legal/terms-and-conditions/)
restrict robots and scrapers. Check each platform's terms before adding
anything that reads availability directly.

## How it works

| Part | File |
|---|---|
| Planner logic: meal windows, day filters, release dates (GMT/BST-safe), slot list | `public/shared/plan.js`, `tz.js` |
| Booking links per platform (OpenTable verified; Resy/SevenRooms/Tock/DesignMyNight unverified) | `public/shared/links.js` |
| Calendar feed reader (recurring events, exceptions, free/busy) | `public/shared/ics.js` |
| CSV export | `public/shared/csv.js` |
| Restaurant research (Mistral web search by default; Claude optional) and source validation | `src/research-mistral.js`, `src/research.js`, `src/profile.js` |
| Google Places search, opening hours and the online-booking flag (optional; matched automatically by name) | `src/places.js` |
| Alert channels (ntfy push, Resend email, webhook) | `src/channels.js` |
| Inbox alerts: reads forwarded "table available" emails | `src/inbox.js`, `public/gmail-forwarder.gs` |
| API, storage (Cloudflare KV), hourly alert job | `src/worker.js` |
| iPhone web app (4 screens) | `public/index.html`, `app.js`, `styles.css` |

Release rules supported: **rolling** (N days ahead at a set time, e.g. 30 days
at midnight) and **monthly** (e.g. the whole of March opens on 1 January).
Research results are cached for 30 days and re-checked on demand. If you know
better, tap **Correct it**: your correction wins and survives re-checks.

## Setup

**Browser only: follow [SETUP.md](SETUP.md).** Cloudflare imports this GitHub
repo, builds it and publishes it, and redeploys on every push to `main`. The
Worker must be named `table-planner`. The KV storage is created automatically
on the first deploy, so no id is needed.

Secrets are added in Cloudflare under **table-planner → Settings → Variables
and Secrets** (always Type: **Secret**):

| Secret | Needed for | Where to get it |
|---|---|---|
| `APP_TOKEN` | **Required.** Any long random string; you type it into the app once | Your password manager's generator (30+ characters) |
| `MISTRAL_API_KEY` | Researching new restaurants | [Mistral console](https://console.mistral.ai) |
| `MISTRAL_MODEL` | Optional: override the model (default `mistral-medium-latest`) | [Mistral models](https://docs.mistral.ai/getting-started/models/) |
| `ANTHROPIC_API_KEY` | Optional alternative to Mistral; used only if `MISTRAL_API_KEY` isn't set | [Claude Console](https://platform.claude.com/) |
| `GOOGLE_PLACES_API_KEY` | Optional: search suggestions + full opening hours | [Places API (New)](https://developers.google.com/maps/documentation/places/web-service/text-search) |
| `CALENDAR_ICS_URL` | Optional: "only dates I'm free" | Google Calendar → Settings → your calendar → **Secret address in iCal format** ([help](https://support.google.com/calendar/answer/37648)) |
| `NTFY_TOPIC` | Optional: iPhone push | Install [ntfy](https://ntfy.sh) and subscribe to a hard-to-guess topic name |
| `RESEND_API_KEY`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM` | Optional: email alerts | [Resend](https://resend.com) |
| `ALERT_WEBHOOK_URL` | Optional: POSTs `{title, body, url}` | Your own endpoint |

For an extra lock, put the app behind
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/).

Developers can also deploy from a terminal: `npm install`, then `npx wrangler deploy`
and `npx wrangler secret put <NAME>`.

## Run locally (developers)

```bash
cp .dev.vars.example .dev.vars
```

Set at least `APP_TOKEN` in `.dev.vars`, then:

```bash
npm run seed:local
```

```bash
npm run dev
```

`seed:local` loads Bouchon Racine's researched profile (from
`tests/fixtures/research-response.json`) so you can try the app without an
research key. Open <http://127.0.0.1:8787>.

## Tests

```bash
npm test
```

39 tests use saved fixtures only (no live sites): time zones across the clocks
change, release maths, meal/day filtering, booking links, the calendar reader
(recurring events, exceptions, moved and cancelled events), research
validation (a made-up source is rejected), the API, and release alerts
(fire once, skip busy dates).

## Costs

- **Cloudflare Workers + KV**: the free plan covers personal use.
- **Mistral**: one research call per new restaurant (it searches the web a few
  times), plus re-checks you trigger. Model `mistral-medium-latest` with the
  built-in `web_search` tool. See [pricing](https://mistral.ai/pricing).
- **Google Places**: optional; billed per request after a monthly free allowance
  ([pricing](https://developers.google.com/maps/billing-and-pricing/pricing)).

## Limits and next steps

- Google Maps can't be read automatically: its availability comes from booking
  platforms' partner feeds, the public Places API only says whether a place takes
  reservations, and Google's terms forbid scraping. The map pin just opens the page
  for you, and Google links can't pre-set a date.

- The app can't see *live* free times itself. Inbox alerts pass on the
  platforms' own **Notify me** emails. The email reader is template-free and was
  built without real alert emails to test on: check your first one with
  **Alerts → Test with a pasted email**.
- If a restaurant doesn't publish its release time, 00:00 UK is assumed and
  marked *estimated*.
- Booking-link parameters for Resy, SevenRooms, Tock and DesignMyNight are
  unverified: the link opens the right restaurant, but you may need to set the
  date and party size by hand.
- Alerts run hourly at :01 past the hour, so they arrive within about a minute
  of a midnight release.
