import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("treats blank settings as unset, so defaults apply", () => {
    const c = loadConfig({ WHATSAPP_DAILY_LIMIT: "", WHATSAPP_PRICE_PER_MESSAGE: " ", PORT: "", BATCH_SIZE: "" });
    expect(c.whatsapp.dailyLimit).toBe(250);
    expect(c.whatsapp.pricePerMessage).toBeUndefined();
    expect(c.port).toBe(3000);
    expect(c.batchSize).toBe(100);
  });

  it("reads .env.example as shipped", () => {
    const example = parseEnv(readFileSync(path.join(import.meta.dirname, "../../.env.example"), "utf8"));
    const c = loadConfig(example);
    expect(c.msg91AuthKey).toBe("");
    expect(c.whatsapp).toMatchObject({
      dailyLimit: 250,
      ratePerSec: 20,
      pricePerMessage: undefined,
      meta: { apiVersion: "v26.0", marketingEndpoint: "auto" },
      msg91: { chunkSize: 100 },
    });
  });

  it("parses WhatsApp settings", () => {
    const c = loadConfig({
      WHATSAPP_DAILY_LIMIT: "0",
      WHATSAPP_PRICE_PER_MESSAGE: "0.86",
      WHATSAPP_SIMULATE_ERRORS: "131026:0.05,130429:.02",
      WHATSAPP_META_API_URL: "http://127.0.0.1:4020/",
      PUBLIC_WEBHOOK_HOST: "ABC.trycloudflare.com",
    });
    expect(c.whatsapp).toMatchObject({
      dailyLimit: 0,
      pricePerMessage: 0.86,
      simulateErrors: [
        { code: 131026, rate: 0.05 },
        { code: 130429, rate: 0.02 },
      ],
      meta: { apiUrl: "http://127.0.0.1:4020" },
      publicWebhookHost: "abc.trycloudflare.com",
    });
  });

  it.each([
    [{ WHATSAPP_META_API_VERSION: "26" }, /WHATSAPP_META_API_VERSION looks like v26.0/],
    [{ WHATSAPP_MARKETING_ENDPOINT: "both" }, /WHATSAPP_MARKETING_ENDPOINT/],
    [{ MSG91_WHATSAPP_NUMBER: "+91 90000" }, /digits only/],
    [{ WHATSAPP_RATE_PER_SEC: "500" }, /WHATSAPP_RATE_PER_SEC/],
    [{ WHATSAPP_SIMULATE_ERRORS: "lots" }, /WHATSAPP_SIMULATE_ERRORS looks like/],
  ])("explains a bad setting (%o)", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
