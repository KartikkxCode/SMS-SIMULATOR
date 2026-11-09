import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { toCsv } from "../services/csv.js";
import type { CampaignStatus } from "../services/campaignRunner.js";
import { WaApiError, type ErrorAction } from "./errors.js";
import type { WaLedger } from "./ledger.js";
import type { ItemResult, WaProvider } from "./providers/types.js";
import { RateLimiter, realClock, type Clock } from "./rateLimiter.js";
import type { WaMedia, WaMode, WaProviderId, WaTemplate } from "./types.js";

export type RecipientState = "pending" | "accepted" | "failed" | "skipped" | "unknown" | "not_sent";
export type SkipReason = "values" | "opted_out" | "recent" | "over_limit";

export type WaRecipient = {
  row: number;
  number: string;
  values: Record<string, string>;
  state: RecipientState;
  skipReason?: SkipReason;
  /** Why the contact was skipped or failed, in plain words. */
  reason?: string;
  messageId?: string;
  errorCode?: number;
  errorAction?: ErrorAction;
  attempts: number;
  at?: string;
  /** sent / delivered / read / failed, from delivery receipts (webhook). */
  delivery?: string;
};

export type WaCampaign = {
  id: string;
  mode: WaMode;
  provider: WaProviderId;
  template: WaTemplate;
  media?: WaMedia;
  fileName: string;
  createdAt: string;
  finishedAt?: string;
  status: CampaignStatus;
  stopReason?: string;
  recipients: WaRecipient[];
  /** The first request body, so the user can see exactly what is sent. Contains no secrets. */
  samplePayload?: unknown;
  reportFile?: string;
  parentId?: string;
  cancelRequested: boolean;
  /** Messages per second at the moment. */
  rate: number;
};

export type WaRunnerOptions = {
  ratePerSec: number;
  ledger?: WaLedger;
  reportsDir?: string;
  clock?: Clock;
  /** Waits before retrying a temporary error; the number of entries is the number of retries. */
  retryDelaysMs?: number[];
  /** Wait before retrying a contact who got too many messages in a short time (131056). */
  retryLaterMs?: number;
  retryLaterTries?: number;
  maxConcurrency?: number;
  /** Stop after this many failures in a row. */
  maxConsecutiveFailures?: number;
  /** Stop if this many first messages all fail with the same error before any succeeds. */
  earlySameFailures?: number;
};

export type StartInput = {
  provider: WaProvider;
  template: WaTemplate;
  media?: WaMedia;
  fileName: string;
  recipients: WaRecipient[];
  parentId?: string;
};

export class WaCampaignStore {
  private readonly campaigns = new Map<string, WaCampaign>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly byMessageId = new Map<string, WaRecipient>();

  constructor(private readonly options: WaRunnerOptions) {}

  get(id: string): WaCampaign | undefined {
    return this.campaigns.get(id);
  }

  isBusy(): boolean {
    return this.running.size > 0;
  }

  /** Starts sending in the background and returns straight away. */
  start(input: StartInput): WaCampaign {
    const campaign: WaCampaign = {
      id: randomUUID(),
      mode: input.provider.mode,
      provider: input.provider.id,
      template: input.template,
      media: input.media,
      fileName: input.fileName,
      createdAt: new Date().toISOString(),
      status: "running",
      recipients: input.recipients,
      cancelRequested: false,
      parentId: input.parentId,
      rate: 0,
    };
    this.campaigns.set(campaign.id, campaign);
    const run = this.run(campaign, input.provider)
      .catch((err) => {
        console.error("WhatsApp campaign crashed:", err);
        campaign.stopReason = `Stopped by an unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      })
      .finally(() => this.finish(campaign));
    this.running.set(campaign.id, run);
    return campaign;
  }

  cancel(id: string): boolean {
    const campaign = this.campaigns.get(id);
    if (!campaign || campaign.status !== "running") return false;
    campaign.cancelRequested = true;
    return true;
  }

  async waitFor(id: string): Promise<void> {
    await this.running.get(id);
  }

  /** Stops every running campaign (letting in-flight requests finish) and waits up to `timeoutMs`. */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    for (const id of this.running.keys()) {
      const c = this.campaigns.get(id);
      if (c) {
        c.cancelRequested = true;
        c.stopReason ??= "The app was closed while sending.";
      }
    }
    await Promise.race([Promise.allSettled(this.running.values()), new Promise((r) => setTimeout(r, timeoutMs))]);
    await this.options.ledger?.flush();
  }

  /** For delivery receipts: the contact a WhatsApp message ID belongs to. */
  findByMessageId(messageId: string): WaRecipient | undefined {
    return this.byMessageId.get(messageId);
  }

  /** Contacts worth trying again: not reached, over the daily limit, or failed for a reason that may pass. */
  static resendable(campaign: WaCampaign): WaRecipient[] {
    return campaign.recipients.filter(
      (r) =>
        r.state === "not_sent" ||
        (r.state === "skipped" && r.skipReason === "over_limit") ||
        (r.state === "failed" && r.errorAction !== undefined && r.errorAction !== "fail"),
    );
  }

  private async run(campaign: WaCampaign, provider: WaProvider): Promise<void> {
    const o = this.options;
    const clock = o.clock ?? realClock;
    const retryDelays = o.retryDelaysMs ?? [2000, 5000, 15_000];
    const retryLaterMs = o.retryLaterMs ?? 10_000;
    const retryLaterTries = o.retryLaterTries ?? 2;
    const maxConsecutive = o.maxConsecutiveFailures ?? 20;
    const earlySame = o.earlySameFailures ?? 5;
    const chunked = provider.maxPerRequest > 1;
    // A bulk request carries many contacts, so bulk providers get one request per second.
    const limiter = new RateLimiter(chunked ? Math.min(o.ratePerSec, 1) : o.ratePerSec, clock);
    const concurrency = chunked ? 1 : Math.max(1, Math.min(o.maxConcurrency ?? 10, Math.ceil(o.ratePerSec)));
    const live = campaign.mode === "live";

    const queue = campaign.recipients.flatMap((r, i) => (r.state === "pending" ? [i] : []));
    let consecutiveFailures = 0;
    let anySuccess = false;
    const earlyCodes: Array<number | string> = [];
    const halted = () => campaign.cancelRequested || campaign.stopReason !== undefined;
    const stop = (reason: string) => {
      campaign.stopReason ??= reason;
    };

    /** `countIt` is false for the 2nd+ contact of a failed bulk request: the breaker counts requests, not contacts. */
    const fail = (r: WaRecipient, err: WaApiError, attemptId: string | undefined, countIt = true) => {
      r.state = err.info.ambiguous ? "unknown" : "failed";
      r.reason = err.message;
      r.errorCode = err.info.code;
      r.errorAction = err.info.action;
      r.at = new Date(clock.now()).toISOString();
      // "unknown" still counts as sent, so a re-run doesn't message this person twice.
      if (attemptId) o.ledger?.recordResult(attemptId, err.info.ambiguous ? "unknown" : "failed");
      if (err.info.action === "stop") stop(err.message);
      if (!countIt) return;
      consecutiveFailures++;
      if (!anySuccess) {
        earlyCodes.push(err.info.code ?? err.info.httpStatus ?? err.message);
        if (earlyCodes.length >= earlySame && earlyCodes.slice(-earlySame).every((c) => c === earlyCodes.at(-1))) {
          stop(`Stopped: the first ${earlySame} messages all failed with the same error. ${err.message}`);
        }
      }
      if (consecutiveFailures >= maxConsecutive) {
        stop(`Stopped after ${maxConsecutive} failures in a row. Check the error summary before sending again.`);
      }
    };

    const handle = (results: ItemResult[], retry: number[], attemptIds: Map<number, string>): number => {
      let waitMs = 0;
      let countedThisRequest = false;
      for (const result of results) {
        const r = campaign.recipients[result.index]!;
        const attemptId = attemptIds.get(result.index);
        if (result.ok) {
          r.state = "accepted";
          r.messageId = result.messageId;
          r.reason = undefined;
          r.at = new Date(clock.now()).toISOString();
          if (result.messageId) this.byMessageId.set(result.messageId, r);
          if (attemptId) o.ledger?.recordResult(attemptId, "accepted", result.messageId);
          consecutiveFailures = 0;
          anySuccess = true;
          continue;
        }
        const { info } = result.error;
        if (info.slowDown) limiter.slowDown();
        const retries = info.action === "retry" ? retryDelays.length : info.action === "retry_later" ? retryLaterTries : 0;
        if (!info.ambiguous && r.attempts <= retries && !halted()) {
          r.reason = result.error.message;
          if (attemptId) o.ledger?.recordResult(attemptId, "failed");
          retry.push(result.index);
          waitMs = Math.max(waitMs, info.action === "retry_later" ? retryLaterMs : retryDelays[r.attempts - 1]!);
        } else {
          fail(r, result.error, attemptId, !chunked || !countedThisRequest);
          countedThisRequest = true;
        }
      }
      return waitMs;
    };

    const sendWithRetries = async (indexes: number[]) => {
      let pending = indexes;
      while (pending.length > 0) {
        for (const i of pending) campaign.recipients[i]!.attempts++;
        const batch = {
          template: campaign.template,
          media: campaign.media,
          items: pending.map((i) => ({ index: i, to: campaign.recipients[i]!.number, values: campaign.recipients[i]!.values })),
        };
        campaign.samplePayload ??= safePreview(provider, batch);
        // Log each message before it leaves, so even a crash mid-send can't lead to a second message.
        let attemptIds = new Map<number, string>();
        if (live && o.ledger) {
          try {
            const ids = await o.ledger.recordAttempts(
              pending.map((i) => ({ number: campaign.recipients[i]!.number, template: campaign.template.name, campaignId: campaign.id })),
            );
            attemptIds = new Map(pending.map((i, k) => [i, ids[k]!]));
          } catch (err) {
            for (const i of pending) campaign.recipients[i]!.attempts--;
            stop(`Stopped: couldn't write the send log (${err instanceof Error ? err.message : String(err)}), so nothing more was sent, to avoid duplicates.`);
            return;
          }
        }
        let results: ItemResult[];
        try {
          results = await provider.send(batch);
        } catch (err) {
          const error = new WaApiError(`Unexpected error while sending: ${err instanceof Error ? err.message : String(err)}`, {
            action: "stop",
            ambiguous: true,
          });
          results = pending.map((index) => ({ index, ok: false, error }));
        }
        const retry: number[] = [];
        const waitMs = handle(results, retry, attemptIds);
        campaign.rate = limiter.currentRate() * provider.maxPerRequest;
        pending = retry;
        if (pending.length > 0) {
          await clock.sleep(waitMs);
          if (halted()) {
            // Stopped while waiting to retry: these failed temporarily and can be sent again later.
            for (const i of pending) {
              const r = campaign.recipients[i]!;
              r.state = "failed";
              r.errorAction = "retry";
            }
            return;
          }
        }
      }
    };

    const worker = async () => {
      while (!halted()) {
        const indexes = queue.splice(0, provider.maxPerRequest);
        if (indexes.length === 0) return;
        await limiter.take();
        if (halted()) {
          queue.unshift(...indexes);
          return;
        }
        await sendWithRetries(indexes);
      }
    };

    campaign.rate = limiter.currentRate() * provider.maxPerRequest;
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  private async finish(campaign: WaCampaign): Promise<void> {
    for (const r of campaign.recipients) if (r.state === "pending") r.state = "not_sent";
    const counts = waCounts(campaign);
    const attempted = counts.accepted + counts.failed + counts.unknown + counts.notSent;
    campaign.status = campaign.cancelRequested
      ? "cancelled"
      : counts.accepted === attempted
        ? "completed"
        : counts.accepted === 0
          ? "failed"
          : "completed_with_errors";
    campaign.finishedAt = new Date().toISOString();
    campaign.rate = 0;
    if (this.options.reportsDir) campaign.reportFile = await saveReport(campaign, this.options.reportsDir);
    this.running.delete(campaign.id);
  }
}

function safePreview(provider: WaProvider, batch: Parameters<WaProvider["preview"]>[0]): unknown {
  try {
    return provider.preview(batch);
  } catch {
    return undefined;
  }
}

export function waCounts(campaign: WaCampaign) {
  const count = (state: RecipientState) => campaign.recipients.filter((r) => r.state === state).length;
  return {
    total: campaign.recipients.length,
    accepted: count("accepted"),
    failed: count("failed"),
    unknown: count("unknown"),
    skipped: count("skipped"),
    notSent: count("not_sent"),
    pending: count("pending"),
  };
}

/** Failures grouped by cause, most common first. */
export function errorSummary(campaign: WaCampaign) {
  const groups = new Map<string, { code?: number; state: RecipientState; count: number; message: string }>();
  for (const r of campaign.recipients) {
    if (r.state !== "failed" && r.state !== "unknown") continue;
    const key = `${r.state}:${r.errorCode ?? r.reason}`;
    const g = groups.get(key) ?? { code: r.errorCode, state: r.state, count: 0, message: r.reason ?? "" };
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** Short column names for template values in the report: {{1}}, header {{1}}, link button {{1}}, coupon code. */
function reportColumn(p: WaTemplate["params"][number]): string {
  if (p.component === "button") return p.buttonType === "COPY_CODE" ? "coupon code" : `link button {{${p.name}}}`;
  return p.component === "header" ? `header {{${p.name}}}` : `{{${p.name}}}`;
}

export function waReportCsv(campaign: WaCampaign): string {
  const params = campaign.template.params;
  const header = ["file_row", "number", "status", "reason", "message_id", "error_code", "attempts", "time", "delivery", ...params.map(reportColumn)];
  const rows = campaign.recipients.map((r) => [
    r.row,
    r.number,
    r.state,
    r.reason,
    r.messageId,
    r.errorCode,
    r.attempts,
    r.at,
    r.delivery,
    ...params.map((p) => r.values[p.key]),
  ]);
  return toCsv(header, rows);
}

async function saveReport(campaign: WaCampaign, dir: string): Promise<string | undefined> {
  const stamp = campaign.createdAt.replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-whatsapp-${campaign.mode}-${campaign.id.slice(0, 8)}.csv`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, waReportCsv(campaign), "utf8");
    return file;
  } catch (err) {
    console.error(`Couldn't save the report to ${file}:`, err);
    return undefined;
  }
}
