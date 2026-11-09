import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { WaProviders } from "../../src/whatsapp/providers/index.js";
import { MetaProvider } from "../../src/whatsapp/providers/meta.js";
import { Msg91WaProvider } from "../../src/whatsapp/providers/msg91.js";
import { SimulatedWaProvider } from "../../src/whatsapp/providers/simulated.js";
import { demoTemplates } from "../../src/whatsapp/templates.js";

type Call = { url: string; init: RequestInit };
type Reply = { status?: number; body: unknown } | Error;

/** A fetch that records requests and answers from a script. */
function scriptedFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const reply = replies.shift() ?? { body: {} };
    if (reply instanceof Error) throw reply;
    return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  return { calls, fetchImpl };
}

const metaOptions = {
  token: "EAAG-token",
  phoneNumberId: "PHONE1",
  wabaId: "WABA1",
  apiVersion: "v26.0",
  apiUrl: "https://graph.test",
  appSecret: "",
  marketingEndpoint: "auto" as const,
};
const demo = (name: string) => demoTemplates().find((t) => t.name === name)!;
const helloBatch = { template: demo("hello_world"), items: [{ index: 0, to: "919876543210", values: {} }] };
const offer = demo("festival_offer");
const offerValues = { "body.1": "Asha", "body.2": "Diwali", "body.3": "20%", "button.0": "d" };
const offerBatch = { template: offer, items: [{ index: 3, to: "919876543210", values: offerValues }], media: { kind: "image" as const, id: "M1" } };

describe("MetaProvider", () => {
  it("sends a template to /messages with the bearer token", async () => {
    const { calls, fetchImpl } = scriptedFetch([{ body: { messages: [{ id: "wamid.A" }] } }]);
    const results = await new MetaProvider(metaOptions, fetchImpl).send(helloBatch);

    expect(results).toEqual([{ index: 0, ok: true, messageId: "wamid.A" }]);
    expect(calls[0]!.url).toBe("https://graph.test/v26.0/PHONE1/messages");
    expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer EAAG-token", "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ to: "919876543210", template: { name: "hello_world" } });
  });

  it("adds appsecret_proof when an app secret is set", async () => {
    const { calls, fetchImpl } = scriptedFetch([{ body: { messages: [{ id: "wamid.A" }] } }]);
    await new MetaProvider({ ...metaOptions, appSecret: "s3cret" }, fetchImpl).send(helloBatch);
    const proof = createHmac("sha256", "s3cret").update("EAAG-token").digest("hex");
    expect(calls[0]!.url).toBe(`https://graph.test/v26.0/PHONE1/messages?appsecret_proof=${proof}`);
  });

  it("returns WhatsApp errors per contact instead of throwing", async () => {
    const { fetchImpl } = scriptedFetch([{ status: 400, body: { error: { code: 131026, message: "Undeliverable" } } }]);
    const [result] = await new MetaProvider(metaOptions, fetchImpl).send(helloBatch);
    expect(result).toMatchObject({ index: 0, ok: false, error: { info: { action: "fail", code: 131026 } } });
  });

  it("moves marketing templates to /marketing_messages after error 131063", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      { status: 400, body: { error: { code: 131063, message: "Use marketing_messages" } } },
      { body: { messages: [{ id: "wamid.MM1" }] } },
      { body: { messages: [{ id: "wamid.MM2" }] } },
    ]);
    const provider = new MetaProvider(metaOptions, fetchImpl);
    expect(await provider.send(offerBatch)).toEqual([{ index: 3, ok: true, messageId: "wamid.MM1" }]);
    await provider.send(offerBatch);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v26.0/PHONE1/messages",
      "/v26.0/PHONE1/marketing_messages",
      "/v26.0/PHONE1/marketing_messages",
    ]);
  });

  it("keeps utility templates on /messages and respects a fixed endpoint setting", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      { status: 400, body: { error: { code: 131063, message: "x" } } },
      { body: { messages: [{ id: "u" }] } },
    ]);
    const provider = new MetaProvider({ ...metaOptions, marketingEndpoint: "messages" }, fetchImpl);
    expect((await provider.send(offerBatch))[0]).toMatchObject({ ok: false, error: { info: { code: 131063, action: "stop" } } });
    await provider.send(helloBatch);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v26.0/PHONE1/messages", "/v26.0/PHONE1/messages"]);
  });

  it("stops when the header media is missing, without calling WhatsApp", async () => {
    const { calls, fetchImpl } = scriptedFetch([]);
    const [result] = await new MetaProvider(metaOptions, fetchImpl).send({ ...offerBatch, media: undefined });
    expect(result).toMatchObject({ ok: false, error: { info: { action: "stop" } } });
    expect(calls).toHaveLength(0);
  });

  it("marks a send with no answer as unknown, and an answer without an ID too", async () => {
    const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    const { fetchImpl } = scriptedFetch([timeout, { body: {} }]);
    const provider = new MetaProvider(metaOptions, fetchImpl);
    expect((await provider.send(helloBatch))[0]).toMatchObject({ ok: false, error: { info: { ambiguous: true } } });
    expect((await provider.send(helloBatch))[0]).toMatchObject({ ok: false, error: { info: { ambiguous: true } } });
  });

  it("lists templates across pages", async () => {
    const page = (name: string, next: boolean) => ({
      data: [{ name, language: "en", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}}" }] }],
      paging: { cursors: { after: `after-${name}` }, ...(next ? { next: "https://graph.test/next" } : {}) },
    });
    const { calls, fetchImpl } = scriptedFetch([{ body: page("b_second", true) }, { body: page("a_first", false) }]);
    const templates = await new MetaProvider(metaOptions, fetchImpl).listTemplates();
    expect(templates.map((t) => t.name)).toEqual(["a_first", "b_second"]);
    const second = new URL(calls[1]!.url);
    expect(second.pathname).toBe("/v26.0/WABA1/message_templates");
    expect(second.searchParams.get("after")).toBe("after-b_second");
    expect(second.searchParams.get("fields")).toContain("components");
  });

  it("uploads media as multipart and returns its ID", async () => {
    const { calls, fetchImpl } = scriptedFetch([{ body: { id: "MEDIA123" } }]);
    const id = await new MetaProvider(metaOptions, fetchImpl).uploadMedia({ buffer: Buffer.from("img"), mimeType: "image/png", filename: "a.png" });
    expect(id).toBe("MEDIA123");
    expect(calls[0]!.url).toBe("https://graph.test/v26.0/PHONE1/media");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("messaging_product")).toBe("whatsapp");
    expect(form.get("type")).toBe("image/png");
    expect((form.get("file") as File).name).toBe("a.png");
  });

  it("reads the number's quality and messaging limit", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { display_phone_number: "+91 90000 00001", verified_name: "ABC Store", quality_rating: "GREEN", messaging_limit_tier: "TIER_2K" } },
    ]);
    expect(await new MetaProvider(metaOptions, fetchImpl).phoneInfo()).toEqual({
      displayNumber: "+91 90000 00001",
      verifiedName: "ABC Store",
      quality: "GREEN",
      tier: "TIER_2K",
      dailyLimit: 2000,
    });
  });

  it("treats a failed template list request as safe to retry", async () => {
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const { fetchImpl } = scriptedFetch([reset]);
    await expect(new MetaProvider(metaOptions, fetchImpl).listTemplates()).rejects.toMatchObject({ info: { action: "retry" } });
  });
});

describe("Msg91WaProvider", () => {
  const options = { authKey: "AUTH", integratedNumber: "919000000001", apiUrl: "https://msg91.test/api/v5/whatsapp", chunkSize: 2 };
  const order = demo("order_ready");
  const items = [
    { index: 0, to: "919876543210", values: { "header.1": "#1", "body.1": "Asha", "body.2": "Pune" } },
    { index: 1, to: "919123456789", values: { "header.1": "#2", "body.1": "Ravi", "body.2": "Pune" } },
  ];

  it("sends a bulk request and gives every contact the request ID", async () => {
    const { calls, fetchImpl } = scriptedFetch([{ body: { status: "success", hasError: false, data: { request_id: "REQ9" } } }]);
    const results = await new Msg91WaProvider(options, fetchImpl).send({ template: order, items });
    expect(results).toEqual([
      { index: 0, ok: true, messageId: "REQ9" },
      { index: 1, ok: true, messageId: "REQ9" },
    ]);
    expect(calls[0]!.url).toBe("https://msg91.test/api/v5/whatsapp/whatsapp-outbound-message/bulk/");
    expect(calls[0]!.init.headers).toMatchObject({ authkey: "AUTH" });
    expect(JSON.parse(String(calls[0]!.init.body)).payload.template.to_and_components).toHaveLength(2);
  });

  it("fails the whole chunk when MSG91 rejects it", async () => {
    const { fetchImpl } = scriptedFetch([{ body: { status: "fail", message: "Template not found" } }]);
    const results = await new Msg91WaProvider(options, fetchImpl).send({ template: order, items });
    expect(results.map((r) => r.ok)).toEqual([false, false]);
    expect(results[0]).toMatchObject({ error: { message: "MSG91 rejected the request: Template not found", info: { action: "fail" } } });
  });

  it("stops on a rejected auth key and retries server errors", async () => {
    const { fetchImpl } = scriptedFetch([{ status: 401, body: { message: "Unauthorized" } }, { status: 502, body: "Bad gateway" }]);
    const provider = new Msg91WaProvider(options, fetchImpl);
    expect((await provider.send({ template: order, items }))[0]).toMatchObject({ error: { info: { action: "stop" } } });
    expect((await provider.send({ template: order, items }))[0]).toMatchObject({ error: { info: { action: "retry" } } });
  });

  it("reads templates in MSG91's per-language shape and in Meta's shape", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      {
        body: {
          data: [
            {
              name: "promo",
              namespace: "ns1",
              category: "MARKETING",
              languages: [{ language: "hi", status: "APPROVED", code: [{ type: "BODY", text: "नमस्ते {{1}}" }] }],
            },
            { name: "notice", language: "en", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Hi" }] },
          ],
        },
      },
    ]);
    const templates = await new Msg91WaProvider(options, fetchImpl).listTemplates();
    expect(calls[0]!.url).toBe("https://msg91.test/api/v5/whatsapp/get-template-client/919000000001");
    expect(templates.map((t) => [t.ref, t.namespace, t.params.length])).toEqual([
      ["notice|en", undefined, 0],
      ["promo|hi", "ns1", 1],
    ]);
  });

  it("says when the template list can't be read", async () => {
    const { fetchImpl } = scriptedFetch([{ body: { status: "success", data: [{ something: "else" }] } }]);
    await expect(new Msg91WaProvider(options, fetchImpl).listTemplates()).rejects.toThrow(/Enter the template by hand/);
  });
});

describe("SimulatedWaProvider", () => {
  const templates = async () => demoTemplates();

  it("returns fake message IDs and never calls out", async () => {
    const provider = new SimulatedWaProvider("meta", templates, { latencyMs: 0 });
    const [result] = await provider.send(helloBatch);
    expect(result).toMatchObject({ ok: true, messageId: expect.stringMatching(/^wamid\.SIM\./) });
    expect(provider.maxPerRequest).toBe(1);
  });

  it("checks the message against the template", async () => {
    const provider = new SimulatedWaProvider("meta", templates, { latencyMs: 0 });
    const [missingMedia] = await provider.send({ ...offerBatch, media: undefined });
    expect(missingMedia).toMatchObject({ ok: false, error: { info: { action: "stop" } } });
    const [tooLong] = await provider.send({ ...offerBatch, items: [{ index: 0, to: "91", values: { ...offerValues, "body.1": "x".repeat(1100) } }] });
    expect(tooLong).toMatchObject({ ok: false, error: { info: { code: 132005, action: "fail" } } });
  });

  it("injects configured errors at their rates", async () => {
    const rolls = [0.01, 0.07, 0.5];
    const provider = new SimulatedWaProvider("meta", templates, {
      latencyMs: 0,
      errors: [
        { code: 131026, rate: 0.05 },
        { code: 130429, rate: 0.05 },
      ],
      random: () => rolls.shift()!,
    });
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const [r] = await provider.send(helloBatch);
      codes.push(r!.ok ? "ok" : r!.error.info.code);
    }
    expect(codes).toEqual([131026, 130429, "ok"]);
  });

  it("uses MSG91's chunk size and payload shape", async () => {
    const provider = new SimulatedWaProvider("msg91", templates, { latencyMs: 0, msg91ChunkSize: 50 });
    expect(provider.maxPerRequest).toBe(50);
    const preview = provider.preview({ template: offer, items: [{ index: 0, to: "91", values: offerValues }], media: { kind: "image", id: "SIM" } });
    expect(preview).toMatchObject({ integrated_number: "SIMULATED-NUMBER", payload: { template: { name: "festival_offer" } } });
  });
});

describe("WaProviders", () => {
  it("uses demo templates and refuses live sends until a provider is set up", async () => {
    const providers = new WaProviders(loadConfig({}).whatsapp);
    expect(providers.isConfigured("meta")).toBe(false);
    expect((await providers.templates("meta")).source).toBe("demo");
    expect(providers.get("meta", "simulate").mode).toBe("simulate");
    expect(() => providers.get("meta", "live")).toThrow(/WHATSAPP_META_TOKEN/);
    expect(() => providers.get("msg91", "live")).toThrow(/MSG91_WHATSAPP_NUMBER/);
  });

  it("remembers a failed number lookup for a minute", async () => {
    const down = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const { calls, fetchImpl } = scriptedFetch([down, down]);
    const config = loadConfig({ WHATSAPP_META_TOKEN: "t", WHATSAPP_META_PHONE_NUMBER_ID: "p", WHATSAPP_META_WABA_ID: "w" }).whatsapp;
    const providers = new WaProviders(config, fetchImpl);
    await expect(providers.phoneInfo()).rejects.toThrow(/Couldn't reach/);
    await expect(providers.phoneInfo()).rejects.toThrow(/Couldn't reach/);
    expect(calls).toHaveLength(1);
  });

  it("caches the real template list for a minute", async () => {
    const { calls, fetchImpl } = scriptedFetch([{ body: { data: [] } }, { body: { data: [] } }]);
    const config = loadConfig({ WHATSAPP_META_TOKEN: "t", WHATSAPP_META_PHONE_NUMBER_ID: "p", WHATSAPP_META_WABA_ID: "w" }).whatsapp;
    const providers = new WaProviders(config, fetchImpl);
    expect(providers.isConfigured("meta")).toBe(true);
    expect((await providers.templates("meta")).source).toBe("meta");
    await providers.templates("meta");
    expect(calls).toHaveLength(1);
    await providers.templates("meta", true);
    expect(calls).toHaveLength(2);
  });
});
