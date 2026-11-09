import { expect, test, type Locator } from "@playwright/test";
import { startApp, type RunningApp } from "../helpers/app.ts";
import { PDF, PNG, chooseTemplate, csv, download, goToSend, open, runSimulation, samplePayload, tempFile, typeContacts, uploadFile } from "../helpers/ui.ts";

let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp();
});
test.afterAll(async () => {
  await app.stop();
});

const contactsFile = (rows: string[][]) => tempFile("contacts.csv", csv(rows));
const source = (wa: Locator, label: string) => wa.getByLabel(`Source for ${label}`, { exact: true });

test("image header and a per-contact link button", async ({ page }) => {
  const wa = await open(page, app, "whatsapp");
  await uploadFile(wa, await contactsFile([["Name", "Phone", "Code"], ["Asha", "9876543210", "ASHA10"], ["Ravi", "9123456789", "RAVI10"]]));
  await chooseTemplate(wa, "festival_offer");
  await wa.getByLabel("Text for {{2}}").fill("Diwali");
  await wa.getByLabel("Text for {{3}}").fill("20%");
  await source(wa, "Link button {{1}}").selectOption({ label: "Column: Code" });
  await wa.locator('input[type="file"][accept="image/jpeg,image/png"]').setInputFiles(await tempFile("offer.png", PNG));
  await expect(wa.locator("img.wa-media")).toBeVisible();
  await expect(wa.locator(".wa-body strong")).toHaveText("Diwali sale");
  await goToSend(wa);
  await runSimulation(wa);
  const payload = await samplePayload(wa);
  expect(payload).toMatchObject({
    to: "919876543210",
    template: {
      name: "festival_offer",
      components: [
        { type: "header", parameters: [{ type: "image", image: { id: expect.stringMatching(/^SIM-MEDIA-/) } }] },
        { type: "body", parameters: [{ text: "Asha" }, { text: "Diwali" }, { text: "20%" }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ text: "ASHA10" }] },
      ],
    },
  });
});

test("PDF header with named variables", async ({ page }) => {
  const wa = await open(page, app, "whatsapp");
  await uploadFile(wa, await contactsFile([["Name", "Phone", "Amount"], ["Meera", "9820011223", "₹1,250"]]));
  await chooseTemplate(wa, "invoice_ready");
  await source(wa, "{{customer_name}}").selectOption({ label: "Column: Name" });
  await source(wa, "{{amount}}").selectOption({ label: "Column: Amount" });
  await wa.locator('input[type="file"][accept="application/pdf"]').setInputFiles(await tempFile("invoice-42.pdf", PDF));
  await expect(wa.locator(".wa-doc")).toContainText("invoice-42.pdf");
  await goToSend(wa);
  await runSimulation(wa);
  expect(await samplePayload(wa)).toMatchObject({
    template: {
      components: [
        { type: "header", parameters: [{ type: "document", document: { filename: "invoice-42.pdf" } }] },
        { type: "body", parameters: [{ parameter_name: "customer_name", text: "Meera" }, { parameter_name: "amount", text: "₹1,250" }] },
      ],
    },
  });
});

test("copy-code button", async ({ page }) => {
  const wa = await open(page, app, "whatsapp");
  await typeContacts(wa, [["Imran", "9988776655"]]);
  await chooseTemplate(wa, "welcome_coupon");
  await wa.getByLabel("Text for Coupon code").fill("WELCOME10");
  await expect(wa.locator(".wa-button")).toHaveText("⧉ Copy code WELCOME10");
  await goToSend(wa);
  await runSimulation(wa);
  expect(await samplePayload(wa)).toMatchObject({
    template: { components: [{ type: "body" }, { type: "button", sub_type: "copy_code", parameters: [{ type: "coupon_code", coupon_code: "WELCOME10" }] }] },
  });
});

test("a template typed in by hand", async ({ page }) => {
  const wa = await open(page, app, "whatsapp");
  await typeContacts(wa, [["Asha", "9876543210"]]);
  await wa.getByRole("button", { name: "Next: write message" }).click();
  await wa.getByText("Template not listed? Type it in by hand").click();
  await wa.getByLabel("Template name").fill("promo_hi");
  await wa.getByLabel("Language code").fill("hi");
  await wa.getByLabel("Body").fill("नमस्ते {{1}}, आज का ऑफर देखें।");
  await wa.getByRole("button", { name: "Use this template" }).click();
  await wa.getByRole("button", { name: "Next: personalize" }).click();
  await expect(wa.locator(".wa-body")).toHaveText("नमस्ते Asha, आज का ऑफर देखें।");
  await goToSend(wa);
  await runSimulation(wa);
  expect(await samplePayload(wa)).toMatchObject({ template: { name: "promo_hi", language: { code: "hi" } } });
});

test("skipped contacts, stepping through the preview, and the report", async ({ page }) => {
  const wa = await open(page, app, "whatsapp");
  await uploadFile(wa, await contactsFile([["Name", "Phone"], ["Asha", "9876543210"], ["", "9123456789"], ["Ravi", "9820011223"]]));
  await chooseTemplate(wa, "order_ready");
  await wa.getByLabel("Text for Header {{1}}").fill("#1");
  await wa.getByLabel("Text for {{2}}").fill("Pune");
  await expect(wa.locator(".stats.two .name").last()).toHaveText("skipped: 1 missing or invalid values");
  await expect(wa.locator(".wa-caption")).toContainText("Row 2");
  await wa.getByRole("button", { name: "Next contact" }).click();
  await expect(wa.locator(".wa-caption")).toContainText("Row 4");
  await expect(wa.locator(".wa-body")).toContainText("Hello Ravi");
  await wa.getByText("See skipped contacts").click();
  await expect(wa.locator("details.hint tbody tr td")).toHaveText(["3", "919123456789", 'Empty value for {{1}} (column "Name")']);
  await goToSend(wa);
  await runSimulation(wa);
  const report = await download(page, wa.getByText("Download report (CSV)"));
  const lines = report.replace(/^﻿/, "").trim().split("\r\n");
  expect(lines[0]).toBe("file_row,number,status,reason,message_id,error_code,attempts,time,delivery,header {{1}},{{1}},{{2}}");
  expect(lines[2]).toBe('3,919123456789,skipped,"Empty value for {{1}} (column ""Name"")",,,0,,,,,');
});

test("stops when the first messages all fail the same way", async ({ page }) => {
  const failing = await startApp({ WHATSAPP_SIMULATE_ERRORS: "131026:1" });
  try {
    const wa = await open(page, failing, "whatsapp");
    await typeContacts(
      wa,
      Array.from({ length: 7 }, (_, i): [string, string] => [`Person ${i}`, `98765000${10 + i}`]),
    );
    await chooseTemplate(wa, "hello_world");
    await goToSend(wa);
    await runSimulation(wa);
    await expect(wa.getByRole("heading", { level: 2 })).toHaveText("Simulation: Failed");
    await expect(wa.getByText(/first 5 messages all failed with the same error/)).toBeVisible();
    await expect(wa.locator("table tbody tr").first()).toContainText("131026");
  } finally {
    await failing.stop();
  }
});
