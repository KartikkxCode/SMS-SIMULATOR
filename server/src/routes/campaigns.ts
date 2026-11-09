import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import { HttpError } from "../http.js";
import { CampaignStore, campaignCounts, campaignReportCsv, type Campaign } from "../services/campaignRunner.js";
import { normalizePhone } from "../services/phone.js";
import { SmsApiError, type SendMode, type SmsProvider } from "../services/sms.js";
import { contactsFor, type UploadStore } from "./uploads.js";

const SIMULATED_TEMPLATE_ID = "SIMULATED-TEMPLATE";

const sendOptions = z.object({
  mode: z.enum(["simulate", "live"]),
  templateId: z.string().trim().max(100).default(""),
  variables: z
    .record(
      z.string().regex(/^[A-Za-z0-9_]{1,40}$/, "Variable names can only use letters, digits and _"),
      z.string().max(500),
    )
    .default({}),
});

const testSendBody = sendOptions.extend({ number: z.string().trim().min(1, "Enter a phone number").max(30) });

const campaignBody = sendOptions.extend({
  uploadId: z.string().min(1),
  column: z.number().int().min(0),
  message: z.string().max(2000).default(""),
});

export function campaignsRouter(
  campaigns: CampaignStore,
  uploads: UploadStore,
  config: Config,
  providerFor: (mode: SendMode) => SmsProvider,
): Router {
  const router = Router();

  function templateIdFor(mode: SendMode, templateId: string): string {
    if (mode === "live") {
      if (!config.msg91AuthKey) {
        throw new HttpError(400, "Live mode needs MSG91_AUTH_KEY in the .env file. Add it and restart the app.");
      }
      if (!templateId) throw new HttpError(400, "Enter the MSG91 template ID.");
    }
    return templateId || SIMULATED_TEMPLATE_ID;
  }

  router.post("/test-send", async (req, res) => {
    const body = testSendBody.parse(req.body ?? {});
    const templateId = templateIdFor(body.mode, body.templateId);
    const phone = normalizePhone(body.number, config.defaultCountryCode);
    if (!phone.ok) throw new HttpError(400, `That number can't be used: ${phone.reason}.`);
    try {
      const result = await providerFor(body.mode).sendBatch({ templateId, numbers: [phone.number], variables: body.variables });
      res.json({ mode: body.mode, number: phone.number, requestId: result.requestId, payload: result.payload });
    } catch (err) {
      if (err instanceof SmsApiError) throw new HttpError(502, err.message);
      throw err;
    }
  });

  router.post("/campaigns", (req, res) => {
    const body = campaignBody.parse(req.body ?? {});
    const templateId = templateIdFor(body.mode, body.templateId);
    const upload = uploads.get(body.uploadId);
    const { valid } = contactsFor(upload, body.column, config.defaultCountryCode);
    if (valid.length === 0) throw new HttpError(400, "There are no valid phone numbers to send to.");
    if (campaigns.isBusy()) {
      throw new HttpError(409, "Another campaign is still sending. Wait for it to finish or cancel it first.");
    }
    const campaign = campaigns.start({
      provider: providerFor(body.mode),
      templateId,
      variables: body.variables,
      message: body.message,
      fileName: upload.fileName,
      recipients: valid,
    });
    res.status(202).json({ id: campaign.id });
  });

  router.get("/campaigns/:id", (req, res) => {
    res.json(campaignView(find(campaigns, req.params.id)));
  });

  router.post("/campaigns/:id/cancel", (req, res) => {
    find(campaigns, req.params.id);
    if (!campaigns.cancel(req.params.id)) throw new HttpError(409, "This campaign has already finished.");
    res.json({ ok: true });
  });

  router.get("/campaigns/:id/report.csv", (req, res) => {
    const campaign = find(campaigns, req.params.id);
    const name = `sms-report-${campaign.mode}-${campaign.createdAt.slice(0, 10)}.csv`;
    res.attachment(name).type("text/csv").send(campaignReportCsv(campaign));
  });

  return router;
}

function find(campaigns: CampaignStore, id: string): Campaign {
  const campaign = campaigns.get(id);
  if (!campaign) throw new HttpError(404, "Campaign not found. It may have been lost when the app restarted.");
  return campaign;
}

/** What the browser needs to show progress (the full recipient list stays on the server). */
function campaignView(c: Campaign) {
  return {
    id: c.id,
    mode: c.mode,
    status: c.status,
    stopReason: c.stopReason,
    templateId: c.templateId,
    variables: c.variables,
    message: c.message,
    fileName: c.fileName,
    createdAt: c.createdAt,
    finishedAt: c.finishedAt,
    counts: campaignCounts(c),
    batches: c.batches.map((b) => ({
      index: b.index,
      size: b.end - b.start,
      status: b.status,
      attempts: b.attempts,
      requestId: b.requestId,
      error: b.error,
    })),
    samplePayload: c.samplePayload && {
      ...c.samplePayload,
      recipients: c.samplePayload.recipients.slice(0, 3),
    },
    samplePayloadRecipients: c.samplePayload?.recipients.length ?? 0,
    reportSaved: Boolean(c.reportFile),
  };
}
