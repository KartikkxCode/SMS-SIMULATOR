import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { CampaignStore } from "../src/services/campaignRunner.js";
import { SimulatedProvider, SmsApiError, type SmsProvider } from "../src/services/sms.js";

function setup(opts: { clientDir?: string; live?: SmsProvider } = {}) {
  const config = loadConfig({ REPORTS_DIR: "unused", MSG91_AUTH_KEY: "k" });
  const campaigns = new CampaignStore({ batchSize: 100, batchDelayMs: 0 });
  const app = createApp({
    config,
    campaigns,
    clientDir: opts.clientDir,
    providerFor: (mode) => (mode === "live" && opts.live ? opts.live : new SimulatedProvider(0)),
  });
  return { app, campaigns };
}

describe("app shell", () => {
  it("serves the built client for every page, but not for API or webhook paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "client-"));
    await writeFile(path.join(dir, "index.html"), "<!doctype html><title>SMS Simulator</title>");
    const { app } = setup({ clientDir: dir });
    expect((await request(app).get("/")).text).toContain("SMS Simulator");
    expect((await request(app).get("/whatsapp/anything")).text).toContain("SMS Simulator");
    const api = await request(app).get("/api/nope");
    expect(api.status).toBe(404);
    expect(api.body).toEqual({ error: "Unknown API route." });
    expect((await request(app).get("/webhooks/whatsapp")).text).not.toContain("SMS Simulator");
  });

  it("works without a built client (npm run dev)", async () => {
    const { app } = setup({ clientDir: "/does/not/exist" });
    expect((await request(app).get("/")).status).toBe(404);
  });

  it("answers broken and oversized request bodies clearly", async () => {
    const { app } = setup();
    const broken = await request(app).post("/api/campaigns").set("content-type", "application/json").send("{oops");
    expect(broken.status).toBe(400);
    expect(broken.body.error).toMatch(/isn't valid JSON/);

    const huge = await request(app)
      .post("/api/upload/manual")
      .send({ contacts: Array.from({ length: 3000 }, () => ({ name: "N".repeat(100), phone: "9876543210" })) });
    expect(huge.status).toBe(413);
    expect(huge.body.error).toMatch(/too large/);
  });
});

describe("SMS edge cases", () => {
  it("reports a failed live test send as 502 with MSG91's reason", async () => {
    const live: SmsProvider = {
      mode: "live",
      sendBatch: vi.fn(async () => {
        throw new SmsApiError("MSG91 rejected the request: Authentication failure", 200, false);
      }),
    };
    const { app } = setup({ live });
    const res = await request(app).post("/api/test-send").send({ mode: "live", templateId: "t", number: "9876543210" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Authentication failure/);
  });

  it("refuses to cancel a finished campaign and to check a missing column", async () => {
    const { app, campaigns } = setup();
    const up = await request(app).post("/api/upload/manual").send({ contacts: [{ name: "A", phone: "9876543210" }] });
    const start = await request(app).post("/api/campaigns").send({ uploadId: up.body.uploadId, column: 1, mode: "simulate" });
    await campaigns.waitFor(start.body.id);
    expect((await request(app).post(`/api/campaigns/${start.body.id}/cancel`)).status).toBe(409);
    expect((await request(app).get("/api/campaigns/nope")).status).toBe(404);
    const badColumn = await request(app).get(`/api/uploads/${up.body.uploadId}/contacts?column=5`);
    expect(badColumn.status).toBe(400);
    expect(badColumn.body.error).toMatch(/doesn't exist/);
  });
});
