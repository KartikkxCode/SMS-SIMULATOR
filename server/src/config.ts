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
});

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
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
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
  };
}

/** Loads `<project root>/.env` into process.env if it exists. Values already set in the environment win. */
export function loadEnvFile(): void {
  const envFile = path.join(ROOT_DIR, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}
