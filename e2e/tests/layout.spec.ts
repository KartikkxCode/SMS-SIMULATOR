import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { startApp, type RunningApp } from "../helpers/app.ts";
import { PNG, chooseTemplate, goToSend, open, readyToSend, runSimulation, tempFile, typeContacts } from "../helpers/ui.ts";

let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp();
});
test.afterAll(async () => {
  await app.stop();
});

/**
 * Every screen must fit a 375 px phone without sideways scrolling, and have no serious or
 * critical accessibility problems (WCAG 2.1 A/AA, via axe), in both light and dark mode.
 */
async function audit(page: Page, testInfo: TestInfo, screen: string) {
  const problems: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    // Reduced motion: colours switch at once instead of fading, so contrast is measured on the final colours.
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const width of [1200, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) problems.push(`${screen} (${scheme}, ${width}px): ${overflow}px sideways scroll`);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      for (const v of violations.filter((v) => v.impact === "serious" || v.impact === "critical")) {
        problems.push(`${screen} (${scheme}, ${width}px): ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      }
    }
    await testInfo.attach(`${screen}-${scheme}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1200, height: 900 });
  expect(problems).toEqual([]);
}

test("SMS screens", async ({ page }, testInfo) => {
  const sms = await open(page, app, "sms");
  await audit(page, testInfo, "sms-upload");
  await sms.getByRole("button", { name: "Type numbers" }).click();
  await audit(page, testInfo, "sms-type-numbers");
  await typeContacts(sms, [
    ["Asha", "9876543210"],
    ["Ravi", "12345"],
  ]);
  await audit(page, testInfo, "sms-contacts");
  await sms.getByRole("button", { name: "Next: write message" }).click();
  await sms.getByLabel("Template text").fill("Hello ##var1##");
  await sms.locator(".field.inline input").fill("friend");
  await audit(page, testInfo, "sms-compose");
  await sms.getByRole("button", { name: "Next: send" }).click();
  await audit(page, testInfo, "sms-send");
  await sms.getByRole("button", { name: "Run simulation" }).click();
  await expect(sms.getByRole("heading", { name: "Simulation: Finished" })).toBeVisible();
  await audit(page, testInfo, "sms-result");
});

test("WhatsApp screens", async ({ page }, testInfo) => {
  const wa = await open(page, app, "whatsapp");
  await audit(page, testInfo, "wa-upload");
  await typeContacts(wa, [
    ["Asha", "9876543210"],
    ["", "9123456789"],
  ]);
  await audit(page, testInfo, "wa-contacts");
  await wa.getByRole("button", { name: "Next: write message" }).click();
  await expect(wa.locator("button.template").first()).toBeVisible();
  await audit(page, testInfo, "wa-templates");
  await wa.getByRole("button", { name: "Back" }).click();
  await chooseTemplate(wa, "festival_offer");
  await wa.getByLabel("Text for {{2}}").fill("Diwali");
  await wa.getByLabel("Text for {{3}}").fill("20%");
  await wa.getByLabel("Text for Link button {{1}}").fill("diwali");
  await wa.locator('input[type="file"][accept="image/jpeg,image/png"]').setInputFiles(await tempFile("offer.png", PNG));
  await readyToSend(wa);
  await wa.getByText("See skipped contacts").click();
  await audit(page, testInfo, "wa-personalize");
  await goToSend(wa);
  await audit(page, testInfo, "wa-send");
  await runSimulation(wa);
  await audit(page, testInfo, "wa-result");
});
