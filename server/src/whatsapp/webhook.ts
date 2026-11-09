import { createHmac, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import type { WhatsAppConfig } from "../config.js";
import { META_ERRORS } from "./errors.js";
import type { WaLedger } from "./ledger.js";
import type { WaCampaignStore } from "./runner.js";

const STOP_WORDS = new Set(["stop", "unsubscribe", "stop all", "opt out", "optout", "cancel"]);
const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

type StatusUpdate = { id?: string; status?: string; errors?: Array<{ code?: number; title?: string }> };
type InboundMessage = { from?: string; type?: string; text?: { body?: string }; button?: { text?: string } };
type WebhookBody = {
  object?: string;
  entry?: Array<{ changes?: Array<{ field?: string; value?: { statuses?: StatusUpdate[]; messages?: InboundMessage[] } }> }>;
};

/**
 * Optional delivery receipts from Meta. Needs a public address (for example a cloudflared tunnel),
 * WHATSAPP_WEBHOOK_VERIFY_TOKEN and WHATSAPP_META_APP_SECRET. Every POST must carry Meta's signature.
 */
export function webhookRouter(config: WhatsAppConfig, ledger: WaLedger, store: WaCampaignStore): Router {
  const router = Router();
  const secret = config.meta.appSecret;

  router.get("/webhooks/whatsapp", (req, res) => {
    if (!config.webhookVerifyToken) {
      res.status(404).send("Delivery receipts aren't turned on.");
      return;
    }
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === config.webhookVerifyToken) {
      res.type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
    } else {
      res.status(403).send("Verify token doesn't match.");
    }
  });

  router.post("/webhooks/whatsapp", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    if (!config.webhookVerifyToken || !secret) {
      res.status(503).send("Set WHATSAPP_WEBHOOK_VERIFY_TOKEN and WHATSAPP_META_APP_SECRET to accept delivery receipts.");
      return;
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!validSignature(raw, req.header("x-hub-signature-256"), secret)) {
      res.status(401).send("Bad signature.");
      return;
    }
    let body: WebhookBody;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      res.status(400).send("Not JSON.");
      return;
    }
    applyWebhook(body, ledger, store);
    res.sendStatus(200);
  });

  return router;
}

export function validSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"), "utf8");
  const given = Buffer.from(header.slice("sha256=".length), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function applyWebhook(body: WebhookBody, ledger: WaLedger, store: WaCampaignStore): void {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      for (const s of value.statuses ?? []) {
        if (!s.id || !s.status) continue;
        const code = s.errors?.[0]?.code;
        ledger.recordStatus(s.id, s.status, code);
        const recipient = store.findByMessageId(s.id);
        if (!recipient) continue;
        // Receipts can arrive out of order: never move back from "read" to "delivered".
        if (s.status === "failed") {
          recipient.delivery = "failed";
          const explanation = code !== undefined ? META_ERRORS[code]?.explanation : undefined;
          recipient.reason = `Delivery failed${code !== undefined ? ` (${code})` : ""}: ${explanation ?? s.errors?.[0]?.title ?? "no reason given"}`;
          recipient.errorCode = code;
        } else if ((RANK[s.status] ?? 0) > (RANK[recipient.delivery ?? ""] ?? 0) && recipient.delivery !== "failed") {
          recipient.delivery = s.status;
        }
      }
      for (const m of value.messages ?? []) {
        const text = (m.text?.body ?? m.button?.text ?? "").trim().toLowerCase();
        if (m.from && STOP_WORDS.has(text)) ledger.addOptOut(m.from);
      }
    }
  }
}
