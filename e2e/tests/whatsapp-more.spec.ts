import { expect, test } from "@playwright/test";
import { startApp } from "../helpers/app.ts";
import { chooseTemplate, goToSend, open, readyToSend, sendLive, stats, typeContacts } from "../helpers/ui.ts";
import { mockMsg91WhatsApp } from "../mocks/providers.ts";
import { jsonBody } from "../mocks/server.ts";

test("contacts over the daily limit are skipped with the reason", async ({ page }) => {
  const app = await startApp({ WHATSAPP_DAILY_LIMIT: "2" });
  try {
    const wa = await open(page, app, "whatsapp");
    await typeContacts(wa, [
      ["Asha", "9876543210"],
      ["Ravi", "9123456789"],
      ["Meera", "9820011223"],
    ]);
    await chooseTemplate(wa, "hello_world");
    await readyToSend(wa);
    await expect(wa.locator(".stats.two .name").last()).toHaveText("skipped: 1 over the daily limit");
    await expect(wa.getByText(/over your 24-hour limit of 2/)).toBeVisible();
    await goToSend(wa);
    await expect(wa.locator(".limit-meter")).toContainText("0 used of 2");
  } finally {
    await app.stop();
  }
});

test("numbers on the opt-out list are never messaged", async ({ page }) => {
  const app = await startApp({}, { files: { "whatsapp-optouts.txt": "+91 98765 43210\n" } });
  try {
    const wa = await open(page, app, "whatsapp");
    await typeContacts(wa, [
      ["Asha", "9876543210"],
      ["Ravi", "9123456789"],
    ]);
    await chooseTemplate(wa, "hello_world");
    await readyToSend(wa);
    await expect(wa.locator(".stats.two .name").last()).toHaveText("skipped: 1 opted out");
  } finally {
    await app.stop();
  }
});

test("MSG91 WhatsApp: lists templates and sends in bulk chunks", async ({ page }) => {
  const mock = await mockMsg91WhatsApp({ authKey: "msg91-key", number: "919000000001" });
  const app = await startApp({
    MSG91_AUTH_KEY: "msg91-key",
    MSG91_WHATSAPP_NUMBER: "919000000001",
    MSG91_WHATSAPP_API_URL: `${mock.url}/api/v5/whatsapp`,
    WHATSAPP_MSG91_CHUNK: "2",
  });
  try {
    const wa = await open(page, app, "whatsapp");
    await expect(wa.getByText("WhatsApp connected: MSG91")).toBeVisible();
    await typeContacts(
      wa,
      ["Asha", "Ravi", "Meera", "Imran", "Priya"].map((n, i): [string, string] => [n, `98765000${11 + i}`]),
    );
    await wa.getByRole("button", { name: "Next: write message" }).click();
    await expect(wa.locator('input[name="wa-provider"]').nth(1)).toBeChecked();
    await wa.getByRole("button", { name: "Back" }).click();
    await chooseTemplate(wa, "order_ready");
    await wa.getByLabel("Text for Header {{1}}").fill("#42");
    await wa.getByLabel("Text for {{2}}").fill("Pune");
    await goToSend(wa);
    await sendLive(page, wa);
    await expect(wa.getByRole("heading", { level: 2 })).toHaveText("Live send: Finished");
    expect((await stats(wa, ".stats.four .value"))[0]).toBe(5);

    type Bulk = { integrated_number: string; payload: { template: { namespace: string; to_and_components: Array<{ to: string[]; components: Record<string, { value: string }> }> } } };
    const bulks = mock.calls.filter((c) => c.path.endsWith("/bulk/")).map((c) => jsonBody<Bulk>(c));
    expect(bulks.map((b) => b.payload.template.to_and_components.length)).toEqual([2, 2, 1]);
    expect(bulks[0]).toMatchObject({ integrated_number: "919000000001", payload: { template: { namespace: "ns-123" } } });
    expect(bulks[0]!.payload.template.to_and_components[0]).toEqual({
      to: ["919876500011"],
      components: { header_1: { type: "text", value: "#42" }, body_1: { type: "text", value: "Asha" }, body_2: { type: "text", value: "Pune" } },
    });
  } finally {
    await app.stop();
    await mock.close();
  }
});
