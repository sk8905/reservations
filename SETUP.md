# Table Planner: what you still need to do

Everything happens in a web browser, using just your **GitHub** and **Cloudflare**
accounts (plus Google and Anthropic for some extras). Nothing to install.
Part A takes about 15 minutes; each extra in Part B takes 5–10.

Cloudflare builds and publishes the app straight from GitHub. After Part A,
**every change pushed to `main` goes live automatically** within about a minute.

---

## Part A — Put the app online (required)

### A1. Connect Cloudflare to GitHub and create the app
1. Sign in (or sign up free) at <https://dash.cloudflare.com>.
2. In the left menu: **Compute (Workers)** → **Workers & Pages** → **Create** (blue button).
3. Choose **Import a repository** (sometimes shown as **Continue with GitHub**).
4. If asked, click **Connect GitHub**, sign in, and allow access to **sk8905/reservations** (choosing "Only select repositories" is fine).
5. Pick **reservations** from the list.
6. On the settings page:
   | Field | Set it to |
   |---|---|
   | Project / Worker name | **`table-planner`** (must be exactly this, or the build fails) |
   | Production branch | `main` |
   | Build command | leave empty |
   | Deploy command | leave as `npx wrangler deploy` |
   | Root directory | leave empty (`/`) |
7. Click **Create and deploy** (or **Deploy**). Wait for the build to finish (about 1–2 minutes). It shows a green tick.
8. Note your app's address, shown on the Worker's page, e.g. `https://table-planner.yourname.workers.dev`.

The first deploy also creates the app's storage automatically. You don't need to do anything for it.

### A2. Choose your access token
This is the app's password. Make a long random one with your password manager:
- **iPhone / Mac Passwords app**: **+** → New Password → copy the suggested strong password, or
- 1Password / Bitwarden / similar: generate 30+ characters.

Save it there as "Table Planner token".

### A3. Add your secrets in Cloudflare
1. In Cloudflare: **Workers & Pages** → **table-planner** → **Settings** → **Variables and Secrets** → **+ Add**.
2. **Type: Secret**, **Variable name: `APP_TOKEN`**, **Value:** your token from A2 → **Deploy** (or **Save**).

> Always choose **Type: Secret**, not "Text", for everything in this guide. Secrets survive future automatic deploys.

### A4. Add your Anthropic API key (for researching restaurants)
1. Go to <https://platform.claude.com/> → sign in → **Billing**: add a card and a small credit (e.g. £5).
2. **API keys** → **Create key** → copy it.
3. Back in Cloudflare (same screen as A3): **+ Add** → Type **Secret**, name **`ANTHROPIC_API_KEY`**, paste the key → **Deploy**.

### A5. Put it on your iPhone
1. Open your app's address (A1 step 8) in **Safari** on your iPhone.
2. Enter your access token → **Save**.
3. Tap **Share** → **Add to Home Screen** → **Add**.
4. Test: **Find** → type `Bouchon Racine` → **Look up**. The first lookup takes 20–60 seconds.

---

## Part B — Extras (recommended)

Each one is a new **Secret** added in **table-planner → Settings → Variables and
Secrets → + Add** (the same screen as A3). It takes effect once you click Deploy/Save.

### B1. iPhone push alerts (ntfy, free)
1. Install **ntfy** from the App Store: <https://apps.apple.com/app/ntfy/id1625396347>.
2. In ntfy, tap **+** and subscribe to a hard-to-guess topic name, e.g. `tables-` plus random letters. Anyone who knows the name can read it.
3. Add a Secret named **`NTFY_TOPIC`** with that same topic name.
4. In the app: **Alerts** → **Send a test alert**. You should get a push.

### B2. "Only dates I'm free" (Google Calendar)
1. On a computer, open <https://calendar.google.com> → ⚙ **Settings**.
2. On the left, click your calendar's name → **Integrate calendar**.
3. Copy **Secret address in iCal format**. Treat it like a password ([Google help](https://support.google.com/calendar/answer/37648)).
4. Add a Secret named **`CALENDAR_ICS_URL`** with that address.

### B3. Inbox alerts (OpenTable / Resy "Notify me" → ⚡ on your dates)
1. In the app: **Alerts** → **Inbox alerts** → **Copy script**. Your address and token are filled in.
2. Open <https://script.google.com/home/projects/create>, signed in to the Gmail account that receives your OpenTable emails.
3. Select everything in the editor, paste, and save (⌘S / Ctrl+S). Name the project "Table Planner".
4. In the toolbar's function menu choose **setup** → **Run**.
5. Google asks for permission. Because this is your own script, it says "Google hasn't verified this app": click **Advanced** → **Go to Table Planner (unsafe)** → **Allow**. The script only reads emails from booking platforms and sends them to your own app.
6. On OpenTable (or Resy), tap **Notify me** on the dates you want. When their "table available" email arrives, you'll get a ⚡ on that date within 5 minutes, plus a push if you're free.
7. **Please check the first real alert:** paste it into **Alerts → Test with a pasted email** and see what the app reads. If anything is wrong or missing, send me that email's text so I can tune the reader. I built it without a real OpenTable alert to test on.

To stop it later, open the script and run **stop**.

### B4. Google Maps details (optional, may cost money)
Adds search suggestions, full opening hours and the "Takes bookings online" flag.
1. <https://console.cloud.google.com> → create a project.
2. Turn on billing (a card is required; there's a monthly free allowance — [pricing](https://developers.google.com/maps/billing-and-pricing/pricing)).
3. **APIs & Services → Library** → enable **Places API (New)**.
4. **APIs & Services → Credentials → Create credentials → API key**. Edit the key → **Restrict key** → Places API (New) only.
5. Add a Secret named **`GOOGLE_PLACES_API_KEY`** with that key.

### B5. Lock the app down further (optional)
In Cloudflare, put it behind **Access** so only your Google login can open it:
<https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/>.

### B6. Tidy GitHub (optional)
- On <https://github.com/sk8905/reservations/settings>, set **Default branch** to `main`.
- To stop Cloudflare building preview copies of other branches: **table-planner → Settings → Build → Branch control** → untick **Enable non-production branch builds**.

---

## Updating the app later
Nothing to do: when changes are pushed to `main`, Cloudflare rebuilds and publishes
automatically. Your secrets and saved restaurants are kept. To watch a build:
**table-planner → Deployments**.

## If something goes wrong
| Problem | Fix |
|---|---|
| Build failed: name mismatch | Worker must be named exactly `table-planner` (A1) |
| App says "Set the APP_TOKEN secret" | Do A3 (Type: **Secret**), then reload |
| App keeps asking for the token | Re-enter exactly the token from A2 |
| "Research needs the ANTHROPIC_API_KEY secret" | Do A4, and check you have API credit |
| No test push | Topic in ntfy must match `NTFY_TOPIC` exactly |
| Inbox alerts not arriving | In script.google.com → **Executions**, check for errors; run **setup** again |
| A restaurant's rule looks wrong | Open it → **Correct it** |

Cloudflare's guide to GitHub builds: <https://developers.cloudflare.com/workers/ci-cd/builds/>.
