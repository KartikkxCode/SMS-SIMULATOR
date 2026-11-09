import { appendFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startApp, type RunningApp } from "../helpers/app.ts";
import { mockMeta } from "../mocks/providers.ts";
import { jsonBody, type MockServer } from "../mocks/server.ts";

// These drive the API directly: they're about what happens to the app process, not the screens.

const metaEnv = (mock: MockServer, extra: Record<string, string> = {}) => ({
  WHATSAPP_META_TOKEN: "test-token",
  WHATSAPP_META_PHONE_NUMBER_ID: "PHONE1",
  WHATSAPP_META_WABA_ID: "WABA1",
  WHATSAPP_META_API_URL: mock.url,
  ...extra,
});

async function post(app: RunningApp, url: string, body: unknown) {
  const res = await fetch(app.url + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const contacts = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, phone: `98765000${10 + i}` }));
const order = (uploadId: string) => ({
  uploadId,
  column: 1,
  provider: "meta",
  mode: "live",
  optInConfirmed: true,
  template: { ref: "order_ready|en" },
  mapping: { "header.1": { fixed: "#1" }, "body.1": { column: 0 }, "body.2": { fixed: "Pune" } },
});
const messagesTo = (mock: MockServer) => mock.calls.filter((c) => c.path.endsWith("/messages")).map((c) => jsonBody<{ to: string }>(c).to);
const ledgerLines = async (app: RunningApp) =>
  (await readFile(path.join(app.dataDir, "whatsapp-sent.jsonl"), "utf8")).trim().split("\n").filter(Boolean);

test("Ctrl+C while sending: the message on its way finishes and the report is saved", async () => {
  const mock = await mockMeta({ token: "test-token", script: (to) => ({ delayMs: 1500, json: { messages: [{ id: `wamid.${to}` }] } }) });
  const app = await startApp(metaEnv(mock, { WHATSAPP_RATE_PER_SEC: "1" }));
  try {
    const up = await post(app, "/api/upload/manual", { contacts: contacts(4) });
    expect((await post(app, "/api/whatsapp/campaigns", order(up.body.uploadId))).status).toBe(202);
    await expect.poll(() => messagesTo(mock).length).toBe(1);

    await app.stop("SIGINT");
    expect(app.logs()).toContain("Stopping: finishing messages already on their way");
    const reports = (await readdir(app.reportsDir)).filter((f) => f.includes("-whatsapp-live-"));
    expect(reports).toHaveLength(1);
    const report = await readFile(path.join(app.reportsDir, reports[0]!), "utf8");
    const states = report.replace(/^﻿/, "").trim().split("\r\n").slice(1).map((l) => l.split(",")[2]);
    expect(states).toEqual(["accepted", "not_sent", "not_sent", "not_sent"]);
    expect((await ledgerLines(app)).map((l) => JSON.parse(l).t)).toEqual(["attempt", "result"]);
  } finally {
    await app.stop();
    await mock.close();
  }
});

test("a hard crash mid-send, then a restart: nobody gets the message twice", async () => {
  // Every message takes 400 ms, so a crash always lands while one is on its way.
  const mock = await mockMeta({ token: "test-token", script: (to) => ({ delayMs: 400, json: { messages: [{ id: `wamid.${to}` }] } }) });
  const first = await startApp(metaEnv(mock, { WHATSAPP_RATE_PER_SEC: "2" }));
  let second: RunningApp | undefined;
  try {
    let up = await post(first, "/api/upload/manual", { contacts: contacts(6) });
    await post(first, "/api/whatsapp/campaigns", order(up.body.uploadId));
    await expect.poll(() => messagesTo(mock).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    await first.stop("SIGKILL");
    // A line cut in half by the crash.
    await appendFile(path.join(first.dataDir, "whatsapp-sent.jsonl"), '{"t":"attempt","id":"half","at":"20');
    const sentBeforeCrash = messagesTo(mock).length;

    second = await startApp(metaEnv(mock), { dataDir: first.dataDir });
    // At least one message was on its way when the app died, with no answer recorded.
    expect(second.logs()).toMatch(/Note: \d+ WhatsApp message\(s\) from the last run got no answer before the app stopped/);
    up = await post(second, "/api/upload/manual", { contacts: contacts(6) });
    const check = await post(second, "/api/whatsapp/preflight", order(up.body.uploadId));
    expect(check.body.skippedByReason.recent).toBe(sentBeforeCrash);
    expect(check.body.ready).toBe(6 - sentBeforeCrash);

    const start = await post(second, "/api/whatsapp/campaigns", order(up.body.uploadId));
    await expect
      .poll(async () => (await (await fetch(`${second!.url}/api/whatsapp/campaigns/${start.body.id}`)).json()).status, { timeout: 20_000 })
      .toBe("completed");

    const tos = messagesTo(mock);
    expect(tos).toHaveLength(6);
    expect(new Set(tos).size).toBe(6); // each number exactly once across both runs
  } finally {
    await second?.stop();
    await first.stop();
    await mock.close();
  }
});
