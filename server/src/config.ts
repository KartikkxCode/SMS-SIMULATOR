import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

// server/src (dev) and server/dist (built) are both two levels below the project root.
export const ROOT_DIR = path.resolve(import.meta.dirname, "../..");

const envSchema = z.object({
  MSG91_AUTH_KEY: z.string().trim().default(""),
  MSG91_TEMPLATE_ID: z.string().trim().default(""),
  MSG91_API_URL: z.url().default("https://control.msg91.com/api/v5/flow"),
  DEFAULT_COUNTRY_CODE: z
    .string()
    .trim()
    .regex(/^\d{1,4}$/, "DEFAULT_COUNTRY_CODE must be digits only, e.g. 91")
    .default("91"),
  BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  BATCH_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(500),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().trim().default("127.0.0.1"),
  // Extra host names allowed in the Host header, comma separated (localhost is always allowed).
  ALLOWED_HOSTS: z.string().default(""),
  REPORTS_DIR: z.string().default(path.join(ROOT_DIR, "reports")),
  DATA_DIR: z.string().default(path.join(ROOT_DIR, "data")),

  // WhatsApp through Meta's Cloud API
  WHATSAPP_META_TOKEN: z.string().trim().default(""),
  WHATSAPP_META_PHONE_NUMBER_ID: z.string().trim().default(""),
  WHATSAPP_META_WABA_ID: z.string().trim().default(""),
  WHATSAPP_META_API_VERSION: z
    .string()
    .trim()
    .regex(/^v\d+\.\d+$/, "WHATSAPP_META_API_VERSION looks like v26.0")
    .default("v26.0"),
  WHATSAPP_META_API_URL: z.url().default("https://graph.facebook.com"),
  WHATSAPP_META_APP_SECRET: z.string().trim().default(""),
  WHATSAPP_MARKETING_ENDPOINT: z.enum(["auto", "messages", "marketing_messages"]).default("auto"),
  // WhatsApp through MSG91 (uses MSG91_AUTH_KEY)
  MSG91_WHATSAPP_NUMBER: z.string().trim().regex(/^\d*$/, "MSG91_WHATSAPP_NUMBER must be digits only, e.g. 919876543210").default(""),
  MSG91_WHATSAPP_API_URL: z.url().default("https://api.msg91.com/api/v5/whatsapp"),
  WHATSAPP_MSG91_CHUNK: z.coerce.number().int().min(1).max(1000).default(100),
  // Sending limits
  WHATSAPP_RATE_PER_SEC: z.coerce.number().min(0.1).max(80).default(20),
  WHATSAPP_DAILY_LIMIT: z.coerce.number().int().min(0).default(250),
  WHATSAPP_PRICE_PER_MESSAGE: z.coerce.number().min(0).optional(),
  // Delivery receipts (optional)
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().trim().default(""),
  PUBLIC_WEBHOOK_HOST: z.string().trim().toLowerCase().default(""),
  // Simulate mode: fake some errors, e.g. "131026:0.05,130429:0.02"
  WHATSAPP_SIMULATE_ERRORS: z
    .string()
    .trim()
    .regex(/^(\d+:(0|1|0?\.\d+)(,\d+:(0|1|0?\.\d+))*)?$/, "WHATSAPP_SIMULATE_ERRORS looks like 131026:0.05,130429:0.02")
    .default(""),
});

export type WhatsAppConfig = {
  meta: {
    token: string;
    phoneNumberId: string;
    wabaId: string;
    apiVersion: string;
    apiUrl: string;
    appSecret: string;
    marketingEndpoint: "auto" | "messages" | "marketing_messages";
  };
  msg91: { authKey: string; integratedNumber: string; apiUrl: string; chunkSize: number };
  ratePerSec: number;
  /** Unique contacts per 24 hours; 0 means no limit. */
  dailyLimit: number;
  pricePerMessage?: number;
  webhookVerifyToken: string;
  publicWebhookHost: string;
  simulateErrors: Array<{ code: number; rate: number }>;
};

export type Config = {
  msg91AuthKey: string;
  msg91TemplateId: string;
  msg91ApiUrl: string;
  defaultCountryCode: string;
  batchSize: number;
  batchDelayMs: number;
  port: number;
  host: string;
  allowedHosts: string[];
  reportsDir: string;
  dataDir: string;
  whatsapp: WhatsAppConfig;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // A blank line like `WHATSAPP_DAILY_LIMIT=` means "use the default", not 0.
  const given = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = envSchema.safeParse(given);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid settings in .env:\n${problems}`);
  }
  const e = parsed.data;
  return {
    msg91AuthKey: e.MSG91_AUTH_KEY,
    msg91TemplateId: e.MSG91_TEMPLATE_ID,
    msg91ApiUrl: e.MSG91_API_URL,
    defaultCountryCode: e.DEFAULT_COUNTRY_CODE,
    batchSize: e.BATCH_SIZE,
    batchDelayMs: e.BATCH_DELAY_MS,
    port: e.PORT,
    host: e.HOST,
    allowedHosts: e.ALLOWED_HOSTS.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    reportsDir: path.resolve(e.REPORTS_DIR),
    dataDir: path.resolve(e.DATA_DIR),
    whatsapp: {
      meta: {
        token: e.WHATSAPP_META_TOKEN,
        phoneNumberId: e.WHATSAPP_META_PHONE_NUMBER_ID,
        wabaId: e.WHATSAPP_META_WABA_ID,
        apiVersion: e.WHATSAPP_META_API_VERSION,
        apiUrl: e.WHATSAPP_META_API_URL.replace(/\/+$/, ""),
        appSecret: e.WHATSAPP_META_APP_SECRET,
        marketingEndpoint: e.WHATSAPP_MARKETING_ENDPOINT,
      },
      msg91: {
        authKey: e.MSG91_AUTH_KEY,
        integratedNumber: e.MSG91_WHATSAPP_NUMBER,
        apiUrl: e.MSG91_WHATSAPP_API_URL.replace(/\/+$/, ""),
        chunkSize: e.WHATSAPP_MSG91_CHUNK,
      },
      ratePerSec: e.WHATSAPP_RATE_PER_SEC,
      dailyLimit: e.WHATSAPP_DAILY_LIMIT,
      pricePerMessage: e.WHATSAPP_PRICE_PER_MESSAGE,
      webhookVerifyToken: e.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
      publicWebhookHost: e.PUBLIC_WEBHOOK_HOST,
      simulateErrors: e.WHATSAPP_SIMULATE_ERRORS
        ? e.WHATSAPP_SIMULATE_ERRORS.split(",").map((pair) => {
            const [code, rate] = pair.split(":");
            return { code: Number(code), rate: Number(rate) };
          })
        : [],
    },
  };
}

/** Loads `<project root>/.env` into process.env if it exists. Values already set in the environment win. */
export function loadEnvFile(): void {
  const envFile = path.join(ROOT_DIR, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}
