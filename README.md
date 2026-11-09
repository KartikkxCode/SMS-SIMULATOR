# SMS Simulator

A small web app that sends **one message to every contact in a CSV or Excel file**, by **SMS** (through
[MSG91](https://msg91.com)) or by **WhatsApp** (through Meta's WhatsApp Cloud API or MSG91). It runs on your own
computer (Windows, macOS or Linux) and opens in the browser.

- Upload a `.csv` or `.xlsx` file and pick the phone-number column.
- See which numbers are valid, which are wrong and which are duplicates before anything is sent.
- **SMS:** enter your DLT-approved MSG91 template and preview it with SMS-part and credit estimates.
- **WhatsApp:** pick an approved template, fill each `{{1}}` from a column (e.g. Name) or a fixed text, add a header
  image or PDF, and preview the exact message for each contact.
- **Simulate mode:** a dry run that shows exactly what would be sent. Nothing is sent and nothing is charged.
- **Live mode:** sends for real, retries temporary errors, stops on serious ones, and lets you stop part-way.
- Download a CSV report of every number and what happened to it.

Use the **SMS | WhatsApp** switch at the top right to move between the two. Each keeps its own progress.

## Requirements

- [Node.js](https://nodejs.org) **20.19 or newer** (the current LTS, 22 or later, is recommended). Nothing else is needed.
- For Live mode only: an MSG91 account (SMS, and optionally WhatsApp) and/or a Meta WhatsApp Business account.
  Simulate mode works without any account.

## Quick start

The commands are the same on Windows (PowerShell or Command Prompt), macOS and Linux.

```bash
git clone https://github.com/KartikkxCode/SMS-SIMULATOR.git
cd SMS-SIMULATOR
npm install
npm run build
npm start
```

Then open **http://localhost:3000**.

To turn on Live mode, copy `.env.example` to `.env`, add your keys and restart (`Ctrl+C`, then `npm start`):

| OS | Copy command |
| --- | --- |
| Windows | `copy .env.example .env` |
| macOS / Linux | `cp .env.example .env` |

Then open `.env` in any text editor and fill in the keys you have. Settings are explained in [Settings](#settings).

---

## SMS

### Setting up MSG91 (India / DLT)

Indian telecom rules (TRAI DLT) only allow SMS that match a **pre-approved template** sent from a **registered sender ID**.
MSG91 can't send free text, so you set this up once:

1. **DLT registration.** Register your business as a *Principal Entity* on a DLT portal (Jio, Airtel, Vodafone Idea, BSNL…).
   Register a **header** (sender ID, 6 letters, e.g. `ABCSTR`) and a **content template**, for example
   `Dear customer, our {#var#} sale starts today. Visit us! - ABC Store`. Wait for approval.
2. **MSG91 sender ID.** In MSG91, add the same sender ID together with your DLT Entity ID.
3. **MSG91 template.** Create an SMS template in MSG91 with the DLT template ID and the same text. MSG91 writes
   variables as `##var1##` instead of `{#var#}`. Copy the **template ID** MSG91 gives you.
4. **Auth key.** Copy your **Authkey** from the MSG91 dashboard into `.env` as `MSG91_AUTH_KEY`.
   You can also put the template ID in `MSG91_TEMPLATE_ID` so the app fills it in for you.

(The menu names in the MSG91 dashboard may differ slightly from the ones above.)

### Sending SMS

1. **Add contacts.** Either **Upload a file** (the first row must hold column names; up to 5 MB and 50,000 rows) or
   **Type numbers**: enter names and mobile numbers in the list, or paste many at once (one per line, like
   `Asha, 98765 43210`, or two columns copied from Excel). Up to 1,000 typed contacts.
2. **Check contacts.** Choose the phone column (it's usually picked for you). Numbers can contain spaces, dashes, a
   leading `0`, `+91` or `91`; they're converted to the international format (`919876543210`). Invalid and duplicate
   rows are listed and can be downloaded. Each number gets the message once.
3. **Write message.** Paste the template ID and the template text exactly as approved, then fill in the variable values.
   The text is used for the preview and the length count. MSG91 sends the approved template.
4. **Send.**
   - Use **Simulate** first to check everything.
   - Switch to **Live** and send a **test SMS to your own number**.
   - Then press **Send N SMS** and confirm.

### How SMS sending works

- Numbers are sent in batches of `BATCH_SIZE` (100) per request to MSG91's Flow API
  (`POST https://control.msg91.com/api/v5/flow`), with a short pause between batches.
- Network errors, HTTP 5xx and HTTP 429 are retried up to 3 times (after 1, 2 and 4 seconds). Other errors are not retried.
- If MSG91 rejects the **first** batch (wrong auth key, unknown template, no balance), sending stops, because every
  other batch would be rejected the same way.
- **Stop sending** finishes the batch in progress and skips the rest.
- "Submitted" means MSG91 accepted the numbers. Whether each SMS reached the phone is shown in the MSG91 dashboard's
  delivery reports.

---

## WhatsApp

WhatsApp is stricter than SMS. A business can only **start** a conversation with a **message template that Meta has
approved**, only with people who **agreed** to get messages, and only up to a **limit of new contacts per 24 hours**.
The app is built around these rules so your number stays in good standing.

### Option A: Meta WhatsApp Cloud API (direct from Meta)

1. Go to [developers.facebook.com](https://developers.facebook.com), create an app of type **Business**, and add the
   **WhatsApp** product. Meta gives you a free **test number** and the approved `hello_world` template right away.
2. In **WhatsApp → API Setup**, note the **Phone number ID** and the **WhatsApp Business Account ID** (WABA ID).
   While testing, add your own WhatsApp number as an allowed recipient there.
3. Create a **permanent token**: in Meta Business Settings, go to **System users**, add one with the **Admin** role,
   assign it your app and WhatsApp account, and generate a token with the `whatsapp_business_messaging` and
   `whatsapp_business_management` permissions. (The 24-hour token on the API Setup page works for a first try.)
4. Put them in `.env`:
   ```ini
   WHATSAPP_META_TOKEN=EAAG...
   WHATSAPP_META_PHONE_NUMBER_ID=123456789012345
   WHATSAPP_META_WABA_ID=987654321098765
   ```
5. Create your own templates in **WhatsApp Manager → Message templates** and wait for approval. Once approved they
   appear in the app automatically (press **Refresh** if you just created one).
6. Before sending to customers, add and verify your business phone number and complete business verification in Meta
   Business Settings, which raises your sending limit.

Meta's API version is set by `WHATSAPP_META_API_VERSION` (default `v26.0`). If Meta retires it, set the newest version
listed in Meta's changelog.

### Option B: MSG91 WhatsApp

1. In your MSG91 account, open **WhatsApp** and connect (integrate) your WhatsApp Business number.
2. Create templates there and wait for Meta's approval.
3. Put the same `MSG91_AUTH_KEY` you use for SMS plus your integrated number in `.env`:
   ```ini
   MSG91_AUTH_KEY=...
   MSG91_WHATSAPP_NUMBER=919000000001
   ```
4. MSG91 needs header images and PDFs as a **public `https://` link** (for example from your website or a CDN). In
   the app, paste the link instead of uploading the file.

If the template list doesn't load for your MSG91 account, use **Template not listed? Type it in by hand** and copy
the name, language and text exactly from MSG91. The MSG91 request format lives in one file
(`server/src/whatsapp/providers/msg91.ts`, with `payload.ts`) in case your account expects different field names.

### Sending WhatsApp messages

1. **Add contacts** (upload a file or type numbers) and **Check contacts**: the same as for SMS. Typed names can fill
   `{{1}}`.
2. **Template.** Choose **Meta Cloud API** or **MSG91 WhatsApp**, then pick an approved template. Templates the app
   can't send (video or location headers, carousels, one-time-password templates, not yet approved) are greyed out with
   the reason. Without keys you see **demo templates** to try Simulate mode.
3. **Personalize.** For each variable, choose a **column** (e.g. `{{1}}` → Name, so everyone gets their own name) or
   **the same text for everyone**. Add the header image or PDF if the template has one. The app checks every contact
   right away and shows:
   - how many will get the message, and who is skipped and why (empty value, opted out, already got this template in
     the last 24 hours, over your daily limit);
   - a WhatsApp-style preview you can step through contact by contact.
4. **Send.**
   - Run **Simulate** first. It applies exactly the same checks as a live send.
   - Switch to **Live**, tick the box confirming your contacts agreed to get WhatsApp messages, and send a **test** to
     your own number.
   - Press **Send N WhatsApp messages** and confirm.
   - When it finishes, **Send to the rest** retries anyone who wasn't reached, was over the daily limit, or failed for
     a reason that may pass.

### Rules that keep your number safe

- **Opt-in.** Only message people who agreed to hear from you on WhatsApp. People blocking or reporting you lowers your
  number's **quality rating** (shown in the app for Meta) and can get it restricted.
- **Daily limit.** New numbers can start conversations with about **250 unique people per 24 hours**. The limit grows
  (2,000, 10,000, 100,000, unlimited) as you send good-quality messages. With Meta keys the app reads your current
  limit; otherwise set `WHATSAPP_DAILY_LIMIT`. Contacts over the limit are skipped and can be sent later with
  **Send to the rest**.
- **No repeats.** By default anyone who got the same template in the last 24 hours is skipped.
- **Opt-outs.** Numbers in `data/whatsapp-optouts.txt` (one per line) are never messaged. With delivery receipts on,
  people who reply **STOP** are added automatically.
- **Marketing to the US.** Meta doesn't deliver marketing templates to US (+1) numbers; the app warns you.
- **Cost.** Meta charges per delivered message (marketing messages in India cost about ₹0.86). Set
  `WHATSAPP_PRICE_PER_MESSAGE` to see an estimate before sending.

### How WhatsApp sending works

- **Meta:** one request per contact, at up to `WHATSAPP_RATE_PER_SEC` (default 20; Meta allows about 80). **MSG91:**
  bulk requests of `WHATSAPP_MSG91_CHUNK` contacts (default 100), one per second.
- **Temporary errors** (WhatsApp busy, speed limit hit) are retried after 2, 5 and 15 seconds, and the app halves its
  speed for a minute when WhatsApp asks it to slow down. "Too many messages to this person" waits 10 seconds.
- **Serious errors stop the campaign at once:** invalid token, template paused or missing, account restricted, spam
  limit, payment problem. Sending also stops if the first 5 messages fail the same way, or after 20 failures in a row.
- **No duplicates.** If WhatsApp doesn't answer (connection dropped, timeout), the message may or may not have gone
  out, so it's marked **unknown** and never retried automatically. Every live message is written to
  `data/whatsapp-sent.jsonl` (and saved to disk) **before** it is sent, and its outcome after. So even if the app or
  the computer crashes mid-send, a re-run skips everyone who was, or may have been, messaged.
- **Marketing templates** are moving to Meta's Marketing Messages API. If Meta answers error 131063, the app switches
  marketing templates to the new endpoint by itself (`WHATSAPP_MARKETING_ENDPOINT`).
- "Accepted" means WhatsApp took the message. Whether it was delivered and read is shown in WhatsApp Manager, or in the
  app if you turn on delivery receipts.
- **Ctrl+C** while sending lets messages already on their way finish and saves the report before the app closes.

### Delivery receipts (optional, Meta)

WhatsApp reports delivered, read and failed through a webhook, which needs a public address. A free Cloudflare quick
tunnel ([`cloudflared`](https://github.com/cloudflare/cloudflared)) gives your computer one without opening any ports:

1. Install `cloudflared`, then run `cloudflared tunnel --url http://localhost:3000`. It prints an address like
   `https://random-words.trycloudflare.com`.
2. In `.env` set:
   ```ini
   WHATSAPP_WEBHOOK_VERIFY_TOKEN=any-long-random-text
   WHATSAPP_META_APP_SECRET=your app secret (App settings → Basic)
   PUBLIC_WEBHOOK_HOST=random-words.trycloudflare.com
   ```
   and restart the app.
3. In your Meta app, open **WhatsApp → Configuration → Webhook**, set the callback URL to
   `https://random-words.trycloudflare.com/webhooks/whatsapp` and the verify token to the same text, then subscribe to
   the **messages** field.

If no receipts arrive, your WhatsApp account may not be subscribed to the app yet: send
`POST https://graph.facebook.com/v26.0/{WABA_ID}/subscribed_apps` with your token (Graph API Explorer works).

Every receipt must carry Meta's signature, which the app checks with the app secret. The tunnel address can reach
`/webhooks/whatsapp` only, never the rest of the app. The quick-tunnel address changes each time `cloudflared`
restarts, so update the callback URL and `PUBLIC_WEBHOOK_HOST` when it does.

---

## Settings

All settings go in `.env` (copy it from `.env.example`). Restart the app after changing them.

### General and SMS

| Setting | Default | What it does |
| --- | --- | --- |
| `MSG91_AUTH_KEY` | *(empty)* | Your MSG91 auth key (SMS, and WhatsApp through MSG91). Leave empty for Simulate-only. |
| `MSG91_TEMPLATE_ID` | *(empty)* | SMS template ID pre-filled in the app. |
| `DEFAULT_COUNTRY_CODE` | `91` | Added to numbers written without a country code. |
| `BATCH_SIZE` | `100` | Numbers per MSG91 SMS request (1–1000). |
| `BATCH_DELAY_MS` | `500` | Pause between SMS requests, in milliseconds. |
| `PORT` | `3000` | Port the app listens on. |
| `HOST` | `127.0.0.1` | Keep this so only your computer can reach the app. |
| `ALLOWED_HOSTS` | *(empty)* | Extra host names allowed to open the app, comma separated. |
| `REPORTS_DIR` | `reports` | Where campaign reports are saved. |
| `DATA_DIR` | `data` | Where the WhatsApp send log and opt-out list are kept. |
| `MSG91_API_URL` | MSG91 Flow API | Only change this for testing against a mock server. |

### WhatsApp

| Setting | Default | What it does |
| --- | --- | --- |
| `WHATSAPP_META_TOKEN` | *(empty)* | Meta System User token. |
| `WHATSAPP_META_PHONE_NUMBER_ID` | *(empty)* | Phone number ID from WhatsApp → API Setup. |
| `WHATSAPP_META_WABA_ID` | *(empty)* | WhatsApp Business Account ID (used to list templates). |
| `WHATSAPP_META_API_VERSION` | `v26.0` | Graph API version. |
| `WHATSAPP_META_APP_SECRET` | *(empty)* | Needed for delivery receipts, and if your app has "Require app secret" on. |
| `WHATSAPP_MARKETING_ENDPOINT` | `auto` | `auto`, `messages` or `marketing_messages`: where marketing templates are sent. |
| `MSG91_WHATSAPP_NUMBER` | *(empty)* | Your WhatsApp number integrated in MSG91, digits only. |
| `WHATSAPP_MSG91_CHUNK` | `100` | Contacts per MSG91 bulk request (1–1000). |
| `WHATSAPP_RATE_PER_SEC` | `20` | Messages per second for Meta (up to 80). |
| `WHATSAPP_DAILY_LIMIT` | `250` | New contacts per 24 hours; `0` means no limit. Meta's own value is used when available. |
| `WHATSAPP_PRICE_PER_MESSAGE` | *(empty)* | Your price per message in ₹, for the cost estimate. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | *(empty)* | Turns on delivery receipts (with the app secret). |
| `PUBLIC_WEBHOOK_HOST` | *(empty)* | Your tunnel host name, allowed for `/webhooks/whatsapp` only. |
| `WHATSAPP_SIMULATE_ERRORS` | *(empty)* | Simulate mode only: fake errors, e.g. `131026:0.05,130429:0.02`. |
| `WHATSAPP_META_API_URL`, `MSG91_WHATSAPP_API_URL` | real APIs | Only change these for testing against a mock server. |

## Security

- The app listens on `127.0.0.1` only, so other devices on your network can't use it.
- Keys and tokens stay in `.env` on the server side. They are never sent to the browser or written to logs or reports.
- Requests addressed to any host name other than `localhost` are refused, so other websites can't send messages through
  the app by pointing their own domain at your computer (DNS rebinding). The only exception is your tunnel host, and
  only for the signed WhatsApp webhook.
- Uploaded header files are checked by their content (JPEG, PNG or PDF), not just their name.
- `.env`, `reports/` and `data/` are listed in `.gitignore`. Don't commit them.

## Run with Docker (optional)

```bash
docker build -t sms-simulator .
docker run --rm -p 127.0.0.1:3000:3000 --env-file .env \
  -v "$(pwd)/reports:/app/reports" -v "$(pwd)/data:/app/data" sms-simulator
```

On Windows PowerShell, use `${PWD}` instead of `$(pwd)`. Keep the `data` folder mounted so the WhatsApp send log
survives restarts.

## Troubleshooting

### SMS

| Problem | Fix |
| --- | --- |
| `Port 3000 is already in use` | Close the other program, or set `PORT=3001` in `.env`. |
| Live mode is greyed out | `MSG91_AUTH_KEY` is missing from `.env`, or the app wasn't restarted. |
| `MSG91 rejected the request: Authentication failure` | The auth key is wrong. Copy it again from MSG91. |
| MSG91 accepts the batch but no SMS arrives | Check the template is DLT-approved and linked to your sender ID, and look at MSG91's delivery report. |
| Numbers like `9.19877E+11` are listed as invalid | Format the column as Text in Excel and export again, or upload the `.xlsx` directly. |

### WhatsApp

| Message or error | What to do |
| --- | --- |
| Live is greyed out / "needs WHATSAPP_META_TOKEN…" | Add the Meta or MSG91 WhatsApp settings to `.env` and restart. |
| 190 "access token is invalid or expired" | The token expired (temporary tokens last 24 hours). Create a System User token. |
| 132001 "template doesn't exist in this language" | Check the template name and language, and that it's approved. Press **Refresh**. |
| 132000 "number of values doesn't match" | The template changed after you picked it. Pick it again and re-map the variables. |
| 131026 "message undeliverable" | The number isn't on WhatsApp or hasn't accepted WhatsApp's latest terms. |
| 131049 "didn't deliver this marketing message" | Meta limits how many marketing messages each person gets. Try them again after 24 hours. |
| 131048 "spam reports or low quality" | Stop sending, check quality in WhatsApp Manager, and only message people who opted in. |
| 131056 "too many messages to this person" | The app waits and retries automatically. |
| 130429 "sending speed limit" | The app slows down automatically. Lower `WHATSAPP_RATE_PER_SEC` if it keeps happening. |
| 131063 "Marketing Messages API" | Accept the Marketing Messages API terms in Meta Business Manager. |
| "unknown" contacts in the report | No answer came back, so they may have been sent. Check WhatsApp Manager before re-sending by hand. |
| MSG91 needs a public link | MSG91 can't take an uploaded file. Paste an `https://` link to the image or PDF. |

## Development

```bash
npm run dev        # server on :3000 + Vite dev server on http://localhost:5173 with hot reload
npm run typecheck  # server, client and browser tests
npm test           # unit, API, property and component tests (Vitest)
npm run coverage   # the same, with coverage limits
npm run e2e        # builds the app and runs the browser tests (Playwright)
```

Before the first `npm run e2e`, install the test browser once with `npx playwright install chromium`.

### What the tests cover

- **Unit and API tests** (`server/test`, `client/src/*.test.ts*`): phone clean-up, CSV/Excel reading, both MSG91
  APIs and Meta's request formats (pinned by golden files), the WhatsApp error table, sending engines with retries,
  stops, cancel and crashes, the send log, skip rules, every API route and the webhook, hostile input (HTML,
  spreadsheet formulas, forged signatures, oversized requests), and the screens' building blocks.
- **Random-input tests** (fast-check) run thousands of generated phone numbers, CSV cells, template variables and
  pasted lists through the code to make sure nothing breaks or gets mixed up.
- **Browser tests** (`e2e/`) drive the real app in Chromium against mock MSG91 and Meta servers: every SMS and
  WhatsApp path (including typed contacts, retries, failures, Stop sending, "Send to the rest", delivery receipts,
  daily limits and opt-outs), Ctrl+C and crash recovery without duplicate messages, 50,000 contacts, and an
  accessibility and phone-width check of every screen in light and dark mode. No real messages are ever sent.

```
server/src/
  index.ts                    starts the server, clean shutdown
  app.ts, http.ts             Express app, error handling, Host-header check
  config.ts                   reads and checks .env
  routes/uploads.ts           file upload, typed contacts, contact check, skipped-rows CSV (shared)
  routes/campaigns.ts         SMS: test send, start / status / cancel / report
  services/parseContacts.ts   CSV (papaparse) and XLSX (exceljs) reading
  services/phone.ts           phone number clean-up and validation
  services/sms.ts             MSG91 Flow API client and the simulated SMS provider
  services/campaignRunner.ts  SMS batching, retries, cancel, reports
  whatsapp/
    templates.ts              template model, Meta/MSG91 parsing, demo templates
    params.ts                 per-contact values, cleaning, length limits
    payload.ts                Meta and MSG91 request bodies
    errors.ts                 WhatsApp error codes → retry / wait / fail / stop
    providers/                Meta Cloud API, MSG91 WhatsApp, simulated
    rateLimiter.ts, runner.ts sending engine
    ledger.ts, plan.ts        write-ahead send log, opt-outs, skip rules
    media.ts                  header image/PDF upload or link
    routes.ts, webhook.ts     /api/whatsapp and /webhooks/whatsapp
client/src/
  App.tsx                     SMS | WhatsApp switch
  steps/                      Add contacts (file or typed) and Check contacts (shared)
  channels/sms/               SMS wizard
  channels/whatsapp/          WhatsApp wizard, preview, formatting
e2e/
  tests/                      browser scenarios
  mocks/                      mock MSG91 and Meta servers
  helpers/                    starts the built app on a free port with its own data folders
```
