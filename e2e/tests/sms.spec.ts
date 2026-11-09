import path from "node:path";
import { expect, test } from "@playwright/test";
import { ROOT, startApp } from "../helpers/app.ts";
import { download, open, stats, typeContacts, uploadFile } from "../helpers/ui.ts";
import { mockMsg91Sms } from "../mocks/providers.ts";
import { jsonBody } from "../mocks/server.ts";

test("SMS Simulate: upload a file, check contacts, write and run", async ({ page }) => {
  const app = await startApp();
  try {
    const sms = await open(page, app, "sms");
    await uploadFile(sms, path.join(ROOT, "samples/demo-contacts.csv"));
    expect(await stats(sms)).toEqual([6, 2, 1]);
    await sms.getByRole("button", { name: "Next: write message" }).click();
    await sms.getByLabel("Template text").fill("Dear customer, our ##var1## sale starts today. - ABC Store");
    await sms.locator(".field.inline input").fill("Diwali");
    await expect(sms.locator(".bubble")).toHaveText("Dear customer, our Diwali sale starts today. - ABC Store");
    await sms.getByRole("button", { name: "Next: send" }).click();
    await sms.getByRole("button", { name: "Run simulation" }).click();
    await expect(sms.getByRole("heading", { name: "Simulation: Finished" })).toBeVisible();
    expect((await stats(sms))[0]).toBe(6);
    const report = await download(page, sms.getByText("Download report (CSV)"));
    expect(report.trim().split("\r\n")).toHaveLength(7);
  } finally {
    await app.stop();
  }
});

test("SMS Live: sends in batches through MSG91 and retries a server error", async ({ page }) => {
  const mock = await mockMsg91Sms({ authKey: "sms-key", fail: (n) => (n === 1 ? { status: 500, json: { type: "error", message: "busy" } } : undefined) });
  const app = await startApp({
    MSG91_AUTH_KEY: "sms-key",
    MSG91_API_URL: `${mock.url}/api/v5/flow`,
    MSG91_TEMPLATE_ID: "tpl_1",
    BATCH_SIZE: "2",
    BATCH_DELAY_MS: "0",
  });
  try {
    const sms = await open(page, app, "sms");
    await expect(sms.getByText("MSG91 connected")).toBeVisible();
    await typeContacts(sms, [
      ["Asha", "9876543210"],
      ["Ravi", "9123456789"],
      ["Meera", "9820011223"],
    ]);
    await sms.getByRole("button", { name: "Next: write message" }).click();
    await expect(sms.getByLabel("MSG91 template ID")).toHaveValue("tpl_1");
    await sms.getByLabel("Template text").fill("Hello from ABC Store");
    await sms.getByRole("button", { name: "Next: send" }).click();
    await sms.getByText("Live", { exact: true }).click();
    await sms.getByRole("button", { name: "Send 3 SMS" }).click();
    await page.getByRole("button", { name: "Yes, send now" }).click();
    await expect(sms.getByRole("heading", { name: "Live send: Finished" })).toBeVisible();

    const sends = mock.calls.filter((c) => c.path === "/api/v5/flow");
    expect(sends).toHaveLength(3); // batch 1 failed once, then 2 batches went through
    expect(sends.map((c) => jsonBody<{ recipients: unknown[] }>(c).recipients.length)).toEqual([2, 2, 1]);
    expect(jsonBody<{ template_id: string }>(sends[0]!).template_id).toBe("tpl_1");
    await expect(sms.locator("tbody tr").first()).toContainText("2"); // tries
  } finally {
    await app.stop();
    await mock.close();
  }
});
