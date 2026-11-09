import { expect, test } from "@playwright/test";
import { startApp, type RunningApp } from "../helpers/app.ts";
import { channel, chooseTemplate, open, readyToSend, typeContacts } from "../helpers/ui.ts";

const XSS = `<img src=x onerror="alert('hacked')">`;

let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp();
});
test.afterAll(async () => {
  await app.stop();
});

test("names that look like HTML are shown as plain text everywhere", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });

  const sms = await open(page, app, "sms");
  await typeContacts(sms, [[XSS, "9876543210"]]);
  await expect(sms.locator("table.table tbody td").first()).toHaveText(XSS);

  const wa = await open(page, app, "whatsapp");
  await typeContacts(wa, [[XSS, "9876543210"]]);
  await chooseTemplate(wa, "order_ready");
  await wa.getByLabel("Text for Header {{1}}").fill(XSS);
  await wa.getByLabel("Text for {{2}}").fill("Pune");
  await readyToSend(wa);
  await expect(wa.locator(".wa-header")).toHaveText(`Order ${XSS} is ready`);
  await expect(wa.locator(".wa-body")).toContainText(`Hello ${XSS},`);
  await expect(page.locator(".wa-bubble img, table img")).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test("switching channels keeps each one's progress", async ({ page }) => {
  const sms = await open(page, app, "sms");
  await typeContacts(sms, [["Asha", "9876543210"]]);
  await page.getByRole("link", { name: "WhatsApp" }).click();
  const wa = channel(page, "whatsapp");
  await expect(wa.getByRole("heading", { name: "Add your contacts" })).toBeVisible();
  await expect(page).toHaveURL(/#\/whatsapp$/);
  await page.getByRole("link", { name: "SMS" }).click();
  await expect(sms.getByRole("heading", { name: "Check contacts" })).toBeVisible();
  await expect(page).toHaveURL(/#\/sms$/);

  // A reload opens the channel named in the address.
  await page.getByRole("link", { name: "WhatsApp" }).click();
  await page.reload();
  await expect(sms).toBeHidden();
  await expect(wa.getByRole("heading", { name: "Add your contacts" })).toBeVisible();
  await expect(page.getByRole("link", { name: "WhatsApp" })).toHaveAttribute("aria-current", "page");
});
