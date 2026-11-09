import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { HttpError } from "../../src/http.js";
import { CampaignStore } from "../../src/services/campaignRunner.js";
import { WaApiError, httpError, metaApiError, networkError } from "../../src/whatsapp/errors.js";
import { WaLedger } from "../../src/whatsapp/ledger.js";
import { MediaStore, checkMediaLink, mediaForProvider } from "../../src/whatsapp/media.js";
import { WaProviders } from "../../src/whatsapp/providers/index.js";
import { MetaProvider } from "../../src/whatsapp/providers/meta.js";
import { Msg91WaProvider } from "../../src/whatsapp/providers/msg91.js";
import { SimulatedWaProvider } from "../../src/whatsapp/providers/simulated.js";
import type { FetchLike, ItemResult, WaProvider } from "../../src/whatsapp/providers/types.js";
import { WaCampaignStore, waReportCsv, type WaRecipient } from "../../src/whatsapp/runner.js";
import { demoTemplates } from "../../src/whatsapp/templates.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "wa-gaps-"));
const demo = (name: string) => demoTemplates().find((t) => t.name === name)!;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

function fakeProvider(id: "meta" | "msg91", overrides: Partial<WaProvider> = {}): WaProvider {
  return {
    id,
    mode: "live",
    maxPerRequest: 1,
    listTemplates: async () => demoTemplates(),
    preview: () => ({}),
    send: async (b) => b.items.map((i): ItemResult => ({ index: i.index, ok: true, messageId: `wamid.${i.to}` })),
    ...overrides,
  };
}

async function setup(opts: { env?: Record<string, string>; meta?: WaProvider; msg91?: WaProvider; store?: WaCampaignStore } = {}) {
  const config = loadConfig({ REPORTS_DIR: "unused", ...opts.env });
  const ledger = await new WaLedger(await tmp()).load();
  const store = opts.store ?? new WaCampaignStore({ ratePerSec: 80, ledger, retryDelaysMs: [1, 1, 1], retryLaterMs: 1 });
  const overrides = { ...(opts.meta ? { meta: opts.meta } : {}), ...(opts.msg91 ? { msg91: opts.msg91 } : {}) };
  const providers = new WaProviders(config.whatsapp, undefined, 0, overrides);
  const app = createApp({ config, campaigns: new CampaignStore({ batchSize: 100, batchDelayMs: 0 }), whatsapp: { store, ledger, providers } });
  const contacts = [
    { name: "Asha", phone: "9876543210" },
    { name: "Ravi", phone: "9123456789" },
  ];
  const upload = async () => (await request(app).post("/api/upload/manual").send({ contacts })).body.uploadId as string;
  return { app, store, ledger, upload };
}

const order = (uploadId: string, extra: Record<string, unknown> = {}) => ({
  uploadId,
  column: 1,
  provider: "meta",
  mode: "simulate",
  template: { ref: "order_ready|en" },
  mapping: { "header.1": { fixed: "#1" }, "body.1": { column: 0 }, "body.2": { fixed: "Pune" } },
  ...extra,
});

describe("WhatsApp routes: edge cases", () => {
  it("shows why the number's status couldn't be read", async () => {
    const meta = fakeProvider("meta", { phoneInfo: async () => Promise.reject(new Error("Meta is down")) });
    const { app } = await setup({ meta });
    const res = await request(app).get("/api/whatsapp/config");
    expect(res.body).toMatchObject({ phoneError: "Meta is down", dailyLimit: 250 });
  });

  it("uses Meta's messaging tier as the daily limit when available", async () => {
    const meta = fakeProvider("meta", { phoneInfo: async () => ({ tier: "TIER_2K", dailyLimit: 2000, quality: "GREEN" }) });
    const { app } = await setup({ meta });
    expect((await request(app).get("/api/whatsapp/config")).body).toMatchObject({ dailyLimit: 2000, phone: { quality: "GREEN" } });
  });

  it("picks MSG91 as the default when it's the only provider set up", async () => {
    const { app } = await setup({ msg91: fakeProvider("msg91") });
    expect((await request(app).get("/api/whatsapp/config")).body.defaultProvider).toBe("msg91");
  });

  it("explains a failed template list as 502", async () => {
    const meta = fakeProvider("meta", { listTemplates: async () => Promise.reject(new WaApiError("token expired", { action: "stop", code: 190 })) });
    const { app } = await setup({ meta });
    const res = await request(app).get("/api/whatsapp/templates?provider=meta");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Couldn't load templates: token expired");
    expect((await request(app).get("/api/whatsapp/templates?provider=other")).status).toBe(400);
  });

  it("handles media requests without a file, for links, and over the size limit", async () => {
    const { app } = await setup();
    expect((await request(app).post("/api/whatsapp/media")).body.error).toMatch(/Choose an image or PDF/);
    expect((await request(app).get("/api/whatsapp/media/nope")).status).toBe(404);
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const res = await request(app).post("/api/whatsapp/media").attach("file", big, "big.png");
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("Images can be up to 5 MB.");
  });

  it("estimates cost with a price set, and expires old checks", async () => {
    const { app, upload } = await setup({ env: { WHATSAPP_PRICE_PER_MESSAGE: "0.8631" } });
    const res = await request(app).post("/api/whatsapp/preflight").send(order(await upload()));
    expect(res.body.estimate).toEqual({ messages: 2, cost: 1.73 });
    expect((await request(app).get("/api/whatsapp/preflight/nope/skipped.csv")).status).toBe(404);
  });

  it("reports a failed live test send with WhatsApp's reason", async () => {
    const meta = fakeProvider("meta", {
      send: async (b) => b.items.map((i) => ({ index: i.index, ok: false as const, error: metaApiError(400, { error: { code: 131026, message: "x" } }, "") })),
    });
    const { app } = await setup({ meta });
    const res = await request(app)
      .post("/api/whatsapp/test-send")
      .send({ provider: "meta", mode: "live", template: { ref: "hello_world|en_US" }, number: "9876543210" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/undeliverable/);
  });

  it("guards cancel, resend and lookups of campaigns", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const meta = fakeProvider("meta", {
      send: async (b) => {
        await gate;
        return b.items.map((i) => ({ index: i.index, ok: true as const, messageId: "m" }));
      },
    });
    const { app, store, upload } = await setup({ meta });
    const id = await upload();
    const start = await request(app).post("/api/whatsapp/campaigns").send(order(id, { mode: "live", optInConfirmed: true }));
    await new Promise((r) => setTimeout(r, 20));
    const running = (await request(app).get(`/api/whatsapp/campaigns/${start.body.id}`)).body;
    expect(running.status).toBe("running");
    expect(running.etaSeconds).toBeGreaterThan(0);
    expect((await request(app).post(`/api/whatsapp/campaigns/${start.body.id}/resend`).send({ optInConfirmed: true })).status).toBe(409);
    release();
    await store.waitFor(start.body.id);
    expect((await request(app).post(`/api/whatsapp/campaigns/${start.body.id}/cancel`)).status).toBe(409);
    expect((await request(app).get("/api/whatsapp/campaigns/nope")).status).toBe(404);
    const nobody = await request(app).post(`/api/whatsapp/campaigns/${start.body.id}/resend`).send({ optInConfirmed: true });
    expect(nobody.body.error).toMatch(/nobody left/);
  });

  it("needs opt-in to resend a live campaign, but not a simulation", async () => {
    const meta = fakeProvider("meta", {
      send: async (b) => b.items.map((i) => ({ index: i.index, ok: false as const, error: metaApiError(400, { error: { code: 190, message: "x" } }, "") })),
    });
    const { app, store, upload } = await setup({ meta });
    const id = await upload();
    const live = await request(app).post("/api/whatsapp/campaigns").send(order(id, { mode: "live", optInConfirmed: true }));
    await store.waitFor(live.body.id);
    expect((await request(app).post(`/api/whatsapp/campaigns/${live.body.id}/resend`).send({})).body.error).toMatch(/agreed/);
  });

  it("rejects a signed webhook body that isn't JSON", async () => {
    const env = { WHATSAPP_WEBHOOK_VERIFY_TOKEN: "v", WHATSAPP_META_APP_SECRET: "s" };
    const { app } = await setup({ env });
    const body = "not json";
    const sig = `sha256=${createHmac("sha256", "s").update(body).digest("hex")}`;
    const res = await request(app).post("/webhooks/whatsapp").set("content-type", "text/plain").set("x-hub-signature-256", sig).send(body);
    expect(res.status).toBe(400);
  });
});

describe("media", () => {
  const meta = new SimulatedWaProvider("meta", async () => []);
  const msg91Sim = new SimulatedWaProvider("msg91", async () => []);
  const msg91Live = fakeProvider("msg91");

  it("needs a link for MSG91 live sends, but not for simulations", async () => {
    const store = new MediaStore();
    const file = store.addFile(PNG, "a.png");
    expect(await mediaForProvider(file, msg91Sim)).toEqual({ kind: "image", filename: "a.png" });
    await expect(mediaForProvider(file, msg91Live)).rejects.toThrow(/public link/);
    expect(await mediaForProvider(file, meta)).toMatchObject({ id: expect.stringMatching(/^SIM-MEDIA-/) });
  });

  it("cleans file names and keeps only the newest files", () => {
    const store = new MediaStore(2);
    const a = store.addFile(PNG, "../../etc/passwd.png");
    expect(a.filename).toBe(".._.._etc_passwd.png");
    expect(store.addFile(Buffer.from("%PDF-1.4"), "brochure").filename).toBe("brochure.pdf");
    store.addFile(PNG, "c.png");
    expect(() => store.get(a.ref)).toThrow(HttpError);
  });

  it("checks pasted links", async () => {
    const head = (status: number, headers: Record<string, string> = {}): FetchLike => async () => reply(status, "", headers);
    await expect(checkMediaLink("not a url", "image")).rejects.toThrow(/isn't a valid link/);
    await expect(checkMediaLink("https://x.test/a.png", "image", async () => Promise.reject(new TypeError("fetch failed")))).rejects.toThrow(
      /Couldn't open that link/,
    );
    await expect(checkMediaLink("https://x.test/a.png", "image", head(404))).rejects.toThrow(/HTTP 404/);
    await expect(checkMediaLink("https://x.test/a.png", "image", head(405))).resolves.toBeUndefined();
    await expect(checkMediaLink("https://x.test/a.pdf", "document", head(200, { "content-type": "application/pdf", "content-length": String(17 * 1024 * 1024) }))).rejects.toThrow(
      /too large/,
    );
    await expect(checkMediaLink("https://x.test/a.pdf", "document", head(200, { "content-type": "application/pdf" }))).resolves.toBeUndefined();
  });
});

describe("runner edge cases", () => {
  const contacts = (n: number): WaRecipient[] =>
    Array.from({ length: n }, (_, i) => ({ row: i + 1, number: `91900000000${i}`, values: {}, state: "pending", attempts: 0 }));

  it("stops and marks the message unknown if the provider crashes", async () => {
    const ledger = await new WaLedger(await tmp()).load();
    const store = new WaCampaignStore({ ratePerSec: 80, ledger, maxConcurrency: 1 });
    const provider = fakeProvider("meta", { send: async () => Promise.reject(new Error("socket exploded")) });
    const c = store.start({ provider, template: demo("hello_world"), fileName: "x", recipients: contacts(3) });
    await store.waitFor(c.id);
    expect(c.recipients.map((r) => r.state)).toEqual(["unknown", "not_sent", "not_sent"]);
    expect(c.stopReason).toMatch(/socket exploded/);
    expect(ledger.contactsLast24h().size).toBe(1);
  });

  it("keeps a contact resendable when stopped while waiting to retry", async () => {
    let cancel!: () => void;
    const store = new WaCampaignStore({
      ratePerSec: 80,
      retryDelaysMs: [50],
      clock: { now: Date.now, sleep: async (ms) => (ms === 50 ? cancel() : undefined) },
    });
    const provider = fakeProvider("meta", { send: async (b) => b.items.map((i) => ({ index: i.index, ok: false as const, error: httpError(503, "busy") })) });
    const c = store.start({ provider, template: demo("hello_world"), fileName: "x", recipients: contacts(1) });
    cancel = () => store.cancel(c.id);
    await store.waitFor(c.id);
    expect(c.recipients[0]).toMatchObject({ state: "failed", errorAction: "retry" });
    expect(WaCampaignStore.resendable(c)).toHaveLength(1);
  });

  it("finishes even if the report can't be saved", async () => {
    const file = path.join(await tmp(), "not-a-dir");
    await writeFile(file, "x");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new WaCampaignStore({ ratePerSec: 80, reportsDir: file });
    const c = store.start({ provider: fakeProvider("meta"), template: demo("hello_world"), fileName: "x", recipients: contacts(1) });
    await store.waitFor(c.id);
    expect(c.status).toBe("completed");
    expect(c.reportFile).toBeUndefined();
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("names coupon and link columns in the report", () => {
    const store = new WaCampaignStore({ ratePerSec: 1 });
    const c = store.start({ provider: fakeProvider("meta"), template: demo("welcome_coupon"), fileName: "x", recipients: [] });
    expect(waReportCsv(c)).toContain("{{1}},coupon code");
    const offer = store.start({ provider: fakeProvider("meta"), template: demo("festival_offer"), fileName: "x", recipients: [] });
    expect(waReportCsv(offer)).toContain("{{3}},link button {{1}}");
  });
});

describe("provider response quirks", () => {
  const metaOptions = { token: "t", phoneNumberId: "P", wabaId: "W", apiVersion: "v26.0", apiUrl: "https://g.test", appSecret: "", marketingEndpoint: "auto" as const };
  const hello = { template: demo("hello_world"), items: [{ index: 0, to: "91", values: {} }] };
  const offer = {
    template: demo("festival_offer"),
    items: [{ index: 0, to: "91", values: { "body.1": "a", "body.2": "b", "body.3": "c", "button.0": "d" } }],
    media: { kind: "image" as const, id: "M" },
  };
  const seq = (...replies: Response[]): FetchLike & { urls: string[] } => {
    const urls: string[] = [];
    return Object.assign(async (url: string) => (urls.push(url), replies.shift() ?? reply(200, {})), { urls });
  };

  it("Meta: no media ID, non-JSON success, and a failed switch to the Marketing Messages API", async () => {
    await expect(new MetaProvider(metaOptions, seq(reply(200, {}))).uploadMedia({ buffer: PNG, mimeType: "image/png", filename: "a.png" })).rejects.toMatchObject({
      info: { action: "stop" },
    });
    const [nonJson] = await new MetaProvider(metaOptions, seq(reply(200, "<html>ok</html>"))).send(hello);
    expect(nonJson).toMatchObject({ ok: false, error: { message: expect.stringContaining("Unexpected answer") } });
    const switchFails = seq(
      reply(400, { error: { code: 131063, message: "use MM API" } }),
      reply(400, { error: { code: 100, message: "Not onboarded to Marketing Messages" } }),
    );
    const [failed] = await new MetaProvider(metaOptions, switchFails).send(offer);
    expect(failed).toMatchObject({ ok: false, error: { info: { code: 100 } } });
    expect(switchFails.urls.map((u) => new URL(u).pathname)).toEqual(["/v26.0/P/messages", "/v26.0/P/marketing_messages"]);
  });

  it("Meta: sends marketing templates straight to the Marketing Messages API when set to", async () => {
    const f = seq(reply(200, { messages: [{ id: "w" }] }));
    await new MetaProvider({ ...metaOptions, marketingEndpoint: "marketing_messages" }, f).send(offer);
    expect(new URL(f.urls[0]!).pathname).toBe("/v26.0/P/marketing_messages");
  });

  it("Meta: a number without a tier has no limit from Meta", async () => {
    const info = await new MetaProvider(metaOptions, seq(reply(200, { display_phone_number: "1" }))).phoneInfo();
    expect(info.dailyLimit).toBeUndefined();
  });

  it("MSG91: reads request IDs in several shapes and explains odd answers", async () => {
    const options = { authKey: "A", integratedNumber: "91", apiUrl: "https://m.test", chunkSize: 10 };
    const send = async (r: Response) => (await new Msg91WaProvider(options, seq(r)).send(hello))[0];
    expect(await send(reply(200, { request_id: "TOP" }))).toMatchObject({ ok: true, messageId: "TOP" });
    expect(await send(reply(200, { status: "success", data: "STRING-ID" }))).toMatchObject({ ok: true, messageId: "STRING-ID" });
    expect(await send(reply(200, "<html>"))).toMatchObject({ ok: false, error: { message: "MSG91 rejected the request: <html>" } });
    expect(await send(reply(200, { hasError: true, errors: "Template paused" }))).toMatchObject({
      ok: false,
      error: { message: "MSG91 rejected the request: Template paused" },
    });
    const noLink = await new Msg91WaProvider(options, seq()).send({ ...offer, media: { kind: "image", id: "M" } });
    expect(noLink[0]).toMatchObject({ ok: false, error: { info: { action: "stop" } } });
  });

  it("MSG91: a dropped template-list request is safe to retry", async () => {
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const p = new Msg91WaProvider({ authKey: "A", integratedNumber: "91", apiUrl: "https://m.test", chunkSize: 10 }, async () => Promise.reject(reset));
    await expect(p.listTemplates()).rejects.toMatchObject({ info: { action: "retry" } });
  });

  it("errors: details, 403 and odd network failures", () => {
    expect(metaApiError(400, { error: { code: 131026, error_data: { details: "Recipient not on WhatsApp" } } }, "").message).toContain(
      "Recipient not on WhatsApp",
    );
    expect(httpError(403, "nope").info.action).toBe("stop");
    expect(networkError("weird", "X").message).toContain("weird");
  });
});
