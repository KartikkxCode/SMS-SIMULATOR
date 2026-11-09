import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../..");

// Every setting the app reads. Blank ones stop a developer's own .env (and real keys) leaking into tests.
const SETTINGS = [
  "ALLOWED_HOSTS", "BATCH_DELAY_MS", "BATCH_SIZE", "DEFAULT_COUNTRY_CODE", "MSG91_API_URL", "MSG91_AUTH_KEY",
  "MSG91_TEMPLATE_ID", "MSG91_WHATSAPP_API_URL", "MSG91_WHATSAPP_NUMBER", "PUBLIC_WEBHOOK_HOST", "WHATSAPP_DAILY_LIMIT",
  "WHATSAPP_MARKETING_ENDPOINT", "WHATSAPP_META_API_URL", "WHATSAPP_META_API_VERSION", "WHATSAPP_META_APP_SECRET",
  "WHATSAPP_META_PHONE_NUMBER_ID", "WHATSAPP_META_TOKEN", "WHATSAPP_META_WABA_ID", "WHATSAPP_MSG91_CHUNK",
  "WHATSAPP_PRICE_PER_MESSAGE", "WHATSAPP_RATE_PER_SEC", "WHATSAPP_SIMULATE_ERRORS", "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
];

export type RunningApp = {
  url: string;
  port: number;
  pid: number;
  dataDir: string;
  reportsDir: string;
  logs(): string;
  /** Stops the app with `signal` (SIGTERM by default; SIGINT is Ctrl+C, SIGKILL a crash) and waits for it to exit. */
  stop(signal?: NodeJS.Signals): Promise<void>;
};

export type StartOptions = {
  /** Files written into the data folder before the app starts (e.g. an opt-out list). */
  files?: Record<string, string>;
  /** Reuse a data folder, e.g. to restart after a crash. */
  dataDir?: string;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Starts the built app (`npm run build` first) with its own data and report folders. */
export async function startApp(env: Record<string, string> = {}, options: StartOptions = {}): Promise<RunningApp> {
  const { files = {} } = options;
  const dataDir = options.dataDir ?? (await mkdtemp(path.join(tmpdir(), "e2e-data-")));
  const reportsDir = await mkdtemp(path.join(tmpdir(), "e2e-reports-"));
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dataDir, name), text);
  const port = await freePort();
  const blank = Object.fromEntries(SETTINGS.map((k) => [k, ""]));
  const child = spawn(process.execPath, ["server/dist/index.js"], {
    cwd: ROOT,
    env: { ...process.env, ...blank, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, REPORTS_DIR: reportsDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/config`)).ok) break;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`The app didn't start:\n${output}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    url,
    port,
    pid: child.pid!,
    dataDir,
    reportsDir,
    logs: () => output,
    stop: async (signal: NodeJS.Signals = "SIGTERM") => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      await exited;
    },
  };
}
