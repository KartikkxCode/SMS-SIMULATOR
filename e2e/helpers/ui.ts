import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import type { RunningApp } from "./app.ts";

export type Channel = "sms" | "whatsapp";

// A 1×1 PNG and a minimal PDF for header uploads.
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
export const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

export async function tempFile(name: string, content: string | Buffer): Promise<string> {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "e2e-file-")), name);
  await writeFile(file, content);
  return file;
}

export const csv = (rows: string[][]) =>
  rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n") + "\n";

export function channel(page: Page, name: Channel): Locator {
  return page.locator(`[data-channel="${name}"]`);
}

export async function open(page: Page, app: RunningApp, name: Channel): Promise<Locator> {
  await page.goto(app.url + (name === "whatsapp" ? "/#/whatsapp" : "/"));
  const scope = channel(page, name);
  await expect(scope.getByRole("heading", { name: "Add your contacts" })).toBeVisible();
  return scope;
}

async function waitForContactCheck(scope: Locator) {
  await expect(scope.getByRole("heading", { name: "Check contacts" })).toBeVisible();
  await expect(scope.locator(".stat.good .value")).not.toHaveText("…");
}

export async function uploadFile(scope: Locator, file: string) {
  await scope.locator('input[type="file"]').first().setInputFiles(file);
  await waitForContactCheck(scope);
}

export async function typeContacts(scope: Locator, contacts: Array<[name: string, phone: string]>) {
  await scope.getByRole("button", { name: "Type numbers" }).click();
  for (const [i, [name, phone]] of contacts.entries()) {
    if (i >= 3) await scope.getByRole("button", { name: "+ Add row" }).click();
    await scope.getByLabel(`Name ${i + 1}`, { exact: true }).fill(name);
    await scope.getByLabel(`Number ${i + 1}`, { exact: true }).fill(phone);
  }
  await scope.getByRole("button", { name: `Use these contacts (${contacts.length})` }).click();
  await waitForContactCheck(scope);
}

export async function stats(scope: Locator, selector = ".stat .value"): Promise<number[]> {
  return (await scope.locator(selector).allInnerTexts()).map((t) => Number(t.replace(/,/g, "")));
}

/** Clicks `trigger` and returns the downloaded file's text. */
export async function download(page: Page, trigger: Locator): Promise<string> {
  const [file] = await Promise.all([page.waitForEvent("download"), trigger.click()]);
  return readFile((await file.path())!, "utf8");
}

// ---------- WhatsApp ----------

export async function chooseTemplate(scope: Locator, name: string) {
  await scope.getByRole("button", { name: "Next: write message" }).click();
  await scope.locator("button.template", { hasText: name }).click();
  await scope.getByRole("button", { name: "Next: personalize" }).click();
  await expect(scope.getByRole("heading", { name: "Personalize" })).toBeVisible();
}

/** Waits until the contact check has run and "Next: send" can be pressed. */
export async function readyToSend(scope: Locator) {
  await expect(scope.getByRole("button", { name: "Next: send" })).toBeEnabled();
}

export async function goToSend(scope: Locator) {
  await readyToSend(scope);
  await scope.getByRole("button", { name: "Next: send" }).click();
  await expect(scope.getByRole("heading", { name: "Send", exact: true })).toBeVisible();
}

export async function runSimulation(scope: Locator) {
  await scope.getByRole("button", { name: "Run simulation" }).click();
  await expect(scope.getByRole("heading", { name: /^Simulation: (?!Sending)/ })).toBeVisible({ timeout: 60_000 });
}

export async function sendLive(page: Page, scope: Locator) {
  await scope.getByText("Live", { exact: true }).click();
  await scope.locator(".check.optin input").check();
  await scope.getByRole("button", { name: /^Send \d+ WhatsApp messages$/ }).click();
  await page.getByRole("button", { name: "Yes, send now" }).click();
  await expect(scope.getByRole("heading", { name: /^Live send: (?!Sending)/ })).toBeVisible({ timeout: 90_000 });
}

export async function samplePayload(scope: Locator): Promise<Record<string, unknown>> {
  // textContent, not innerText: in Live mode the box is collapsed.
  return JSON.parse((await scope.locator("pre.code").textContent()) ?? "");
}
