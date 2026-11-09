import path from "node:path";
import { expect, test } from "@playwright/test";
import { ROOT, startApp, type RunningApp } from "../helpers/app.ts";
import { PNG, chooseTemplate, download, goToSend, open, readyToSend, runSimulation, samplePayload, sendLive, stats, tempFile, typeContacts, uploadFile } from "../helpers/ui.ts";
import { metaError, mockMeta, mockMsg91WhatsApp } from "../mocks/providers.ts";
import type { MockServer } from "../mocks/server.ts";

const metaEnv = (mock: MockServer, token = "test-token") => ({
  WHATSAPP_META_TOKEN: token,
  WHATSAPP_META_PHONE_NUMBER_ID: "PHONE1",
  WHATSAPP_META_WABA_ID: "WABA1",
  WHATSAPP_META_API_URL: mock.url,
});

test.describe("demo templates (no keys)", () => {
  let app: RunningApp;
  test.beforeAll(async () => {
    app = await startApp();
  });
  test.afterAll(async () => {
    await app.stop();
  });

  test("an Excel file, mapped by column name", async ({ page }) => {
    const wa = await open(page, app, "whatsapp");
    await uploadFile(wa, path.join(ROOT, "samples/demo-contacts.xlsx"));
    await chooseTemplate(wa, "order_ready");
    await wa.getByLabel("Source for {{1}}", { exact: true }).selectOption({ label: "Column: Customer" });
    await wa.getByLabel("Source for Header {{1}}", { exact: true }).selectOption({ label: "Column: Plan" });
    await wa.getByLabel("Text for {{2}}").fill("Pune");
    await expect(wa.locator(".wa-header")).toHaveText("Order Gold is ready");
    await expect(wa.locator(".wa-body")).toContainText("Hello Kiran Joshi,");
    await goToSend(wa);
    await runSimulation(wa);
    expect((await stats(wa, ".stats.four .value"))[0]).toBe(4);
  });

  test("searching the template list", async ({ page }) => {
    const wa = await open(page, app, "whatsapp");
    await typeContacts(wa, [["Asha", "9876543210"]]);
    await wa.getByRole("button", { name: "Next: write message" }).click();
    await wa.getByLabel("Search templates").fill("coupon");
    await expect(wa.locator("button.template strong")).toHaveText(["welcome_coupon"]);
    await wa.getByLabel("Search templates").fill("pickup");
    await expect(wa.locator("button.template strong")).toHaveText(["order_ready"]);
    await wa.getByLabel("Search templates").fill("nothing like this");
    await expect(wa.getByText("No templates match.")).toBeVisible();
  });

  test("header links must be https, and skipped contacts can be downloaded", async ({ page }) => {
    const wa = await open(page, app, "whatsapp");
    await typeContacts(wa, [
      ["Asha", "9876543210"],
      ["", "9123456789"],
    ]);
    await chooseTemplate(wa, "festival_offer");
    await wa.getByLabel("Public link to the file").fill("http://example.com/offer.png");
    await wa.getByRole("button", { name: "Use link" }).click();
    await expect(wa.locator("fieldset .error")).toHaveText("The link must start with https://");
    await wa.getByLabel("Public link to the file").fill("not a link");
    await wa.getByRole("button", { name: "Use link" }).click();
    await expect(wa.locator("fieldset .error")).toHaveText("That isn't a valid link.");

    await wa.getByLabel("Text for {{2}}").fill("Diwali");
    await wa.getByLabel("Text for {{3}}").fill("20%");
    await wa.getByLabel("Text for Link button {{1}}").fill("diwali");
    await wa.locator('input[type="file"][accept="image/jpeg,image/png"]').setInputFiles(await tempFile("offer.png", PNG));
    await readyToSend(wa);
    await wa.getByText("See skipped contacts").click();
    const skipped = await download(page, wa.getByText("Download all skipped contacts (CSV)"));
    expect(skipped).toContain('2,919123456789,"Empty value for {{1}} (column ""Name"")"');
  });
});

test.describe("live providers (mocks)", () => {
  const cleanup: Array<{ stop?: () => Promise<void>; close?: () => Promise<void> }> = [];
  test.afterEach(async () => {
    for (const c of cleanup.splice(0)) await (c.stop?.() ?? c.close?.());
  });

  test("a live test message through Meta", async ({ page }) => {
    const mock = await mockMeta({ token: "test-token" });
    const app = await startApp(metaEnv(mock));
    cleanup.push(app, mock);
    const wa = await open(page, app, "whatsapp");
    await typeContacts(wa, [["Asha", "9876543210"]]);
    await chooseTemplate(wa, "order_ready");
    await wa.getByLabel("Text for Header {{1}}").fill("#9");
    await wa.getByLabel("Text for {{2}}").fill("Pune");
    await goToSend(wa);
    await wa.getByText("Live", { exact: true }).click();
    await wa.getByPlaceholder("Your WhatsApp number").fill("+91 99999 00055");
    await wa.getByRole("button", { name: "Send test" }).click();
    await expect(wa.locator(".test-send [role=status]")).toHaveText("Sent to 919999900055 (message ID wamid.MOCK919999900055). Check WhatsApp on that phone.");
    const sent = mock.calls.filter((c) => c.path.endsWith("/messages")).map((c) => JSON.parse(c.body.toString()));
    expect(sent).toHaveLength(1);
    expect(sent[0].template.components[1].parameters.map((p: { text: string }) => p.text)).toEqual(["Asha", "Pune"]);
  });

  test("with both providers set up, switching changes the template list", async ({ page }) => {
    const meta = await mockMeta({ token: "test-token" });
    const msg91 = await mockMsg91WhatsApp({ authKey: "m", number: "919000000001" });
    const app = await startApp({
      ...metaEnv(meta),
      MSG91_AUTH_KEY: "m",
      MSG91_WHATSAPP_NUMBER: "919000000001",
      MSG91_WHATSAPP_API_URL: `${msg91.url}/api/v5/whatsapp`,
    });
    cleanup.push(app, meta, msg91);
    const wa = await open(page, app, "whatsapp");
    await expect(wa.getByText("WhatsApp connected: Meta, MSG91")).toBeVisible();
    await typeContacts(wa, [["Asha", "9876543210"]]);
    await wa.getByRole("button", { name: "Next: write message" }).click();
    await expect(wa.locator("button.template strong")).toHaveText(["festival_offer", "order_ready", "pending_promo"]);
    await wa.getByRole("radio", { name: /MSG91 WhatsApp/ }).check();
    await expect(wa.locator("button.template strong")).toHaveText(["order_ready"]);
    await expect(wa.getByRole("button", { name: "Next: personalize" })).toBeDisabled();
  });

  test("a template list that won't load is explained", async ({ page }) => {
    const mock = await mockMeta({ token: "the-real-token" });
    const app = await startApp(metaEnv(mock, "an-expired-token"));
    cleanup.push(app, mock);
    const wa = await open(page, app, "whatsapp");
    await typeContacts(wa, [["Asha", "9876543210"]]);
    await wa.getByRole("button", { name: "Next: write message" }).click();
    await expect(wa.getByRole("alert")).toContainText("Couldn't load templates: The access token is invalid or expired.");
    await expect(wa.getByText(/Couldn't read your WhatsApp number's status/)).toBeVisible();
  });

  test("MSG91 can't take an uploaded header file for a live send", async ({ page }) => {
    const msg91 = await mockMsg91WhatsApp({ authKey: "m", number: "919000000001" });
    const app = await startApp({ MSG91_AUTH_KEY: "m", MSG91_WHATSAPP_NUMBER: "919000000001", MSG91_WHATSAPP_API_URL: `${msg91.url}/api/v5/whatsapp` });
    cleanup.push(app, msg91);
    const wa = await open(page, app, "whatsapp");
    await typeContacts(wa, [["Asha", "9876543210"]]);
    await wa.getByRole("button", { name: "Next: write message" }).click();
    await wa.getByText("Template not listed? Type it in by hand").click();
    await wa.getByLabel("Template name").fill("poster_offer");
    await wa.getByRole("combobox", { name: /^Header/ }).selectOption({ label: "Image" });
    await wa.getByLabel("Body").fill("Hi {{1}}, see our new offer.");
    await wa.getByRole("button", { name: "Use this template" }).click();
    await wa.getByRole("button", { name: "Next: personalize" }).click();
    await expect(wa.getByText("MSG91 needs a public link for live sends. An uploaded file works in Simulate mode only.")).toBeVisible();
    await wa.locator('input[type="file"][accept="image/jpeg,image/png"]').setInputFiles(await tempFile("poster.png", PNG));
    await goToSend(wa);
    await wa.getByText("Live", { exact: true }).click();
    await wa.locator(".check.optin input").check();
    await wa.getByRole("button", { name: "Send 1 WhatsApp messages" }).click();
    await page.getByRole("button", { name: "Yes, send now" }).click();
    await expect(wa.getByRole("alert")).toHaveText("MSG91 needs a public link (https://…) to the header file. Paste a link instead of uploading the file.");
    expect(msg91.calls.filter((c) => c.path.endsWith("/bulk/"))).toHaveLength(0);
  });

  test("marketing templates move to the Marketing Messages API when Meta asks", async ({ page }) => {
    const mock = await mockMeta({
      token: "test-token",
      script: (_to, _attempt, path) => (path.endsWith("/messages") ? metaError(400, 131063, "Use the Marketing Messages API") : undefined),
    });
    const app = await startApp(metaEnv(mock));
    cleanup.push(app, mock);
    const wa = await open(page, app, "whatsapp");
    await typeContacts(wa, [
      ["Asha", "9876543210"],
      ["Ravi", "9123456789"],
      ["Meera", "9820011223"],
    ]);
    await chooseTemplate(wa, "festival_offer");
    await wa.getByLabel("Text for {{2}}").fill("Diwali");
    await wa.getByLabel("Text for Link button {{1}}").fill("diwali");
    await wa.locator('input[type="file"][accept="image/jpeg,image/png"]').setInputFiles(await tempFile("offer.png", PNG));
    await goToSend(wa);
    await sendLive(page, wa);
    await expect(wa.getByRole("heading", { level: 2 })).toHaveText("Live send: Finished");
    const payload = (await samplePayload(wa)) as { template: { components: unknown[] } };
    expect(payload.template.components[0]).toEqual({ type: "header", parameters: [{ type: "image", image: { id: "MEDIA-777" } }] });

    const paths = mock.calls.filter((c) => c.method === "POST").map((c) => c.path.replace(/^\/v\d+\.\d+\/PHONE1\//, ""));
    expect(paths[0]).toBe("media"); // uploaded once
    expect(paths.filter((p) => p === "media")).toHaveLength(1);
    expect(paths.filter((p) => p === "messages")).toHaveLength(1); // the first try, refused with 131063
    expect(paths.filter((p) => p === "marketing_messages")).toHaveLength(3);
  });
});
