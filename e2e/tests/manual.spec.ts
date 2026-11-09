import { expect, test } from "@playwright/test";
import { startApp, type RunningApp } from "../helpers/app.ts";
import { chooseTemplate, download, goToSend, open, runSimulation, stats } from "../helpers/ui.ts";

let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp();
});
test.afterAll(async () => {
  await app.stop();
});

test("typed and pasted contacts go through the SMS flow", async ({ page }) => {
  const sms = await open(page, app, "sms");
  await sms.getByRole("button", { name: "Type numbers" }).click();
  await sms.getByLabel("Name 1", { exact: true }).fill("Asha");
  await sms.getByLabel("Number 1", { exact: true }).fill("98765 43210");
  await sms.getByText("Paste a list").click();
  await sms.getByLabel("Pasted contacts").fill("Ravi, +91 91234 56789\n12345\nMeera\t098200 11223\nAsha again, 9876543210");
  await sms.getByRole("button", { name: "Add to the list" }).click();
  await expect(sms.getByLabel(/^Number \d+$/)).toHaveCount(5);
  await sms.getByRole("button", { name: "Use these contacts (5)" }).click();

  await expect(sms.getByText("Typed contacts (5)")).toBeVisible();
  await expect(sms.locator(".stat.good .value")).toHaveText("3");
  expect(await stats(sms)).toEqual([3, 1, 1]);
  await expect(sms.locator("tbody").last()).toContainText("Expected 10 digits, found 5");

  await sms.getByRole("button", { name: "Next: write message" }).click();
  await sms.getByLabel("Template text").fill("Hello from ABC Store");
  await sms.getByRole("button", { name: "Next: send" }).click();
  await sms.getByRole("button", { name: "Run simulation" }).click();
  await expect(sms.getByRole("heading", { name: "Simulation: Finished" })).toBeVisible();
  expect((await stats(sms))[0]).toBe(3);
});

test("typed names fill the WhatsApp template", async ({ page }) => {
  const wa = await open(page, app, "whatsapp");
  await wa.getByRole("button", { name: "Type numbers" }).click();
  await wa.getByLabel("Name 1", { exact: true }).fill("Imran");
  await wa.getByLabel("Number 1", { exact: true }).fill("91 99887 76655");
  await wa.getByLabel("Name 2", { exact: true }).fill("Priya");
  await wa.getByLabel("Number 2", { exact: true }).fill("8899001122");
  await wa.getByRole("button", { name: "Use these contacts (2)" }).click();
  await expect(wa.locator(".stat.good .value")).toHaveText("2");

  await chooseTemplate(wa, "order_ready");
  await expect(wa.getByLabel("Source for {{1}}").locator("option:checked")).toHaveText("Column: Name");
  await wa.getByLabel("Text for Header {{1}}").fill("#7");
  await wa.getByLabel("Text for {{2}}").fill("Pune");
  await expect(wa.locator(".wa-body")).toHaveText(/^Hello Imran, your order is ready/);
  await goToSend(wa);
  await runSimulation(wa);
  const report = await download(page, wa.getByText("Download report (CSV)"));
  expect(report).toContain(",#7,Imran,Pune");
  expect(report).toContain(",#7,Priya,Pune");
});
