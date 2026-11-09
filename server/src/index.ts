import path from "node:path";
import { createApp } from "./app.js";
import { ROOT_DIR, loadConfig, loadEnvFile } from "./config.js";
import { CampaignStore } from "./services/campaignRunner.js";
import { WaLedger } from "./whatsapp/ledger.js";
import { WaProviders } from "./whatsapp/providers/index.js";
import { WaCampaignStore } from "./whatsapp/runner.js";

loadEnvFile();

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
})();

const campaigns = new CampaignStore({
  batchSize: config.batchSize,
  batchDelayMs: config.batchDelayMs,
  reportsDir: config.reportsDir,
});
const ledger = await new WaLedger(config.dataDir).load();
const whatsapp = {
  ledger,
  providers: new WaProviders(config.whatsapp),
  store: new WaCampaignStore({ ratePerSec: config.whatsapp.ratePerSec, ledger, reportsDir: config.reportsDir }),
};
const app = createApp({ config, campaigns, whatsapp, clientDir: path.join(ROOT_DIR, "client", "dist") });

// On Ctrl+C, let WhatsApp messages already on their way finish and save the report before exiting.
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) process.exit(1);
    closing = true;
    if (whatsapp.store.isBusy()) console.log("\n  Stopping: finishing messages already on their way…");
    void whatsapp.store.shutdown(10_000).finally(() => process.exit(0));
  });
}

// Express 5 calls this with the error if the server can't start (e.g. the port is taken).
app.listen(config.port, config.host, (err?: NodeJS.ErrnoException) => {
  if (err) {
    console.error(
      err.code === "EADDRINUSE"
        ? `Port ${config.port} is already in use. Close the other program or set PORT=... in .env.`
        : err,
    );
    process.exit(1);
  }
  console.log(`\n  SMS Simulator is running → http://localhost:${config.port}\n`);
  console.log(
    config.msg91AuthKey
      ? "  Live mode: ready (MSG91_AUTH_KEY is set)"
      : "  Live mode: off. Add MSG91_AUTH_KEY to .env to send real SMS. Simulate mode works now.",
  );
  const wa = config.whatsapp;
  const waProviders = [
    whatsapp.providers.isConfigured("meta") && "Meta",
    whatsapp.providers.isConfigured("msg91") && "MSG91",
  ].filter(Boolean);
  console.log(
    waProviders.length
      ? `  WhatsApp: ready (${waProviders.join(" and ")})`
      : "  WhatsApp: Simulate only. Add your Meta or MSG91 WhatsApp settings to .env to send real messages.",
  );
  if (wa.webhookVerifyToken && wa.meta.appSecret) {
    console.log(`  WhatsApp delivery receipts: on at /webhooks/whatsapp${wa.publicWebhookHost ? ` (${wa.publicWebhookHost})` : ""}`);
  }
  console.log(`  Reports are saved in ${config.reportsDir}\n`);
});
