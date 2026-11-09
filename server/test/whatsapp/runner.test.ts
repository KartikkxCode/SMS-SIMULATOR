import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WaApiError, metaApiError } from "../../src/whatsapp/errors.js";
import { WaLedger } from "../../src/whatsapp/ledger.js";
import { planRecipients } from "../../src/whatsapp/plan.js";
import type { ItemResult, SendBatch, WaProvider } from "../../src/whatsapp/providers/types.js";
import { RateLimiter, type Clock } from "../../src/whatsapp/rateLimiter.js";
import { WaCampaignStore, errorSummary, waCounts, waReportCsv, type WaRecipient } from "../../src/whatsapp/runner.js";
import { demoTemplates } from "../../src/whatsapp/templates.js";

function fakeClock(start = Date.parse("2026-11-09T10:00:00Z")) {
  let t = start;
  const sleeps: number[] = [];
  const clock: Clock & { sleeps: number[]; advance(ms: number): void } = {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms) => (t += ms),
  };
  return clock;
}

const tempDir = () => mkdtemp(path.join(tmpdir(), "wa-ledger-"));
const hello = demoTemplates().find((t) => t.name === "hello_world")!;
const order = demoTemplates().find((t) => t.name === "order_ready")!;
const meta = (code: number) => metaApiError(400, { error: { code, message: `error ${code}` } }, "");
const ambiguous = () => new WaApiError("No answer", { action: "fail", ambiguous: true });

type Script = (number: string, attempt: number) => string | WaApiError;

/** A provider whose answer per contact comes from `script(number, attemptForThatNumber)`. */
function scriptedProvider(script: Script, opts: { maxPerRequest?: number; mode?: "live" | "simulate" } = {}) {
  const attempts = new Map<string, number>();
  const batches: SendBatch[] = [];
  const provider: WaProvider & { batches: SendBatch[] } = {
    id: "meta",
    mode: opts.mode ?? "live",
    maxPerRequest: opts.maxPerRequest ?? 1,
    batches,
    listTemplates: async () => [],
    preview: (b) => ({ preview: b.items[0]?.to }),
    async send(batch) {
      batches.push(batch);
      return batch.items.map((item): ItemResult => {
        const n = (attempts.get(item.to) ?? 0) + 1;
        attempts.set(item.to, n);
        const answer = script(item.to, n);
        return typeof answer === "string" ? { index: item.index, ok: true, messageId: answer } : { index: item.index, ok: false, error: answer };
      });
    },
  };
  return provider;
}

/** A provider whose sends wait for `release()`; `started` resolves when the first send begins. */
function gatedProvider() {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (markStarted = r));
  const provider = scriptedProvider(() => "ok");
  const send = provider.send.bind(provider);
  provider.send = async (b) => {
    markStarted();
    await gate;
    return send(b);
  };
  return { provider, release, started };
}

const contacts = (n: number): WaRecipient[] =>
  Array.from({ length: n }, (_, i) => ({ row: i + 2, number: `9190000000${String(i).padStart(2, "0")}`, values: {}, state: "pending", attempts: 0 }));

function store(clock = fakeClock(), extra: Partial<ConstructorParameters<typeof WaCampaignStore>[0]> = {}) {
  return new WaCampaignStore({ ratePerSec: 1000, clock, ...extra });
}

async function run(s: WaCampaignStore, provider: WaProvider, recipients = contacts(5), template = hello) {
  const c = s.start({ provider, template, fileName: "c.csv", recipients });
  await s.waitFor(c.id);
  return c;
}

describe("RateLimiter", () => {
  it("spaces requests evenly", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(4, clock);
    for (let i = 0; i < 4; i++) await limiter.take();
    expect(clock.sleeps).toEqual([250, 250, 250]);
  });

  it("halves the speed for a minute when told to slow down", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(10, clock);
    limiter.slowDown();
    expect(limiter.currentRate()).toBe(5);
    limiter.slowDown();
    expect(limiter.currentRate()).toBe(2.5);
    clock.advance(60_000);
    expect(limiter.currentRate()).toBe(10);
  });
});

describe("WaLedger", () => {
  it("remembers sends and opt-outs across restarts", async () => {
    const dir = await tempDir();
    const clock = fakeClock();
    const ledger = await new WaLedger(dir, clock.now).load();
    ledger.recordSend({ number: "911", template: "promo", state: "accepted", messageId: "wamid.1", campaignId: "c1" });
    ledger.recordSend({ number: "912", template: "other", state: "unknown", campaignId: "c1" });
    ledger.recordStatus("wamid.1", "delivered");
    expect(ledger.addOptOut("+91 99999 00000")).toBe(true);
    expect(ledger.addOptOut("919999900000")).toBe(false);
    await ledger.flush();

    const again = await new WaLedger(dir, clock.now).load();
    expect([...again.contactsLast24h()].sort()).toEqual(["911", "912"]);
    expect(again.sentTemplateRecently("911", "promo")).toBe(true);
    expect(again.sentTemplateRecently("911", "other")).toBe(false);
    expect(again.deliveryStatus("wamid.1")?.status).toBe("delivered");
    expect(again.isOptedOut("919999900000")).toBe(true);
    expect(again.optOutCount).toBe(1);

    clock.advance(25 * 60 * 60 * 1000);
    expect(again.contactsLast24h().size).toBe(0);
    expect(again.sentTemplateRecently("911", "promo")).toBe(false);
  });

  it("skips damaged lines and drops entries older than 30 days", async () => {
    const dir = await tempDir();
    const clock = fakeClock();
    const old = { t: "send", at: new Date(clock.now() - 31 * 86_400_000).toISOString(), number: "1", template: "x", state: "accepted", campaignId: "c" };
    const fresh = { ...old, at: new Date(clock.now() - 1000).toISOString(), number: "2" };
    await writeFile(path.join(dir, "whatsapp-sent.jsonl"), `${JSON.stringify(old)}\n{"t":"send","at":\n${JSON.stringify(fresh)}\n`);
    const ledger = await new WaLedger(dir, clock.now).load();
    expect([...ledger.contactsLast24h()]).toEqual(["2"]);
    expect(await readFile(path.join(dir, "whatsapp-sent.jsonl"), "utf8")).toBe(`${JSON.stringify(fresh)}\n`);
  });
});

describe("planRecipients", () => {
  const columns = ["Name", "Phone", "Store"];
  const mapping = { "header.1": { fixed: "#1" }, "body.1": { column: 0 }, "body.2": { column: 2 } };
  const cand = (number: string, name: string) => ({ row: 2, number, cells: [name, number, "Pune"] });

  it("skips contacts with empty values, opt-outs, recent sends and those over the daily limit", async () => {
    const ledger = await new WaLedger(await tempDir()).load();
    ledger.addOptOut("912");
    ledger.recordSend({ number: "913", template: "order_ready", state: "accepted", campaignId: "x" });
    ledger.recordSend({ number: "914", template: "other", state: "accepted", campaignId: "x" });
    const plan = planRecipients({
      template: order,
      candidates: [cand("911", ""), cand("912", "B"), cand("913", "C"), cand("914", "D"), cand("915", "E"), cand("916", "F")],
      mapping,
      columns,
      ledger,
      skipRecent: true,
      dailyLimit: 3,
    });
    expect(plan.recipients.map((r) => [r.number, r.state, r.skipReason])).toEqual([
      ["911", "skipped", "values"],
      ["912", "skipped", "opted_out"],
      ["913", "skipped", "recent"],
      ["914", "pending", undefined], // Already messaged today, so it doesn't use up the limit.
      ["915", "pending", undefined],
      ["916", "skipped", "over_limit"],
    ]);
    expect(plan.recipients[4]!.values).toEqual({ "header.1": "#1", "body.1": "E", "body.2": "Pune" });
    expect(plan.warnings[0]).toMatch(/1 contact\(s\) are over your 24-hour limit of 3/);
  });

  it("allows recent repeats when asked, has no limit at 0, and warns about +1 numbers on marketing", () => {
    const offer = demoTemplates().find((t) => t.name === "festival_offer")!;
    const plan = planRecipients({
      template: offer,
      candidates: [{ row: 2, number: "14155550100", values: {} }],
      mapping: {},
      columns: [],
      skipRecent: false,
      dailyLimit: 0,
    });
    expect(plan.recipients[0]!.state).toBe("pending");
    expect(plan.warnings).toEqual([expect.stringMatching(/start with \+1/)]);
  });
});

describe("WaCampaignStore", () => {
  it("sends to every pending contact, records live sends and keeps a sample payload", async () => {
    const ledger = await new WaLedger(await tempDir()).load();
    const s = store(fakeClock(), { ledger });
    const recipients = contacts(4);
    recipients[1] = { ...recipients[1]!, state: "skipped", skipReason: "opted_out", reason: "Opted out" };
    const provider = scriptedProvider((n) => `wamid.${n}`);
    const c = await run(s, provider, recipients);

    expect(c.status).toBe("completed");
    expect(waCounts(c)).toMatchObject({ total: 4, accepted: 3, skipped: 1, failed: 0 });
    expect(provider.batches).toHaveLength(3);
    expect(c.samplePayload).toEqual({ preview: recipients[0]!.number });
    expect(s.findByMessageId(`wamid.${recipients[0]!.number}`)).toBe(c.recipients[0]);
    expect(ledger.contactsLast24h().size).toBe(3);
  });

  it("never writes simulated sends to the ledger", async () => {
    const ledger = await new WaLedger(await tempDir()).load();
    await run(store(fakeClock(), { ledger }), scriptedProvider((n) => n, { mode: "simulate" }));
    expect(ledger.contactsLast24h().size).toBe(0);
  });

  it("retries temporary errors with growing waits and slows down on 130429", async () => {
    const clock = fakeClock();
    const s = store(clock, { ratePerSec: 10 });
    const provider = scriptedProvider((_, attempt) => (attempt === 1 ? meta(130429) : attempt === 2 ? meta(131000) : "ok"));
    const c = await run(s, provider, contacts(1));
    expect(c.recipients[0]).toMatchObject({ state: "accepted", attempts: 3 });
    expect(clock.sleeps).toEqual(expect.arrayContaining([2000, 5000]));
  });

  it("waits longer before retrying a contact who got too many messages (131056)", async () => {
    const clock = fakeClock();
    const c = await run(store(clock), scriptedProvider((_, a) => (a === 1 ? meta(131056) : "ok")), contacts(1));
    expect(c.recipients[0]!.state).toBe("accepted");
    expect(clock.sleeps).toContain(10_000);
  });

  it("gives up after the retries and marks the contact for a later resend", async () => {
    const c = await run(store(), scriptedProvider(() => meta(131000)), contacts(1));
    expect(c.recipients[0]).toMatchObject({ state: "failed", attempts: 4, errorCode: 131000, errorAction: "retry" });
    expect(WaCampaignStore.resendable(c)).toHaveLength(1);
  });

  it("never retries a send with no answer, and counts it as sent", async () => {
    const ledger = await new WaLedger(await tempDir()).load();
    const provider = scriptedProvider(() => ambiguous());
    const c = await run(store(fakeClock(), { ledger }), provider, contacts(1));
    expect(c.recipients[0]).toMatchObject({ state: "unknown", attempts: 1 });
    expect(provider.batches).toHaveLength(1);
    expect(ledger.contactsLast24h().size).toBe(1);
    expect(WaCampaignStore.resendable(c)).toHaveLength(0);
    expect(c.status).toBe("failed");
  });

  it("fails one contact without retrying on a per-contact error", async () => {
    const recipients = contacts(3);
    const bad = recipients[1]!.number;
    const c = await run(store(), scriptedProvider((n) => (n === bad ? meta(131026) : "ok")), recipients);
    expect(c.recipients.map((r) => r.state)).toEqual(["accepted", "failed", "accepted"]);
    expect(c.status).toBe("completed_with_errors");
    expect(WaCampaignStore.resendable(c)).toHaveLength(0);
    expect(errorSummary(c)).toEqual([{ code: 131026, state: "failed", count: 1, message: expect.stringContaining("undeliverable") }]);
  });

  it("stops the whole campaign on an account-level error", async () => {
    const recipients = contacts(5);
    const c = await run(
      store(fakeClock(), { maxConcurrency: 1 }),
      scriptedProvider((n) => (n === recipients[1]!.number ? meta(190) : "ok")),
      recipients,
    );
    expect(c.recipients.map((r) => r.state)).toEqual(["accepted", "failed", "not_sent", "not_sent", "not_sent"]);
    expect(c.stopReason).toMatch(/access token is invalid/);
    expect(c.status).toBe("completed_with_errors");
    expect(WaCampaignStore.resendable(c)).toHaveLength(4);
  });

  it("stops when the first messages all fail the same way", async () => {
    const provider = scriptedProvider(() => meta(131026));
    const c = await run(store(fakeClock(), { maxConcurrency: 1 }), provider, contacts(12));
    expect(provider.batches).toHaveLength(5);
    expect(c.stopReason).toMatch(/first 5 messages all failed with the same error/);
    expect(waCounts(c)).toMatchObject({ failed: 5, notSent: 7 });
  });

  it("stops after too many failures in a row", async () => {
    const recipients = contacts(30);
    const first = recipients[0]!.number;
    const provider = scriptedProvider((n) => (n === first ? "ok" : meta(Number(n.slice(-2)) % 2 ? 131026 : 131049)));
    const c = await run(store(fakeClock(), { maxConcurrency: 1 }), provider, recipients);
    expect(c.stopReason).toMatch(/after 20 failures in a row/);
    expect(waCounts(c)).toMatchObject({ accepted: 1, failed: 20, notSent: 9 });
  });

  it("finishes the message in flight and sends no more after cancel", async () => {
    const { provider, release, started } = gatedProvider();
    const s = store(fakeClock(), { maxConcurrency: 1 });
    const c = s.start({ provider, template: hello, fileName: "c.csv", recipients: contacts(4) });
    expect(s.isBusy()).toBe(true);
    await started;
    expect(s.cancel(c.id)).toBe(true);
    release();
    await s.waitFor(c.id);
    expect(c.recipients.map((r) => r.state)).toEqual(["accepted", "not_sent", "not_sent", "not_sent"]);
    expect(c.status).toBe("cancelled");
    expect(s.isBusy()).toBe(false);
    expect(s.cancel(c.id)).toBe(false);
  });

  it("sends nothing if cancelled before the first message", async () => {
    const s = store(fakeClock());
    const provider = scriptedProvider(() => "ok");
    const c = s.start({ provider, template: hello, fileName: "c.csv", recipients: contacts(2) });
    s.cancel(c.id);
    await s.waitFor(c.id);
    expect(provider.batches).toHaveLength(0);
    expect(c.recipients.map((r) => r.state)).toEqual(["not_sent", "not_sent"]);
  });

  it("counts a failed bulk request once for the breaker", async () => {
    let call = 0;
    const provider = scriptedProvider(() => (call++ < 3 ? new WaApiError("MSG91 rejected the request: busy", { action: "fail" }) : "REQ"), {
      maxPerRequest: 3,
    });
    // Counted per contact, the 3 failures of the first request would trip a 2-failure breaker.
    const c = await run(store(fakeClock(), { earlySameFailures: 2 }), provider, contacts(9));
    expect(provider.batches.map((b) => b.items.length)).toEqual([3, 3, 3]);
    expect(c.stopReason).toBeUndefined();
    expect(waCounts(c)).toMatchObject({ failed: 3, accepted: 6 });
  });

  it("writes a report with each contact's values", async () => {
    const dir = await tempDir();
    const recipients = contacts(2).map((r) => ({ ...r, values: { "header.1": "#1", "body.1": "Asha", "body.2": "Pune" } }));
    const c = await run(store(fakeClock(), { reportsDir: dir }), scriptedProvider((n) => `wamid.${n}`), recipients, order);
    const csv = await readFile(c.reportFile!, "utf8");
    expect(csv).toBe(waReportCsv(c));
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines[0]).toBe("file_row,number,status,reason,message_id,error_code,attempts,time,delivery,header {{1}},{{1}},{{2}}");
    expect(lines[1]).toMatch(/^2,919000000000,accepted,,wamid\.919000000000,,1,.*,,#1,Asha,Pune$/);
  });

  it("shuts down cleanly, stopping running campaigns", async () => {
    const { provider, release, started } = gatedProvider();
    const s = store(fakeClock(), { maxConcurrency: 1 });
    const c = s.start({ provider, template: hello, fileName: "c.csv", recipients: contacts(3) });
    await started;
    const done = s.shutdown(1000);
    release();
    await done;
    expect(c.stopReason).toMatch(/app was closed/);
    expect(c.recipients.map((r) => r.state)).toEqual(["accepted", "not_sent", "not_sent"]);
  });
});
