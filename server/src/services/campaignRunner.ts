import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as defaultSleep } from "node:timers/promises";
import { toCsv } from "./csv.js";
import type { ValidContact } from "./phone.js";
import { SmsApiError, type Msg91FlowPayload, type SendMode, type SmsProvider } from "./sms.js";

export type CampaignStatus = "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";
export type BatchStatus = "pending" | "sending" | "submitted" | "failed" | "not_sent";

export type Batch = {
  index: number;
  /** Recipients covered by this batch, as [start, end) positions in `Campaign.recipients`. */
  start: number;
  end: number;
  status: BatchStatus;
  attempts: number;
  requestId?: string;
  error?: string;
  finishedAt?: string;
};

export type Campaign = {
  id: string;
  mode: SendMode;
  templateId: string;
  variables: Record<string, string>;
  message: string;
  fileName: string;
  createdAt: string;
  finishedAt?: string;
  status: CampaignStatus;
  stopReason?: string;
  recipients: ValidContact[];
  batches: Batch[];
  /** The first request body, shown in Simulate mode so the user can see exactly what MSG91 would get. */
  samplePayload?: Msg91FlowPayload;
  reportFile?: string;
  cancelRequested: boolean;
};

export type StartCampaignInput = {
  provider: SmsProvider;
  templateId: string;
  variables: Record<string, string>;
  message: string;
  fileName: string;
  recipients: ValidContact[];
};

export type RunnerOptions = {
  batchSize: number;
  batchDelayMs: number;
  /** Waits before each retry of a batch that failed with a temporary error. */
  retryDelaysMs?: number[];
  reportsDir?: string;
  sleep?: (ms: number) => Promise<unknown>;
};

export class CampaignStore {
  private readonly campaigns = new Map<string, Campaign>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly options: RunnerOptions) {}

  get(id: string): Campaign | undefined {
    return this.campaigns.get(id);
  }

  isBusy(): boolean {
    return this.running.size > 0;
  }

  /** Starts sending in the background and returns straight away. */
  start(input: StartCampaignInput): Campaign {
    const { batchSize } = this.options;
    const batches: Batch[] = [];
    for (let start = 0; start < input.recipients.length; start += batchSize) {
      const end = Math.min(start + batchSize, input.recipients.length);
      batches.push({ index: batches.length + 1, start, end, status: "pending", attempts: 0 });
    }
    const campaign: Campaign = {
      id: randomUUID(),
      mode: input.provider.mode,
      templateId: input.templateId,
      variables: input.variables,
      message: input.message,
      fileName: input.fileName,
      createdAt: new Date().toISOString(),
      status: "running",
      recipients: input.recipients,
      batches,
      cancelRequested: false,
    };
    this.campaigns.set(campaign.id, campaign);
    const run = this.run(campaign, input.provider).finally(() => this.running.delete(campaign.id));
    this.running.set(campaign.id, run);
    return campaign;
  }

  cancel(id: string): boolean {
    const campaign = this.campaigns.get(id);
    if (!campaign || campaign.status !== "running") return false;
    campaign.cancelRequested = true;
    return true;
  }

  /** Resolves once the campaign has finished (used by tests and on shutdown). */
  async waitFor(id: string): Promise<void> {
    await this.running.get(id);
  }

  private async run(campaign: Campaign, provider: SmsProvider): Promise<void> {
    const { batchDelayMs, retryDelaysMs = [1000, 2000, 4000] } = this.options;
    const sleep = this.options.sleep ?? defaultSleep;

    for (const batch of campaign.batches) {
      if (campaign.cancelRequested) break;
      if (batch.index > 1 && batchDelayMs > 0) await sleep(batchDelayMs);
      if (campaign.cancelRequested) break;

      batch.status = "sending";
      const numbers = campaign.recipients.slice(batch.start, batch.end).map((r) => r.number);
      let temporaryError = false;
      for (;;) {
        batch.attempts++;
        try {
          const result = await provider.sendBatch({ templateId: campaign.templateId, numbers, variables: campaign.variables });
          batch.status = "submitted";
          batch.requestId = result.requestId;
          campaign.samplePayload ??= result.payload;
          break;
        } catch (err) {
          temporaryError = err instanceof SmsApiError && err.retryable;
          const wait = retryDelaysMs[batch.attempts - 1];
          if (temporaryError && wait !== undefined && !campaign.cancelRequested) {
            await sleep(wait);
            continue;
          }
          batch.status = "failed";
          batch.error = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      batch.finishedAt = new Date().toISOString();

      // A first batch that MSG91 refuses outright (wrong authkey, unknown template, no balance)
      // means every other batch would be refused too, so don't keep trying.
      const nothingSubmitted = !campaign.batches.some((b) => b.status === "submitted");
      if (batch.status === "failed" && nothingSubmitted && !temporaryError) {
        campaign.stopReason = "Stopped after the first batch was rejected, so the remaining batches weren't sent.";
        break;
      }
    }

    for (const batch of campaign.batches) {
      if (batch.status === "pending") batch.status = "not_sent";
    }
    campaign.status = finalStatus(campaign);
    campaign.finishedAt = new Date().toISOString();
    if (this.options.reportsDir) campaign.reportFile = await this.saveReport(campaign, this.options.reportsDir);
  }

  private async saveReport(campaign: Campaign, dir: string): Promise<string | undefined> {
    const stamp = campaign.createdAt.replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${campaign.mode}-${campaign.id.slice(0, 8)}.csv`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, campaignReportCsv(campaign), "utf8");
      return file;
    } catch (err) {
      console.error(`Couldn't save the report to ${file}:`, err);
      return undefined;
    }
  }
}

function finalStatus(campaign: Campaign): CampaignStatus {
  if (campaign.cancelRequested) return "cancelled";
  const submitted = campaign.batches.filter((b) => b.status === "submitted").length;
  if (submitted === campaign.batches.length) return "completed";
  return submitted === 0 ? "failed" : "completed_with_errors";
}

export function campaignCounts(campaign: Campaign) {
  const count = (status: BatchStatus) =>
    campaign.batches.filter((b) => b.status === status).reduce((n, b) => n + (b.end - b.start), 0);
  return {
    total: campaign.recipients.length,
    submitted: count("submitted"),
    failed: count("failed"),
    notSent: count("not_sent"),
    pending: count("pending") + count("sending"),
  };
}

export function campaignReportCsv(campaign: Campaign): string {
  const rows = campaign.batches.flatMap((batch) =>
    campaign.recipients.slice(batch.start, batch.end).map((r) => [
      r.row,
      r.number,
      batch.status === "sending" ? "pending" : batch.status,
      batch.requestId,
      batch.error,
      batch.index,
      batch.finishedAt,
    ]),
  );
  return toCsv(["file_row", "number", "status", "request_id", "error", "batch", "time"], rows);
}
