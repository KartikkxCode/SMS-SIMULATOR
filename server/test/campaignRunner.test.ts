import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CampaignStore, campaignCounts, campaignReportCsv } from "../src/services/campaignRunner.js";
import { SimulatedProvider, SmsApiError, buildFlowPayload, type BatchRequest, type SmsProvider } from "../src/services/sms.js";

const contacts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ row: i + 2, number: `9190000${String(i).padStart(5, "0")}` }));

const noSleep = vi.fn(async () => undefined);

function store(batchSize = 100) {
  return new CampaignStore({ batchSize, batchDelayMs: 10, retryDelaysMs: [1, 2, 4], sleep: noSleep });
}

/** A provider whose answer for each call comes from `script` (an Error to throw, or a request id). */
function scriptedProvider(script: Array<Error | string>): SmsProvider & { calls: BatchRequest[] } {
  const calls: BatchRequest[] = [];
  return {
    mode: "live",
    calls,
    async sendBatch(request) {
      calls.push(request);
      const next = script.shift() ?? "ok";
      if (next instanceof Error) throw next;
      return { requestId: next, payload: buildFlowPayload(request) };
    },
  };
}

const input = (provider: SmsProvider, n: number) => ({
  provider,
  templateId: "tpl",
  variables: { var1: "x" },
  message: "Hello x",
  fileName: "contacts.csv",
  recipients: contacts(n),
});

describe("CampaignStore", () => {
  it("splits recipients into batches and submits them all", async () => {
    const s = store(100);
    const provider = scriptedProvider([]);
    const campaign = s.start(input(provider, 250));
    await s.waitFor(campaign.id);

    expect(provider.calls.map((c) => c.numbers.length)).toEqual([100, 100, 50]);
    expect(provider.calls[0]).toMatchObject({ templateId: "tpl", variables: { var1: "x" } });
    expect(campaign.status).toBe("completed");
    expect(campaignCounts(campaign)).toEqual({ total: 250, submitted: 250, failed: 0, notSent: 0, pending: 0 });
    expect(campaign.samplePayload?.recipients).toHaveLength(100);
  });

  it("retries temporary errors and then succeeds", async () => {
    const s = store();
    const provider = scriptedProvider([new SmsApiError("503", 503, true), new SmsApiError("timeout", undefined, true), "req-1"]);
    const campaign = s.start(input(provider, 5));
    await s.waitFor(campaign.id);

    expect(provider.calls).toHaveLength(3);
    expect(campaign.batches[0]).toMatchObject({ status: "submitted", attempts: 3, requestId: "req-1" });
    expect(campaign.status).toBe("completed");
  });

  it("gives up on a batch after the retries run out but keeps going", async () => {
    const s = store(2);
    const down = () => new SmsApiError("503", 503, true);
    const provider = scriptedProvider(["req-1", down(), down(), down(), down(), "req-3"]);
    const campaign = s.start(input(provider, 6));
    await s.waitFor(campaign.id);

    expect(campaign.batches.map((b) => b.status)).toEqual(["submitted", "failed", "submitted"]);
    expect(campaign.batches[1]?.attempts).toBe(4);
    expect(campaign.status).toBe("completed_with_errors");
  });

  it("does not retry permanent errors, and stops if the first batch is rejected", async () => {
    const s = store(2);
    const provider = scriptedProvider([new SmsApiError("MSG91 rejected the request: Authentication failure", 200, false)]);
    const campaign = s.start(input(provider, 6));
    await s.waitFor(campaign.id);

    expect(provider.calls).toHaveLength(1);
    expect(campaign.batches.map((b) => b.status)).toEqual(["failed", "not_sent", "not_sent"]);
    expect(campaign.status).toBe("failed");
    expect(campaign.stopReason).toMatch(/first batch was rejected/);
    expect(campaignCounts(campaign)).toMatchObject({ failed: 2, notSent: 4 });
  });

  it("keeps going when a later batch is rejected", async () => {
    const s = store(2);
    const provider = scriptedProvider(["req-1", new SmsApiError("bad", 400, false), "req-3"]);
    const campaign = s.start(input(provider, 6));
    await s.waitFor(campaign.id);

    expect(campaign.batches.map((b) => b.status)).toEqual(["submitted", "failed", "submitted"]);
  });

  it("stops sending the remaining batches when cancelled", async () => {
    const s = store(1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider: SmsProvider = {
      mode: "live",
      sendBatch: vi.fn(async (req: BatchRequest) => {
        await gate;
        return { requestId: "req", payload: buildFlowPayload(req) };
      }),
    };
    const campaign = s.start(input(provider, 3));
    expect(s.isBusy()).toBe(true);
    expect(s.cancel(campaign.id)).toBe(true);
    release();
    await s.waitFor(campaign.id);

    expect(provider.sendBatch).toHaveBeenCalledTimes(1);
    expect(campaign.batches.map((b) => b.status)).toEqual(["submitted", "not_sent", "not_sent"]);
    expect(campaign.status).toBe("cancelled");
    expect(s.isBusy()).toBe(false);
    expect(s.cancel(campaign.id)).toBe(false);
  });

  it("saves a CSV report with one row per number", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sms-report-"));
    const s = new CampaignStore({ batchSize: 2, batchDelayMs: 0, reportsDir: dir, sleep: noSleep });
    const campaign = s.start(input(new SimulatedProvider(0), 3));
    await s.waitFor(campaign.id);

    expect(campaign.mode).toBe("simulate");
    expect(campaign.reportFile).toBeDefined();
    const csv = await readFile(campaign.reportFile!, "utf8");
    expect(csv).toBe(campaignReportCsv(campaign));
    expect(csv.startsWith("\uFEFF")).toBe(true); // BOM so Excel reads UTF-8
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines[0]).toBe("file_row,number,status,request_id,error,batch,time");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^2,919000000000,submitted,SIM-[0-9a-f]{8},,1,/);
  });
});
