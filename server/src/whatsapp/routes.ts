import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import type { Config } from "../config.js";
import { HttpError } from "../http.js";
import { contactsFor, type Upload, type UploadStore } from "../routes/uploads.js";
import { toCsv } from "../services/csv.js";
import { normalizePhone } from "../services/phone.js";
import { WaApiError } from "./errors.js";
import type { WaLedger } from "./ledger.js";
import { MEDIA_LIMITS, MediaStore, checkMediaLink, mediaForProvider } from "./media.js";
import { checkMapping, cleanValue, renderTemplate, validateValues, type ParamMapping } from "./params.js";
import { planRecipients, type Candidate, type Plan } from "./plan.js";
import type { WaProviders } from "./providers/index.js";
import type { FetchLike, PhoneInfo, WaProvider } from "./providers/types.js";
import { WaCampaignStore, errorSummary, waCounts, waReportCsv, type WaCampaign, type WaRecipient } from "./runner.js";
import { manualTemplate } from "./templates.js";
import type { WaMedia, WaProviderId, WaTemplate } from "./types.js";

export type WhatsAppDeps = {
  store: WaCampaignStore;
  ledger: WaLedger;
  providers: WaProviders;
  media?: MediaStore;
  /** Used to check pasted media links. */
  fetchImpl?: FetchLike;
};

const SKIPPED_LIST_LIMIT = 200;
const PREFLIGHT_KEEP = 10;

const manualSchema = z.object({
  name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, "Template names use lowercase letters, digits and _"),
  language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Language codes look like en, hi or en_US"),
  category: z.enum(["MARKETING", "UTILITY"]),
  headerFormat: z.enum(["NONE", "TEXT", "IMAGE", "DOCUMENT"]),
  headerText: z.string().max(60).optional(),
  body: z.string().trim().min(1, "Type the template body").max(1024),
  footer: z.string().max(60).optional(),
  namespace: z.string().trim().max(100).optional(),
});

const templateChoice = z.union([z.object({ ref: z.string().min(1) }), z.object({ manual: manualSchema })]);
const source = z.union([z.object({ column: z.number().int().min(0) }), z.object({ fixed: z.string().max(1024) })]);

const sendBase = z.object({
  provider: z.enum(["meta", "msg91"]),
  mode: z.enum(["simulate", "live"]),
  template: templateChoice,
  mapping: z.record(z.string(), source).default({}),
  mediaRef: z.string().optional(),
});
const planBody = sendBase.extend({
  uploadId: z.string().min(1),
  column: z.number().int().min(0),
  skipRecent: z.boolean().default(true),
});
const campaignBody = planBody.extend({ optInConfirmed: z.boolean().default(false) });
const testBody = sendBase.extend({
  number: z.string().trim().min(1, "Enter a phone number").max(30),
  values: z.record(z.string(), z.string().max(1024)).default({}),
});
const linkBody = z.object({ link: z.string().trim().min(1), kind: z.enum(["image", "document"]), filename: z.string().max(100).optional() });
const resendBody = z.object({ optInConfirmed: z.boolean().default(false) });

export function whatsappRouter(config: Config, uploads: UploadStore, deps: WhatsAppDeps): Router {
  const { store, ledger, providers } = deps;
  const media = deps.media ?? new MediaStore();
  const wa = config.whatsapp;
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_LIMITS.document, files: 1 } });
  const preflights = new Map<string, Plan>();

  async function phone(): Promise<{ info?: PhoneInfo; error?: string }> {
    if (!providers.isConfigured("meta")) return {};
    try {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer in time")), 8000));
      return { info: await Promise.race([providers.phoneInfo(), timeout]) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function dailyLimit(): Promise<number> {
    return (await phone()).info?.dailyLimit ?? wa.dailyLimit;
  }

  async function templateFor(provider: WaProviderId, choice: z.infer<typeof templateChoice>): Promise<WaTemplate> {
    const template =
      "manual" in choice
        ? manualTemplate(choice.manual)
        : (await providers.templates(provider)).templates.find((t) => t.ref === choice.ref);
    if (!template) throw new HttpError(404, "That template wasn't found. Refresh the template list and choose again.");
    if (!template.supported) throw new HttpError(400, `"${template.name}" can't be used: ${template.unsupportedReason}`);
    return template;
  }

  async function mediaFor(template: WaTemplate, mediaRef: string | undefined, provider: WaProvider): Promise<WaMedia | undefined> {
    const needs = template.header.format === "IMAGE" ? "image" : template.header.format === "DOCUMENT" ? "document" : undefined;
    if (!needs) return undefined;
    if (!mediaRef) throw new HttpError(400, `This template needs ${needs === "image" ? "an image" : "a PDF"} for its header. Add one first.`);
    const stored = media.get(mediaRef);
    if (stored.kind !== needs) throw new HttpError(400, `This template's header needs ${needs === "image" ? "an image" : "a PDF"}, not ${stored.kind === "image" ? "an image" : "a PDF"}.`);
    return mediaForProvider(stored, provider);
  }

  function candidates(file: Upload, column: number): Candidate[] {
    const cellsByRow = new Map(file.sheet.rowNumbers.map((row, i) => [row, file.sheet.rows[i]!]));
    return contactsFor(file, column, config.defaultCountryCode).valid.map((c) => ({ ...c, cells: cellsByRow.get(c.row) ?? [] }));
  }

  async function plan(body: z.infer<typeof planBody>, template: WaTemplate): Promise<{ plan: Plan; file: Upload }> {
    const file = uploads.get(body.uploadId);
    const problem = checkMapping(template, body.mapping as ParamMapping, file.sheet.columns.length);
    if (problem) throw new HttpError(400, problem);
    const result = planRecipients({
      template,
      candidates: candidates(file, body.column),
      mapping: body.mapping as ParamMapping,
      columns: file.sheet.columns,
      ledger,
      skipRecent: body.skipRecent,
      dailyLimit: await dailyLimit(),
    });
    return { plan: result, file };
  }

  router.get("/config", async (_req, res) => {
    const { info, error } = await phone();
    const meta = providers.isConfigured("meta");
    const msg91 = providers.isConfigured("msg91");
    res.json({
      providers: { meta: { configured: meta }, msg91: { configured: msg91 } },
      defaultProvider: meta || !msg91 ? "meta" : "msg91",
      phone: info,
      phoneError: error,
      dailyLimit: info?.dailyLimit ?? wa.dailyLimit,
      usedLast24h: ledger.contactsLast24h().size,
      ratePerSec: wa.ratePerSec,
      pricePerMessage: wa.pricePerMessage,
      webhookEnabled: Boolean(wa.webhookVerifyToken && wa.meta.appSecret),
      optOutCount: ledger.optOutCount,
    });
  });

  router.get("/templates", async (req, res) => {
    const provider = z.enum(["meta", "msg91"]).parse(req.query.provider ?? "meta");
    try {
      res.json(await providers.templates(provider, req.query.refresh === "1"));
    } catch (err) {
      if (err instanceof WaApiError) throw new HttpError(502, `Couldn't load templates: ${err.message}`);
      throw err;
    }
  });

  router.post("/media", upload.single("file"), (req, res) => {
    if (!req.file) throw new HttpError(400, "Choose an image or PDF to upload.");
    const saved = media.addFile(req.file.buffer, req.file.originalname);
    res.json({ ref: saved.ref, kind: saved.kind, filename: saved.filename, previewUrl: `/api/whatsapp/media/${saved.ref}` });
  });

  router.post("/media/link", async (req, res) => {
    const body = linkBody.parse(req.body ?? {});
    await checkMediaLink(body.link, body.kind, deps.fetchImpl);
    const saved = media.addLink(body.link, body.kind, body.filename);
    res.json({ ref: saved.ref, kind: saved.kind, filename: saved.filename, previewUrl: saved.kind === "image" ? saved.link : undefined });
  });

  router.get("/media/:ref", (req, res) => {
    const saved = media.get(req.params.ref);
    if (!saved.buffer) throw new HttpError(404, "This file is a link; open it directly.");
    res.type(saved.mimeType).send(saved.buffer);
  });

  router.post("/preflight", async (req, res) => {
    const body = planBody.parse(req.body ?? {});
    const template = await templateFor(body.provider, body.template);
    const { plan: result } = await plan(body, template);
    const id = randomUUID();
    preflights.set(id, result);
    while (preflights.size > PREFLIGHT_KEEP) preflights.delete(preflights.keys().next().value!);

    const ready = result.recipients.filter((r) => r.state === "pending");
    const skipped = result.recipients.filter((r) => r.state === "skipped");
    const bySkip = (reason: string) => skipped.filter((r) => r.skipReason === reason).length;
    res.json({
      preflightId: id,
      ready: ready.length,
      skippedCount: skipped.length,
      skippedByReason: { values: bySkip("values"), opted_out: bySkip("opted_out"), recent: bySkip("recent"), over_limit: bySkip("over_limit") },
      skipped: skipped.slice(0, SKIPPED_LIST_LIMIT).map((r) => ({ row: r.row, number: r.number, reason: r.reason })),
      samples: ready.slice(0, 5).map((r) => ({ row: r.row, number: r.number, values: r.values, rendered: renderTemplate(template, r.values) })),
      warnings: result.warnings,
      estimate: { messages: ready.length, cost: wa.pricePerMessage !== undefined ? round(ready.length * wa.pricePerMessage) : undefined },
      template: { name: template.name, category: template.category, header: template.header.format },
    });
  });

  router.get("/preflight/:id/skipped.csv", (req, res) => {
    const result = preflights.get(req.params.id);
    if (!result) throw new HttpError(404, "This check has expired. Check the contacts again.");
    const rows = result.recipients.filter((r) => r.state === "skipped").map((r) => [r.row, r.number, r.reason]);
    res.attachment("whatsapp-skipped.csv").type("text/csv").send(toCsv(["file_row", "number", "reason"], rows));
  });

  router.post("/test-send", async (req, res) => {
    const body = testBody.parse(req.body ?? {});
    const provider = providers.get(body.provider, body.mode);
    const template = await templateFor(body.provider, body.template);
    const phoneNumber = normalizePhone(body.number, config.defaultCountryCode);
    if (!phoneNumber.ok) throw new HttpError(400, `That number can't be used: ${phoneNumber.reason}.`);
    const values = Object.fromEntries(Object.entries(body.values).map(([k, v]) => [k, cleanValue(v)]));
    const problem = validateValues(template, values);
    if (problem) throw new HttpError(400, problem);
    const batch = { template, media: await mediaFor(template, body.mediaRef, provider), items: [{ index: 0, to: phoneNumber.number, values }] };
    const [result] = await provider.send(batch);
    if (!result?.ok) throw new HttpError(502, result?.error.message ?? "No result from the provider.");
    if (provider.mode === "live") {
      ledger.recordSend({ number: phoneNumber.number, template: template.name, state: "accepted", messageId: result.messageId, campaignId: "test-send" });
    }
    res.json({ mode: provider.mode, number: phoneNumber.number, messageId: result.messageId, payload: provider.preview(batch) });
  });

  router.post("/campaigns", async (req, res) => {
    const body = campaignBody.parse(req.body ?? {});
    if (body.mode === "live" && !body.optInConfirmed) {
      throw new HttpError(400, "Confirm that these contacts agreed to get WhatsApp messages from your business.");
    }
    const provider = providers.get(body.provider, body.mode);
    if (store.isBusy()) throw new HttpError(409, "Another WhatsApp campaign is still sending. Wait for it to finish or stop it first.");
    const template = await templateFor(body.provider, body.template);
    const headerMedia = await mediaFor(template, body.mediaRef, provider);
    const { plan: result, file } = await plan(body, template);
    startOrExplain(res, result.recipients, { provider, template, media: headerMedia, fileName: file.fileName });
  });

  router.get("/campaigns/:id", (req, res) => {
    res.json(campaignView(find(req.params.id)));
  });

  router.post("/campaigns/:id/cancel", (req, res) => {
    find(req.params.id);
    if (!store.cancel(req.params.id)) throw new HttpError(409, "This campaign has already finished.");
    res.json({ ok: true });
  });

  router.get("/campaigns/:id/report.csv", (req, res) => {
    const c = find(req.params.id);
    res.attachment(`whatsapp-report-${c.mode}-${c.createdAt.slice(0, 10)}.csv`).type("text/csv").send(waReportCsv(c));
  });

  router.post("/campaigns/:id/resend", async (req, res) => {
    const body = resendBody.parse(req.body ?? {});
    const previous = find(req.params.id);
    if (previous.status === "running") throw new HttpError(409, "Wait for this campaign to finish first.");
    if (previous.mode === "live" && !body.optInConfirmed) {
      throw new HttpError(400, "Confirm that these contacts agreed to get WhatsApp messages from your business.");
    }
    if (store.isBusy()) throw new HttpError(409, "Another WhatsApp campaign is still sending. Wait for it to finish or stop it first.");
    const rest = WaCampaignStore.resendable(previous);
    if (rest.length === 0) throw new HttpError(400, "There's nobody left to send to from this campaign.");
    const provider = providers.get(previous.provider, previous.mode);
    const result = planRecipients({
      template: previous.template,
      candidates: rest.map((r) => ({ row: r.row, number: r.number, values: r.values })),
      mapping: {},
      columns: [],
      ledger,
      skipRecent: true,
      dailyLimit: await dailyLimit(),
    });
    startOrExplain(res, result.recipients, {
      provider,
      template: previous.template,
      media: previous.media,
      fileName: previous.fileName,
      parentId: previous.id,
    });
  });

  function startOrExplain(
    res: Response,
    recipients: WaRecipient[],
    start: Omit<Parameters<WaCampaignStore["start"]>[0], "recipients">,
  ) {
    if (!recipients.some((r) => r.state === "pending")) {
      throw new HttpError(400, `Nobody to send to: all ${recipients.length} contact(s) would be skipped. Check the skipped list.`);
    }
    const campaign = store.start({ ...start, recipients });
    res.status(202).json({ id: campaign.id });
  }

  function find(id: string): WaCampaign {
    const c = store.get(id);
    if (!c) throw new HttpError(404, "Campaign not found. It may have been lost when the app restarted.");
    return c;
  }

  return router;
}

const round = (n: number) => Math.round(n * 100) / 100;

function campaignView(c: WaCampaign) {
  const counts = waCounts(c);
  const deliveries = { sent: 0, delivered: 0, read: 0, failed: 0 };
  for (const r of c.recipients) if (r.delivery && r.delivery in deliveries) deliveries[r.delivery as keyof typeof deliveries]++;
  return {
    id: c.id,
    mode: c.mode,
    provider: c.provider,
    status: c.status,
    stopReason: c.stopReason,
    template: { name: c.template.name, language: c.template.language, category: c.template.category },
    fileName: c.fileName,
    createdAt: c.createdAt,
    finishedAt: c.finishedAt,
    parentId: c.parentId,
    counts,
    rate: round(c.rate),
    etaSeconds: c.status === "running" && c.rate > 0 ? Math.ceil(counts.pending / c.rate) : undefined,
    errors: errorSummary(c),
    deliveries,
    resendable: c.status === "running" ? 0 : WaCampaignStore.resendable(c).length,
    samplePayload: c.samplePayload,
  };
}
