# Table Planner: what you still need to do

About 30 minutes for Part A (required) on a Mac or PC, plus 5–10 minutes for
each extra in Part B. Everything is free except the Anthropic API (pennies per
restaurant looked up) and, optionally, Google Places.

Commands go in **Terminal** (Mac: Spotlight → "Terminal"; Windows: "PowerShell").
Paste one block at a time.

---

## Part A — Put the app online (required)

### A1. Install the tools (once)
1. Install **Node.js LTS** from <https://nodejs.org> (the big green button). Accept the defaults.
2. Install **Git** if you don't have it: Mac users get it the first time they type `git` (accept the prompt); Windows users get it from <https://git-scm.com/download/win>.
3. Create a free **Cloudflare** account: <https://dash.cloudflare.com/sign-up>.

### A2. Download the app
```bash
git clone https://github.com/sk8905/reservations.git
```
```bash
cd reservations
```
```bash
npm install
```

### A3. Connect to Cloudflare
```bash
npx wrangler login
```
A browser window opens: click **Allow**.

### A4. Create the app's storage
```bash
npx wrangler kv namespace create PLANNER
```
It prints a line like `"id": "3f2a…"`. Open `wrangler.jsonc` in any text editor,
replace `REPLACE_WITH_KV_NAMESPACE_ID` with that id (keep the quotes), and save.

### A5. Choose your access token
This is the app's password. Make a long random one:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```
Save it in your password manager, then store it in the app (paste it when asked):
```bash
npx wrangler secret put APP_TOKEN
```
If it asks to create the Worker first, answer **yes**.

### A6. Add your Anthropic API key (for researching restaurants)
1. Go to <https://platform.claude.com/> → sign in → **Billing**: add a card and a small credit (e.g. £5).
2. **API keys** → **Create key** → copy it.
3. Store it:
```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

### A7. Publish
```bash
npm run deploy
```
It prints your address, like `https://table-planner.yourname.workers.dev`. Save it.

### A8. Put it on your iPhone
1. Open the address in **Safari** on your iPhone.
2. Enter your access token (from A5) → **Save**.
3. Tap **Share** → **Add to Home Screen** → **Add**.
4. Test: **Find** → type `Bouchon Racine` → **Look up**. The first lookup takes 20–60 seconds.

---

## Part B — Extras (recommended)

Each secret takes effect as soon as you've added it. There's no need to redeploy.

### B1. iPhone push alerts (ntfy, free)
1. Install **ntfy** from the App Store: <https://apps.apple.com/app/ntfy/id1625396347>.
2. In ntfy, tap **+** and subscribe to a hard-to-guess topic name, e.g. `tables-` followed by random letters. Anyone who knows the name can read it.
3. Store the same topic name:
```bash
npx wrangler secret put NTFY_TOPIC
```
4. In the app: **Alerts** → **Send a test alert**. You should get a push.

### B2. "Only dates I'm free" (Google Calendar)
1. On a computer, open <https://calendar.google.com> → ⚙ **Settings**.
2. On the left, click your calendar's name → **Integrate calendar**.
3. Copy **Secret address in iCal format**. Treat it like a password ([Google help](https://support.google.com/calendar/answer/37648)).
4. Store it:
```bash
npx wrangler secret put CALENDAR_ICS_URL
```

### B3. Inbox alerts (OpenTable / Resy "Notify me" → ⚡ on your dates)
1. In the app: **Alerts** → **Inbox alerts** → **Copy script**. Your address and token are filled in.
2. Open <https://script.google.com/home/projects/create> while signed in to the Gmail account that receives your OpenTable emails.
3. Select everything in the editor, paste, and press **⌘S / Ctrl+S** to save. Name the project "Table Planner".
4. In the toolbar's function menu choose **setup** → **Run**.
5. Google asks for permission. Because this is your own script, it says "Google hasn't verified this app": click **Advanced** → **Go to Table Planner (unsafe)** → **Allow**. The script only reads emails from booking platforms and sends them to your own app.
6. On OpenTable (or Resy), tap **Notify me** on the dates you want. When their "table available" email arrives, you'll get a ⚡ on that date within 5 minutes, plus a push if you're free.
7. **Please check the first real alert:** paste it into **Alerts → Test with a pasted email** and see what the app reads. If anything is wrong or missing, forward that email (or paste its text) to me so I can tune the reader. I built it without a real OpenTable alert email to test on.

To stop it later, open the script and run **stop**.

### B4. Google Maps details (optional, may cost money)
Adds search suggestions, full opening hours and the "Takes bookings online" flag.
1. <https://console.cloud.google.com> → create a project.
2. Turn on billing (a card is required; there's a monthly free allowance — [pricing](https://developers.google.com/maps/billing-and-pricing/pricing)).
3. **APIs & Services → Library** → enable **Places API (New)**.
4. **APIs & Services → Credentials → Create credentials → API key**. Edit the key → **Restrict key** → Places API (New) only.
5. Store it:
```bash
npx wrangler secret put GOOGLE_PLACES_API_KEY
```

### B5. Lock the app down further (optional)
Put it behind Cloudflare Access so only your Google login can open it:
<https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/>.

### B6. Tidy the GitHub repo (optional)
On <https://github.com/sk8905/reservations/settings>, set **Default branch** to `main`.

---

## Updating the app later
When new changes are pushed to `main`:
```bash
git pull
```
```bash
npm install
```
```bash
npm run deploy
```
Your `wrangler.jsonc` edit (A4) stays, because `git pull` keeps local changes. If it reports a conflict, keep your id line.

## If something goes wrong
| Problem | Fix |
|---|---|
| App keeps asking for the token | Re-enter exactly the APP_TOKEN from A5 |
| "Research needs the ANTHROPIC_API_KEY secret" | Do A6, and check you have API credit |
| No test push | Topic in ntfy must match NTFY_TOPIC exactly |
| Inbox alerts not arriving | In script.google.com → **Executions**, check for errors; run **setup** again |
| A restaurant's rule looks wrong | Open it → **Correct it** |
