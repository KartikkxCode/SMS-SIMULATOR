import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { startApp, type RunningApp } from "../helpers/app.ts";
import { chooseTemplate, csv, open, readyToSend, stats, tempFile, uploadFile } from "../helpers/ui.ts";

const BIG = 50_000;
const bigRows = (n: number) => [["Name", "Phone"], ...Array.from({ length: n }, (_, i) => [`Person ${i}`, `9${String(i).padStart(9, "0")}`])];

/** Server memory in MB (Linux only; undefined elsewhere). */
async function memoryMb(app: RunningApp): Promise<number | undefined> {
  try {
    const status = await readFile(`/proc/${app.pid}/status`, "utf8");
    return Math.round(Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]) / 1024);
  } catch {
    return undefined;
  }
}

test.describe.configure({ mode: "serial", timeout: 240_000 });

test(`${BIG.toLocaleString()} contacts: upload, check and an SMS simulation`, async ({ page }, testInfo) => {
  const app = await startApp({ BATCH_SIZE: "1000", BATCH_DELAY_MS: "0" });
  try {
    const file = await tempFile("big.csv", csv(bigRows(BIG)));
    const sms = await open(page, app, "sms");
    let t = Date.now();
    await uploadFile(sms, file);
    const checkSeconds = (Date.now() - t) / 1000;
    expect(await stats(sms)).toEqual([BIG, 0, 0]);

    await sms.getByRole("button", { name: "Next: write message" }).click();
    await sms.getByLabel("Template text").fill("Hello from ABC Store");
    await sms.getByRole("button", { name: "Next: send" }).click();
    t = Date.now();
    await sms.getByRole("button", { name: "Run simulation" }).click();
    await expect(sms.getByRole("heading", { name: "Simulation: Finished" })).toBeVisible({ timeout: 120_000 });
    const runSeconds = (Date.now() - t) / 1000;
    expect((await stats(sms))[0]).toBe(BIG);

    const mb = await memoryMb(app);
    testInfo.annotations.push(
      { type: "upload + contact check", description: `${checkSeconds.toFixed(1)} s` },
      { type: "SMS simulation (50 batches)", description: `${runSeconds.toFixed(1)} s` },
      { type: "server memory", description: mb === undefined ? "n/a" : `${mb} MB` },
    );
    expect(checkSeconds).toBeLessThan(30);
    if (mb !== undefined) expect(mb).toBeLessThan(500);
  } finally {
    await app.stop();
  }
});

test(`WhatsApp at scale: checking ${BIG.toLocaleString()} contacts, and a 3,000-message simulated run`, async ({ page }, testInfo) => {
  const app = await startApp({ WHATSAPP_DAILY_LIMIT: "0", WHATSAPP_RATE_PER_SEC: "80" });
  try {
    const wa = await open(page, app, "whatsapp");
    await uploadFile(wa, await tempFile("big.csv", csv(bigRows(BIG))));
    await chooseTemplate(wa, "order_ready");
    await wa.getByLabel("Text for Header {{1}}").fill("#1");
    await wa.getByLabel("Text for {{2}}").fill("Pune");
    let t = Date.now();
    await readyToSend(wa);
    const preflightSeconds = (Date.now() - t) / 1000;
    await expect(wa.locator(".stats.two .value").first()).toHaveText(BIG.toLocaleString());

    // The run itself, through the API with 3,000 contacts.
    const form = new FormData();
    form.append("file", new Blob([csv(bigRows(3000))], { type: "text/csv" }), "3k.csv");
    const up = await (await fetch(`${app.url}/api/upload`, { method: "POST", body: form })).json();
    const start = await (
      await fetch(`${app.url}/api/whatsapp/campaigns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uploadId: up.uploadId,
          column: 1,
          provider: "meta",
          mode: "simulate",
          template: { ref: "order_ready|en" },
          mapping: { "header.1": { fixed: "#1" }, "body.1": { column: 0 }, "body.2": { fixed: "Pune" } },
        }),
      })
    ).json();
    t = Date.now();
    let biggestPoll = 0;
    let view: { status: string; counts: { accepted: number } } = { status: "running", counts: { accepted: 0 } };
    while (view.status === "running") {
      await new Promise((r) => setTimeout(r, 1000));
      const text = await (await fetch(`${app.url}/api/whatsapp/campaigns/${start.id}`)).text();
      biggestPoll = Math.max(biggestPoll, text.length);
      view = JSON.parse(text);
      expect(Date.now() - t).toBeLessThan(180_000);
    }
    const runSeconds = (Date.now() - t) / 1000;
    expect(view).toMatchObject({ status: "completed", counts: { accepted: 3000 } });

    const mb = await memoryMb(app);
    testInfo.annotations.push(
      { type: `WhatsApp check of ${BIG.toLocaleString()} contacts`, description: `${preflightSeconds.toFixed(1)} s` },
      { type: "3,000 simulated WhatsApp messages", description: `${runSeconds.toFixed(1)} s (${Math.round(3000 / runSeconds)}/s)` },
      { type: "largest progress response", description: `${(biggestPoll / 1024).toFixed(1)} KB` },
      { type: "server memory", description: mb === undefined ? "n/a" : `${mb} MB` },
    );
    expect(biggestPoll).toBeLessThan(20 * 1024); // progress stays small however many contacts there are
    if (mb !== undefined) expect(mb).toBeLessThan(500);
  } finally {
    await app.stop();
  }
});
