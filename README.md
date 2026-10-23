# SMS Simulator

A small web app that sends **one SMS to every contact in a CSV or Excel file** through
[MSG91](https://msg91.com). It runs on your own computer (Windows, macOS or Linux) and opens in the browser.

- Upload a `.csv` or `.xlsx` file and pick the phone-number column.
- See which numbers are valid, which are wrong and which are duplicates before anything is sent.
- Enter your MSG91 template and preview the message on a phone mock-up, with SMS-part and credit estimates.
- **Simulate mode:** a dry run that shows exactly what MSG91 would receive. Nothing is sent and nothing is charged.
- **Live mode:** sends through MSG91 in batches, retries temporary errors, and lets you stop part-way.
- Download a CSV report of every number and what happened to it.

## Requirements

- [Node.js](https://nodejs.org) **20.19 or newer** (the current LTS, 22 or later, is recommended). Nothing else is needed.
- An MSG91 account, but only for Live mode. Simulate mode works without one.

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

To turn on Live mode, copy `.env.example` to `.env`, add your MSG91 auth key and restart (`Ctrl+C`, then `npm start`):

| OS | Copy command |
| --- | --- |
| Windows | `copy .env.example .env` |
| macOS / Linux | `cp .env.example .env` |

Then open `.env` in any text editor and fill in `MSG91_AUTH_KEY`. Settings are explained in [Settings](#settings).

## Setting up MSG91 (India / DLT)

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

## Using the app

1. **Upload file.** The first row must hold column names. Up to 5 MB and 50,000 rows.
2. **Check contacts.** Choose the phone column (it's usually picked for you). Numbers can contain spaces, dashes, a
   leading `0`, `+91` or `91`; they're converted to MSG91's format (`919876543210`). Invalid and duplicate rows are
   listed and can be downloaded. Each number gets the SMS once.
3. **Write message.** Paste the template ID and the template text exactly as approved, then fill in the variable values.
   The text is used for the preview and the length count. MSG91 sends the approved template.
4. **Send.**
   - Use **Simulate** first to check everything.
   - Switch to **Live** and send a **test SMS to your own number**.
   - Then press **Send N SMS** and confirm.

### File tips

- `.xlsx` and `.csv` are supported. Old `.xls` files must be saved as `.xlsx` or `.csv` first.
- In Excel, format the phone column as **Text** before saving as CSV, or long numbers get shortened to `9.19877E+11`.
  The app flags these rows.
- `samples/demo-contacts.csv` and `samples/demo-contacts.xlsx` are for trying the app. **Use them in Simulate mode
  only**: the numbers look real and could belong to someone.

## How sending works

- Numbers are sent in batches of `BATCH_SIZE` (100) per request to MSG91's Flow API
  (`POST https://control.msg91.com/api/v5/flow`), with a short pause between batches.
- Network errors, HTTP 5xx and HTTP 429 are retried up to 3 times (after 1, 2 and 4 seconds). Other errors are not retried.
- If MSG91 rejects the **first** batch (wrong auth key, unknown template, no balance), sending stops, because every
  other batch would be rejected the same way.
- **Stop sending** finishes the batch in progress and skips the rest.
- Only one campaign runs at a time.
- Each campaign's report is saved in the `reports/` folder and can be downloaded from the app.
- "Submitted" means MSG91 accepted the numbers. Whether each SMS reached the phone is shown in the MSG91 dashboard's
  delivery reports.

## Settings

All settings go in `.env` (copy it from `.env.example`). Restart the app after changing them.

| Setting | Default | What it does |
| --- | --- | --- |
| `MSG91_AUTH_KEY` | *(empty)* | Your MSG91 auth key. Leave empty for Simulate-only. |
| `MSG91_TEMPLATE_ID` | *(empty)* | Template ID pre-filled in the app. |
| `DEFAULT_COUNTRY_CODE` | `91` | Added to numbers written without a country code. |
| `BATCH_SIZE` | `100` | Numbers per MSG91 request (1–1000). |
| `BATCH_DELAY_MS` | `500` | Pause between requests, in milliseconds. |
| `PORT` | `3000` | Port the app listens on. |
| `HOST` | `127.0.0.1` | Keep this so only your computer can reach the app. |
| `ALLOWED_HOSTS` | *(empty)* | Extra host names allowed to open the app, comma separated. |
| `REPORTS_DIR` | `reports` | Where campaign reports are saved. |
| `MSG91_API_URL` | MSG91 Flow API | Only change this for testing against a mock server. |

## Security

- The app listens on `127.0.0.1` only, so other devices on your network can't use it.
- The auth key stays in `.env` on the server side. It is never sent to the browser or written to logs or reports.
- Requests addressed to any host name other than `localhost` are refused, so other websites can't send SMS through the
  app by pointing their own domain at your computer (DNS rebinding).
- `.env` and `reports/` are listed in `.gitignore`. Don't commit them.

## Run with Docker (optional)

```bash
docker build -t sms-simulator .
docker run --rm -p 127.0.0.1:3000:3000 --env-file .env -v "$(pwd)/reports:/app/reports" sms-simulator
```

On Windows PowerShell, use `${PWD}` instead of `$(pwd)`.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Port 3000 is already in use` | Close the other program, or set `PORT=3001` in `.env`. |
| Live mode is greyed out | `MSG91_AUTH_KEY` is missing from `.env`, or the app wasn't restarted. |
| `MSG91 rejected the request: Authentication failure` | The auth key is wrong. Copy it again from MSG91. |
| MSG91 accepts the batch but no SMS arrives | Check the template is DLT-approved and linked to your sender ID, and look at MSG91's delivery report. |
| Numbers like `9.19877E+11` are listed as invalid | Format the column as Text in Excel and export again, or upload the `.xlsx` directly. |

## Development

```bash
npm run dev        # server on :3000 + Vite dev server on http://localhost:5173 with hot reload
npm test           # unit and API tests (Vitest)
npm run typecheck
```

```
server/src/
  index.ts                  starts the server
  app.ts, http.ts           Express app, error handling, Host-header check
  config.ts                 reads and checks .env
  routes/uploads.ts         file upload, contact check, skipped-rows CSV
  routes/campaigns.ts       test send, start / status / cancel / report
  services/parseContacts.ts CSV (papaparse) and XLSX (exceljs) reading
  services/phone.ts         phone number clean-up and validation
  services/sms.ts           MSG91 Flow API client and the simulated provider
  services/campaignRunner.ts batching, retries, cancel, reports
client/src/
  App.tsx                   the 4-step wizard
  steps/*.tsx               Upload, Contacts, Compose, Send
  sms.ts                    SMS length / parts counting and template variables
```
