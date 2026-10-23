import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import type { Config } from "./config.js";
import { errorHandler, hostCheck } from "./http.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { UploadStore, uploadsRouter } from "./routes/uploads.js";
import type { CampaignStore } from "./services/campaignRunner.js";
import { Msg91Provider, SimulatedProvider, type SendMode, type SmsProvider } from "./services/sms.js";

export type AppDeps = {
  config: Config;
  campaigns: CampaignStore;
  uploads?: UploadStore;
  providerFor?: (mode: SendMode) => SmsProvider;
  /** Built React app to serve (client/dist). Skipped if it doesn't exist, e.g. during `npm run dev`. */
  clientDir?: string;
};

export function createApp({ config, campaigns, uploads = new UploadStore(), providerFor, clientDir }: AppDeps): Express {
  const provider =
    providerFor ??
    ((mode: SendMode) =>
      mode === "live" ? new Msg91Provider(config.msg91AuthKey, config.msg91ApiUrl) : new SimulatedProvider());

  const app = express();
  app.disable("x-powered-by");
  app.use(hostCheck(config.allowedHosts));
  app.use(express.json({ limit: "100kb" }));

  const api = express.Router();
  api.get("/config", (_req, res) => {
    res.json({
      liveAvailable: Boolean(config.msg91AuthKey),
      defaultTemplateId: config.msg91TemplateId,
      defaultCountryCode: config.defaultCountryCode,
      batchSize: config.batchSize,
    });
  });
  api.use(uploadsRouter(uploads, config));
  api.use(campaignsRouter(campaigns, uploads, config, provider));
  api.use((_req, res) => {
    res.status(404).json({ error: "Unknown API route." });
  });
  app.use("/api", api);

  const indexFile = clientDir && path.join(clientDir, "index.html");
  if (clientDir && indexFile && existsSync(indexFile)) {
    app.use(express.static(clientDir));
    app.use((req, res, next) => (req.method === "GET" ? res.sendFile(indexFile) : next()));
  }

  app.use(errorHandler);
  return app;
}
