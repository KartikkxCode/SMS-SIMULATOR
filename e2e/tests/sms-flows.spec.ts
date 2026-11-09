import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ROOT, startApp, type RunningApp } from "../helpers/app.ts";
import { download, open, stats, tempFile, typeContacts, uploadFile } from "../helpers/ui.ts";
import { mockMsg91Sms } from "../mocks/providers.ts";
import { jsonBody, type MockServer } from "../mocks/server.ts";

const people = (n: number): Array<[string, string]> => Array.from({ length: n }, (_, i) => [`Person ${i + 1}`, `98765000${10 + i}`]);

async function toSendStep(sms: Locator, text = "Hello from ABC Store") {
  await sms.getByRole("button", { name: "Next: write message" }).click();
  await sms.getByLabel("Template text").fill(text);
  await sms.getByRole("button", { name: "Next: send" }).click();
}

async function sendLive(page: Page, sms: Locator, count: number) {
  await sms.getByText("Live", { exact: true }).click();
  await sms.getByRole("button", { name: `Send ${count} SMS` }).click();
  await expect(page.getByRole("dialog")).toContainText(`This sends the message to ${count} numbers`);
  await page.getByRole("button", { name: "Yes, send now" }).click();
}

test.describe("without MSG91 keys", () => {
  let app: RunningApp;
  test.beforeAll(async () => {
    app = await startApp();
  });
  test.afterAll(async () => {
    await app.stop();
  });

  test("an Excel file: the phone column is found and skipped rows can be downloaded", async ({ page }) => {
    const sms = await open(page, app, "sms");
    await uploadFile(sms, path.join(ROOT, "samples/demo-contacts.xlsx"));
    await expect(sms.getByLabel("Which column has the phone numbers?").locator("option:checked")).toHaveText("Mobile No");
    expect(await stats(sms)).toEqual([4, 1, 1]);
    const skipped = await download(page, sms.getByText("Download all skipped rows (CSV)"));
    expect(skipped).toContain("abc-123");
    expect(skipped).toContain("Duplicate of row 2 (sent once)");

    // Choosing the wrong column shows every row as invalid and blocks the next step.
    await sms.getByLabel("Which column has the phone numbers?").selectOption({ label: "Plan" });
    await expect(sms.locator(".stat.good .value")).toHaveText("0");
    await expect(sms.getByRole("button", { name: "Next: write message" })).toBeDisabled();
  });

  test("file mistakes are explained", async ({ page }) => {
    const sms = await open(page, app, "sms");
    const input = sms.locator('input[type="file"]');
    await input.setInputFiles(await tempFile("old.xls", "x"));
    await expect(sms.getByRole("alert")).toHaveText("Old .xls files aren't supported. Save it as .xlsx or .csv first.");
    await input.setInputFiles(await tempFile("contacts.pdf", "x"));
    await expect(sms.getByRole("alert")).toHaveText("Choose a .csv or .xlsx file.");
    await input.setInputFiles(await tempFile("empty.csv", ""));
    await expect(sms.getByRole("alert")).toHaveText("The file is empty.");
    await input.setInputFiles(await tempFile("header-only.csv", "Name,Phone\n"));
    await expect(sms.getByRole("alert")).toHaveText("The file has a header row but no contacts under it.");
    await input.setInputFiles(await tempFile("fake.xlsx", "not really excel"));
    await expect(sms.getByRole("alert")).toContainText("Couldn't open the Excel file");
  });

  test("the message counter and required variables", async ({ page }) => {
    const sms = await open(page, app, "sms");
    await typeContacts(sms, people(3));
    await sms.getByRole("button", { name: "Next: write message" }).click();
    await sms.getByLabel("Template text").fill("नमस्ते ##name##, " + "आज का ऑफर ".repeat(8));
    await expect(sms.getByRole("button", { name: "Next: send" })).toBeDisabled();
    await expect(sms.getByText("Fill in: name")).toBeVisible();
    await sms.locator(".field.inline input").fill("दोस्त");
    const counter = await sms.locator(".counter dd").allInnerTexts();
    expect(counter[1]).toBe("Unicode");
    expect(Number(counter[2])).toBe(2);
    expect(Number(counter[3])).toBe(6); // 3 contacts × 2 parts
    await expect(sms.getByRole("button", { name: "Next: send" })).toBeEnabled();
  });

  test("Live is switched off until a key is set", async ({ page }) => {
    const sms = await open(page, app, "sms");
    await typeContacts(sms, people(1));
    await toSendStep(sms);
    await expect(sms.locator('input[name="mode"]').nth(1)).toBeDisabled();
    await expect(sms.getByText("Add MSG91_AUTH_KEY to the .env file and restart the app to turn this on.")).toBeVisible();
  });
});

test.describe("with a mock MSG91", () => {
  let mock: MockServer | undefined;
  let app: RunningApp | undefined;
  test.afterEach(async () => {
    await app?.stop();
    await mock?.close();
  });

  test("a rejected first batch stops the campaign", async ({ page }) => {
    mock = await mockMsg91Sms({ authKey: "the-real-key" });
    app = await startApp({ MSG91_AUTH_KEY: "a-wrong-key", MSG91_API_URL: `${mock.url}/api/v5/flow`, MSG91_TEMPLATE_ID: "t", BATCH_SIZE: "1", BATCH_DELAY_MS: "0" });
    const sms = await open(page, app, "sms");
    await typeContacts(sms, people(3));
    await toSendStep(sms);
    await sendLive(page, sms, 3);
    await expect(sms.getByRole("heading", { level: 2 })).toHaveText("Live send: Failed");
    await expect(sms.getByText(/Stopped after the first batch was rejected/)).toBeVisible();
    await expect(sms.locator("tbody .badge")).toHaveText(["failed", "not sent", "not sent"]);
    await expect(sms.locator("tbody tr").first()).toContainText("Authentication failure");
    expect(mock.calls.filter((c) => c.path === "/api/v5/flow")).toHaveLength(1);
  });

  test("Stop sending skips the batches not yet sent", async ({ page }) => {
    mock = await mockMsg91Sms({ authKey: "k", fail: () => ({ delayMs: 700, json: { type: "success", message: "SLOW" } }) });
    app = await startApp({ MSG91_AUTH_KEY: "k", MSG91_API_URL: `${mock.url}/api/v5/flow`, MSG91_TEMPLATE_ID: "t", BATCH_SIZE: "1", BATCH_DELAY_MS: "0" });
    const sms = await open(page, app, "sms");
    await typeContacts(sms, people(5));
    await toSendStep(sms);
    await sendLive(page, sms, 5);
    await sms.getByRole("button", { name: "Stop sending" }).click();
    await expect(sms.getByRole("heading", { level: 2 })).toHaveText("Live send: Cancelled");
    const report = await download(page, sms.getByText("Download report (CSV)"));
    const statuses = report.trim().split("\r\n").slice(1).map((l) => l.split(",")[2]);
    expect(statuses.filter((s) => s === "not_sent").length).toBeGreaterThanOrEqual(3);
    expect(mock.calls.length).toBeLessThan(5);
  });

  test("a live test SMS goes to just one number", async ({ page }) => {
    mock = await mockMsg91Sms({ authKey: "k" });
    app = await startApp({ MSG91_AUTH_KEY: "k", MSG91_API_URL: `${mock.url}/api/v5/flow`, MSG91_TEMPLATE_ID: "t" });
    const sms = await open(page, app, "sms");
    await typeContacts(sms, people(3));
    await toSendStep(sms);
    await sms.getByText("Live", { exact: true }).click();
    await sms.getByPlaceholder("Your mobile number").fill("098765 43210");
    await sms.getByRole("button", { name: "Send test SMS" }).click();
    await expect(sms.locator(".test-send [role=status]")).toHaveText(/Sent to 919876543210\. MSG91 request ID: SMSREQ1/);
    expect(mock.calls).toHaveLength(1);
    expect(jsonBody<{ recipients: Array<{ mobiles: string }> }>(mock.calls[0]!).recipients).toEqual([{ mobiles: "919876543210" }]);
  });
});
