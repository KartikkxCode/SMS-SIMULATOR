import { createHmac } from "node:crypto";
import http from "node:http";
import { expect, test, type Locator } from "@playwright/test";
import { startApp } from "../helpers/app.ts";
import { chooseTemplate, goToSend, open, sendLive, stats, typeContacts } from "../helpers/ui.ts";
import { mockMeta } from "../mocks/providers.ts";
import type { MockServer } from "../mocks/server.ts";

const metaEnv = (mock: MockServer, extra: Record<string, string> = {}) => ({
  WHATSAPP_META_TOKEN: "test-token",
  WHATSAPP_META_PHONE_NUMBER_ID: "PHONE1",
  WHATSAPP_META_WABA_ID: "WABA1",
  WHATSAPP_META_API_URL: mock.url,
  ...extra,
});

/** Contacts whose numbers end in the given two digits (the mock reacts to the ending). */
const numbers = (...endings: string[]): Array<[string, string]> => endings.map((e, i) => [`Person ${i + 1}`, `98765000${e}`]);

async function orderReady(wa: Locator) {
  await chooseTemplate(wa, "order_ready");
  await wa.getByLabel("Text for Header {{1}}").fill("#1");
  await wa.getByLabel("Text for {{2}}").fill("Pune");
}

test("retries what can pass, fails what can't, never resends an unanswered message", async ({ page }) => {
  const mock = await mockMeta({ token: "test-token" });
  const app = await startApp(metaEnv(mock, { WHATSAPP_PRICE_PER_MESSAGE: "0.86" }));
  try {
    const wa = await open(page, app, "whatsapp");
    await expect(wa.getByText("WhatsApp connected: Meta")).toBeVisible();
    await typeContacts(wa, numbers("11", "22", "33", "44", "55"));
    await wa.getByRole("button", { name: "Next: write message" }).click();
    await expect(wa.locator(".summary dd")).toHaveText(["+91 90000 00001", "ABC Store", "green", "250"]);
    await expect(wa.locator("button.template[disabled]")).toHaveCount(1); // pending_promo
    await wa.getByRole("button", { name: "Back" }).click();
    await orderReady(wa);
    await goToSend(wa);
    await expect(wa.locator(".summary dd").last()).toHaveText("₹4.3");
    await sendLive(page, wa);

    await expect(wa.getByRole("heading", { level: 2 })).toHaveText("Live send: Finished with errors");
    expect(await stats(wa, ".stats.four .value")).toEqual([3, 1, 1, 0]);
    await expect(wa.locator("table tbody")).toContainText("131049");
    await expect(wa.getByText(/got no answer, so they may or may not have been sent/)).toBeVisible();

    const sendsTo = (end: string) => mock.calls.filter((c) => c.path.endsWith("/messages") && c.body.toString().includes(`98765000${end}`)).length;
    expect([sendsTo("11"), sendsTo("22"), sendsTo("33"), sendsTo("44"), sendsTo("55")]).toEqual([2, 2, 1, 1, 1]);

    // Going back and checking again skips everyone already messaged (including the unanswered one).
    await wa.getByRole("button", { name: "Back to send options" }).click();
    await wa.getByRole("button", { name: "Back", exact: true }).click();
    await expect(wa.locator(".stats.two .name").last()).toHaveText("skipped: 4 already got it today");
  } finally {
    await app.stop();
    await mock.close();
  }
});

test("stops at once when the token is rejected", async ({ page }) => {
  const mock = await mockMeta({ token: "test-token" });
  const app = await startApp(metaEnv(mock, { WHATSAPP_RATE_PER_SEC: "1" }));
  try {
    const wa = await open(page, app, "whatsapp");
    await typeContacts(wa, numbers("90", "55", "66"));
    await orderReady(wa);
    await goToSend(wa);
    await sendLive(page, wa);
    await expect(wa.getByRole("heading", { level: 2 })).toHaveText("Live send: Failed");
    await expect(wa.getByText(/access token is invalid or expired/).first()).toBeVisible();
    expect(await stats(wa, ".stats.four .value")).toEqual([0, 1, 2, 0]);
  } finally {
    await app.stop();
    await mock.close();
  }
});

test("Stop sending, then Send to the rest", async ({ page }) => {
  const mock = await mockMeta({ token: "test-token" });
  const app = await startApp(metaEnv(mock, { WHATSAPP_RATE_PER_SEC: "1" }));
  try {
    const wa = await open(page, app, "whatsapp");
    await typeContacts(wa, numbers("77", "78", "79", "80"));
    await orderReady(wa);
    await goToSend(wa);
    await wa.getByText("Live", { exact: true }).click();
    await wa.locator(".check.optin input").check();
    await wa.getByRole("button", { name: "Send 4 WhatsApp messages" }).click();
    await page.getByRole("button", { name: "Yes, send now" }).click();
    await wa.getByRole("button", { name: "Stop sending" }).click();
    await expect(wa.getByRole("heading", { level: 2 })).toHaveText("Live send: Stopped");
    const [accepted] = await stats(wa, ".stats.four .value");
    expect(accepted).toBeLessThan(4);

    await wa.getByRole("button", { name: `Send to the rest (${4 - accepted!})` }).click();
    await expect(wa.getByRole("heading", { level: 2 })).toHaveText("Live send: Finished", { timeout: 30_000 });
    await expect(wa.getByText("sending to the rest of an earlier campaign")).toBeVisible();
    // Everyone got exactly one message in total.
    const tos = mock.calls.filter((c) => c.path.endsWith("/messages")).map((c) => JSON.parse(c.body.toString()).to);
    expect(tos.sort()).toEqual(["919876500077", "919876500078", "919876500079", "919876500080"]);
  } finally {
    await app.stop();
    await mock.close();
  }
});

test("delivery receipts and STOP replies arrive through the signed webhook", async ({ page }) => {
  const mock = await mockMeta({ token: "test-token" });
  const app = await startApp(
    metaEnv(mock, { WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify", WHATSAPP_META_APP_SECRET: "app-secret", PUBLIC_WEBHOOK_HOST: "hooks.example.test" }),
  );
  try {
    const wa = await open(page, app, "whatsapp");
    await typeContacts(wa, numbers("55", "66"));
    await orderReady(wa);
    await goToSend(wa);
    await sendLive(page, wa);
    await expect(wa.locator(".summary dd")).toHaveText(["0", "0", "0", "0"]);

    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  { id: "wamid.MOCK919876500055", status: "read" },
                  { id: "wamid.MOCK919876500066", status: "delivered" },
                ],
                messages: [{ from: "919876500055", type: "text", text: { body: "Stop" } }],
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: app.port,
          path: "/webhooks/whatsapp",
          method: "POST",
          headers: { host: "hooks.example.test", "content-type": "application/json", "x-hub-signature-256": signature },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    expect(status).toBe(200);

    // The finished campaign keeps refreshing receipts.
    await expect(wa.locator(".summary dd")).toHaveText(["0", "1", "1", "0"], { timeout: 15_000 });
    const config = await (await fetch(`${app.url}/api/whatsapp/config`)).json();
    expect(config).toMatchObject({ webhookEnabled: true, optOutCount: 1 });
  } finally {
    await app.stop();
    await mock.close();
  }
});
