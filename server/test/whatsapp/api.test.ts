import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { CampaignStore } from "../../src/services/campaignRunner.js";
import { WaApiError, metaApiError } from "../../src/whatsapp/errors.js";
import { WaLedger } from "../../src/whatsapp/ledger.js";
import { WaProviders } from "../../src/whatsapp/providers/index.js";
import type { FetchLike, ItemResult, SendBatch, WaProvider } from "../../src/whatsapp/providers/types.js";
import { WaCampaignStore } from "../../src/whatsapp/runner.js";
import { demoTemplates } from "../../src/whatsapp/templates.js";

const CSV = "Name,Phone,Store\nAsha,9876543210,Pune\n,+91 91234 56789,Delhi\nRavi,98200 11223,Mumbai\nBad,12345,Nagpur\n";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = Buffer.from("%PDF-1.7 test");
const orderMapping = { "header.1": { fixed: "#1042" }, "body.1": { column: 0 }, "body.2": { column: 2 } };

/** A stand-in for Meta that answers from `script(number)` and records what was sent. */
function fakeMeta(script: (to: string) => string | WaApiError = (to) => `wamid.${to}`) {
  const sent: SendBatch[] = [];
  const provider: WaProvider & { sent: SendBatch[] } = {
    id: "meta",
    mode: "live",
    maxPerRequest: 1,
    sent,
    listTemplates: async () => demoTemplates(),
    uploadMedia: async () => "MEDIA-1",
    preview: (b) => ({ to: b.items[0]?.to }),
    async send(batch) {
      sent.push(batch);
      return batch.items.map((i): ItemResult => {
        const r = script(i.to);
        return typeof r === "string" ? { index: i.index, ok: true, messageId: r } : { index: i.index, ok: false, error: r };
      });
    },
  };
  return provider;
}

async function setup(opts: { env?: Record<string, string>; meta?: WaProvider; fetchImpl?: FetchLike } = {}) {
  const config = loadConfig({ REPORTS_DIR: "unused", ...opts.env });
  const ledger = await new WaLedger(await mkdtemp(path.join(tmpdir(), "wa-api-"))).load();
  const store = new WaCampaignStore({ ratePerSec: 80, ledger, retryDelaysMs: [1, 1, 1], retryLaterMs: 1 });
  const providers = new WaProviders(config.whatsapp, undefined, 0, opts.meta ? { meta: opts.meta } : {});
  const app = createApp({
    config,
    campaigns: new CampaignStore({ batchSize: 100, batchDelayMs: 0 }),
    whatsapp: { store, ledger, providers, fetchImpl: opts.fetchImpl },
  });
  const upload = async () => (await request(app).post("/api/upload").attach("file", Buffer.from(CSV), "contacts.csv")).body.uploadId as string;
  return { app, store, ledger, upload };
}

const base = (uploadId: string, extra: Record<string, unknown> = {}) => ({
  uploadId,
  column: 1,
  provider: "meta",
  mode: "simulate",
  template: { ref: "order_ready|en" },
  mapping: orderMapping,
  ...extra,
});

describe("WhatsApp API", () => {
  it("reports setup without exposing secrets", async () => {
    const { app } = await setup({ env: { WHATSAPP_META_TOKEN: "secret-token", WHATSAPP_DAILY_LIMIT: "1000" } });
    const res = await request(app).get("/api/whatsapp/config");
    expect(res.body).toMatchObject({
      providers: { meta: { configured: false }, msg91: { configured: false } },
      defaultProvider: "meta",
      dailyLimit: 1000,
      usedLast24h: 0,
      webhookEnabled: false,
    });
    expect(JSON.stringify(res.body)).not.toContain("secret-token");
  });

  it("lists demo templates until a provider is set up", async () => {
    const { app } = await setup();
    const res = await request(app).get("/api/whatsapp/templates?provider=msg91");
    expect(res.body.source).toBe("demo");
    expect(res.body.templates.map((t: { name: string }) => t.name)).toContain("festival_offer");
  });

  it("checks contacts before sending: ready, skipped with reasons, rendered samples", async () => {
    const { app, upload } = await setup();
    const res = await request(app).post("/api/whatsapp/preflight").send(base(await upload()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ready: 2,
      skippedCount: 1,
      skippedByReason: { values: 1 },
      skipped: [{ row: 3, number: "919123456789", reason: 'Empty value for {{1}} (column "Name")' }],
      template: { name: "order_ready", category: "UTILITY", header: "TEXT" },
    });
    expect(res.body.samples[0].rendered).toMatchObject({ header: "Order #1042 is ready", body: expect.stringContaining("Hello Asha") });
    const csv = await request(app).get(`/api/whatsapp/preflight/${res.body.preflightId}/skipped.csv`);
    expect(csv.text).toContain("Empty value for {{1}}");
  });

  it("explains mapping and template problems", async () => {
    const { app, upload } = await setup();
    const id = await upload();
    const noMap = await request(app).post("/api/whatsapp/preflight").send(base(id, { mapping: {} }));
    expect(noMap.status).toBe(400);
    expect(noMap.body.error).toMatch(/Choose a column or type a value for header \{\{1\}\}/);
    const unsupported = await request(app).post("/api/whatsapp/preflight").send(base(id, { template: { ref: "login_code|en" } }));
    expect(unsupported.body.error).toMatch(/Authentication/);
    const missing = await request(app).post("/api/whatsapp/preflight").send(base(id, { template: { ref: "nope|en" } }));
    expect(missing.status).toBe(404);
  });

  it("accepts a template typed in by hand", async () => {
    const { app, upload } = await setup();
    const manual = { name: "promo", language: "hi", category: "MARKETING", headerFormat: "NONE", body: "नमस्ते {{1}}" };
    const built = await request(app).post("/api/whatsapp/templates/manual").send(manual);
    expect(built.body).toMatchObject({ ref: "promo|hi", params: [{ key: "body.1" }], supported: true });
    const badName = await request(app).post("/api/whatsapp/templates/manual").send({ ...manual, name: "Promo Offer" });
    expect(badName.body.error).toMatch(/^name: Template names use lowercase/);
    const res = await request(app)
      .post("/api/whatsapp/preflight")
      .send(base(await upload(), { template: { manual }, mapping: { "body.1": { column: 0 } } }));
    expect(res.body).toMatchObject({ ready: 2, template: { name: "promo", category: "MARKETING" } });
  });

  it("runs a simulated campaign and reports each contact with their values", async () => {
    const { app, store, ledger, upload } = await setup();
    const start = await request(app).post("/api/whatsapp/campaigns").send(base(await upload()));
    expect(start.status).toBe(202);
    await store.waitFor(start.body.id);

    const view = await request(app).get(`/api/whatsapp/campaigns/${start.body.id}`);
    expect(view.body).toMatchObject({
      mode: "simulate",
      status: "completed",
      counts: { total: 3, accepted: 2, skipped: 1, failed: 0 },
      template: { name: "order_ready" },
      resendable: 0,
      samplePayload: { template: { name: "order_ready" } },
    });
    const report = await request(app).get(`/api/whatsapp/campaigns/${start.body.id}/report.csv`);
    expect(report.text).toContain("header {{1}},{{1}},{{2}}");
    expect(report.text).toMatch(/2,919876543210,accepted,,wamid\.SIM\.[^,]+,,1,[^,]+,,#1042,Asha,Pune/);
    expect(ledger.contactsLast24h().size).toBe(0);
  });

  it("needs the header file for media templates, and checks its type", async () => {
    const { app, upload } = await setup();
    const id = await upload();
    const offer = { template: { ref: "festival_offer|en" }, mapping: { "body.1": { column: 0 }, "body.2": { fixed: "Diwali" }, "body.3": { fixed: "20%" }, "button.0": { fixed: "diwali" } } };
    const noMedia = await request(app).post("/api/whatsapp/campaigns").send(base(id, offer));
    expect(noMedia.body.error).toMatch(/needs an image for its header/);

    const pdf = await request(app).post("/api/whatsapp/media").attach("file", PDF, "brochure");
    expect(pdf.body).toMatchObject({ kind: "document", filename: "brochure.pdf" });
    const wrongKind = await request(app).post("/api/whatsapp/campaigns").send(base(id, { ...offer, mediaRef: pdf.body.ref }));
    expect(wrongKind.body.error).toMatch(/needs an image, not a PDF/);

    const png = await request(app).post("/api/whatsapp/media").attach("file", PNG, "offer.png");
    expect(png.body).toMatchObject({ kind: "image", filename: "offer.png" });
    const preview = await request(app).get(png.body.previewUrl);
    expect(preview.headers["content-type"]).toBe("image/png");

    const notMedia = await request(app).post("/api/whatsapp/media").attach("file", Buffer.from("hello"), "x.png");
    expect(notMedia.body.error).toMatch(/JPEG or PNG image, or a PDF/);
  });

  it("checks pasted media links", async () => {
    const head: FetchLike = async () => new Response(null, { status: 200, headers: { "content-type": "image/png", "content-length": "1000" } });
    const { app } = await setup({ fetchImpl: head });
    const ok = await request(app).post("/api/whatsapp/media/link").send({ link: "https://cdn.test/offer.png", kind: "image" });
    expect(ok.body).toMatchObject({ kind: "image", filename: "offer.png", previewUrl: "https://cdn.test/offer.png" });
    const http = await request(app).post("/api/whatsapp/media/link").send({ link: "http://cdn.test/a.png", kind: "image" });
    expect(http.body.error).toMatch(/https:\/\//);
    const wrong = await request(app).post("/api/whatsapp/media/link").send({ link: "https://cdn.test/a.png", kind: "document" });
    expect(wrong.body.error).toMatch(/not a PDF/);
  });

  it("test-sends to one number with given values", async () => {
    const { app } = await setup();
    const body = { provider: "meta", mode: "simulate", template: { ref: "order_ready|en" }, values: { "header.1": "#1", "body.1": "Asha", "body.2": "Pune" } };
    const ok = await request(app).post("/api/whatsapp/test-send").send({ ...body, number: "098765 43210" });
    expect(ok.body).toMatchObject({ mode: "simulate", number: "919876543210", messageId: expect.stringMatching(/^wamid\.SIM/) });
    const badNumber = await request(app).post("/api/whatsapp/test-send").send({ ...body, number: "123" });
    expect(badNumber.body.error).toMatch(/Expected 10 digits/);
    const missingValue = await request(app).post("/api/whatsapp/test-send").send({ ...body, values: {}, number: "9876543210" });
    expect(missingValue.body.error).toMatch(/Missing value/);
  });

  it("guards live sends: provider set up, opt-in confirmed, one at a time", async () => {
    const { app, upload } = await setup();
    const id = await upload();
    const noOptIn = await request(app).post("/api/whatsapp/campaigns").send(base(id, { mode: "live" }));
    expect(noOptIn.body.error).toMatch(/agreed to get WhatsApp messages/);
    const notSetUp = await request(app).post("/api/whatsapp/campaigns").send(base(id, { mode: "live", optInConfirmed: true }));
    expect(notSetUp.body.error).toMatch(/WHATSAPP_META_TOKEN/);
  });

  it("sends live, records sends, skips them next time and resends the rest", async () => {
    let failRavi = true;
    const meta = fakeMeta((to) => (to === "919820011223" && failRavi ? metaApiError(400, { error: { code: 131000, message: "x" } }, "") : `wamid.${to}`));
    const { app, store, ledger, upload } = await setup({ meta });
    const id = await upload();

    const first = await request(app).post("/api/whatsapp/campaigns").send(base(id, { mode: "live", optInConfirmed: true }));
    await store.waitFor(first.body.id);
    const view = (await request(app).get(`/api/whatsapp/campaigns/${first.body.id}`)).body;
    expect(view).toMatchObject({ status: "completed_with_errors", counts: { accepted: 1, failed: 1 }, resendable: 1 });
    expect(view.errors[0]).toMatchObject({ code: 131000, count: 1 });
    expect([...ledger.contactsLast24h()]).toEqual(["919876543210"]);

    failRavi = false;
    const resend = await request(app).post(`/api/whatsapp/campaigns/${first.body.id}/resend`).send({ optInConfirmed: true });
    expect(resend.status).toBe(202);
    await store.waitFor(resend.body.id);
    const second = (await request(app).get(`/api/whatsapp/campaigns/${resend.body.id}`)).body;
    expect(second).toMatchObject({ parentId: first.body.id, counts: { total: 1, accepted: 1 } });

    const third = await request(app).post("/api/whatsapp/campaigns").send(base(id, { mode: "live", optInConfirmed: true }));
    expect(third.body.error).toMatch(/Nobody to send to/);
    const preflight = await request(app).post("/api/whatsapp/preflight").send(base(id, { mode: "live" }));
    expect(preflight.body.skippedByReason).toMatchObject({ recent: 2, values: 1 });
  });

  it("uploads header images to Meta once and reuses the ID", async () => {
    const meta = fakeMeta();
    let uploads = 0;
    meta.uploadMedia = async () => `MEDIA-${++uploads}`;
    const { app, store, upload } = await setup({ meta });
    const png = await request(app).post("/api/whatsapp/media").attach("file", PNG, "offer.png");
    const offer = {
      template: { ref: "festival_offer|en" },
      mapping: { "body.1": { column: 0 }, "body.2": { fixed: "Diwali" }, "body.3": { fixed: "20%" }, "button.0": { fixed: "diwali" } },
      mediaRef: png.body.ref,
      mode: "live",
      optInConfirmed: true,
      skipRecent: false,
    };
    const id = await upload();
    for (let i = 0; i < 2; i++) {
      const start = await request(app).post("/api/whatsapp/campaigns").send(base(id, offer));
      await store.waitFor(start.body.id);
    }
    expect(uploads).toBe(1);
    expect(meta.sent.every((b) => b.media?.id === "MEDIA-1")).toBe(true);
  });

  it("refuses a second campaign while one is sending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const meta = fakeMeta();
    const send = meta.send.bind(meta);
    meta.send = async (b) => {
      await gate;
      return send(b);
    };
    const { app, store, upload } = await setup({ meta });
    const id = await upload();
    const first = await request(app).post("/api/whatsapp/campaigns").send(base(id, { mode: "live", optInConfirmed: true }));
    const second = await request(app).post("/api/whatsapp/campaigns").send(base(id, { mode: "simulate" }));
    expect(second.status).toBe(409);
    const cancel = await request(app).post(`/api/whatsapp/campaigns/${first.body.id}/cancel`);
    expect(cancel.body).toEqual({ ok: true });
    release();
    await store.waitFor(first.body.id);
    expect((await request(app).get(`/api/whatsapp/campaigns/${first.body.id}`)).body.status).toBe("cancelled");
  });
});

describe("WhatsApp webhook", () => {
  const env = { WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-me", WHATSAPP_META_APP_SECRET: "app-secret", PUBLIC_WEBHOOK_HOST: "abc.trycloudflare.com" };
  const sign = (body: string) => `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;

  it("answers Meta's verification challenge", async () => {
    const { app } = await setup({ env });
    const ok = await request(app).get("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345");
    expect(ok.text).toBe("12345");
    const wrong = await request(app).get("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1");
    expect(wrong.status).toBe(403);
  });

  it("rejects receipts without a valid signature", async () => {
    const { app } = await setup({ env });
    const body = JSON.stringify({ entry: [] });
    const unsigned = await request(app).post("/webhooks/whatsapp").set("content-type", "application/json").send(body);
    expect(unsigned.status).toBe(401);
    const forged = await request(app).post("/webhooks/whatsapp").set("content-type", "application/json").set("x-hub-signature-256", "sha256=00").send(body);
    expect(forged.status).toBe(401);
  });

  it("is off unless configured", async () => {
    const { app } = await setup();
    expect((await request(app).get("/webhooks/whatsapp?hub.mode=subscribe")).status).toBe(404);
    expect((await request(app).post("/webhooks/whatsapp").send("{}")).status).toBe(503);
  });

  it("applies delivery receipts and STOP replies", async () => {
    const meta = fakeMeta();
    const { app, store, ledger, upload } = await setup({ env, meta });
    const start = await request(app).post("/api/whatsapp/campaigns").send(base(await upload(), { mode: "live", optInConfirmed: true }));
    await store.waitFor(start.body.id);

    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  { id: "wamid.919876543210", status: "read" },
                  { id: "wamid.919876543210", status: "delivered" },
                  { id: "wamid.919820011223", status: "failed", errors: [{ code: 131026, title: "Undeliverable" }] },
                ],
                messages: [{ from: "919876543210", type: "text", text: { body: " STOP " } }],
              },
            },
          ],
        },
      ],
    });
    const res = await request(app)
      .post("/webhooks/whatsapp")
      .set("host", "abc.trycloudflare.com")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sign(body))
      .send(body);
    expect(res.status).toBe(200);

    const view = (await request(app).get(`/api/whatsapp/campaigns/${start.body.id}`)).body;
    expect(view.deliveries).toEqual({ sent: 0, delivered: 0, read: 1, failed: 1 });
    expect(ledger.isOptedOut("919876543210")).toBe(true);
    expect(ledger.deliveryStatus("wamid.919820011223")).toMatchObject({ status: "failed", errorCode: 131026 });
  });

  it("lets the public tunnel host reach only the webhook", async () => {
    const { app } = await setup({ env });
    const api = await request(app).get("/api/whatsapp/config").set("host", "abc.trycloudflare.com");
    expect(api.status).toBe(403);
    const hook = await request(app).get("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=7").set("host", "abc.trycloudflare.com");
    expect(hook.text).toBe("7");
  });
});
