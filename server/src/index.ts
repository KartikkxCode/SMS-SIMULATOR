import path from "node:path";
import { createApp } from "./app.js";
import { ROOT_DIR, loadConfig, loadEnvFile } from "./config.js";
import { CampaignStore } from "./services/campaignRunner.js";

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
const app = createApp({ config, campaigns, clientDir: path.join(ROOT_DIR, "client", "dist") });

const server = app.listen(config.port, config.host, () => {
  console.log(`\n  SMS Simulator is running → http://localhost:${config.port}\n`);
  console.log(
    config.msg91AuthKey
      ? "  Live mode: ready (MSG91_AUTH_KEY is set)"
      : "  Live mode: off. Add MSG91_AUTH_KEY to .env to send real SMS. Simulate mode works now.",
  );
  console.log(`  Reports are saved in ${config.reportsDir}\n`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${config.port} is already in use. Close the other program or set PORT=... in .env.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
