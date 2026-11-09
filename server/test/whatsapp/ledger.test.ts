import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { httpError } from "../../src/whatsapp/errors.js";
import { WaLedger } from "../../src/whatsapp/ledger.js";
import type { ItemResult, WaProvider } from "../../src/whatsapp/providers/types.js";
import { WaCampaignStore, type WaRecipient } from "../../src/whatsapp/runner.js";
import { demoTemplates } from "../../src/whatsapp/templates.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "wa-ledger2-"));
const hello = demoTemplates().find((t) => t.name === "hello_world")!;
const lines = async (file: string) => (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));

const contacts = (n: number): WaRecipient[] =>
  Array.from({ length: n }, (_, i) => ({ row: i + 1, number: `9190000000${i}`, values: {}, state: "pending", attempts: 0 }));

function provider(send: WaProvider["send"]): WaProvider {
  return { id: "meta", mode: "live", maxPerRequest: 1, listTemplates: async () => [], preview: () => ({}), send };
}

describe("write-ahead send log", () => {
  it("counts a message sent before a crash, with no answer recorded, as sent", async () => {
    const dir = await tmp();
    const ledger = await new WaLedger(dir).load();
    const [crashed, answered, failed] = await ledger.recordAttempts([
      { number: "911", template: "promo", campaignId: "c" },
      { number: "912", template: "promo", campaignId: "c" },
      { number: "913", template: "promo", campaignId: "c" },
    ]);
    expect(crashed).toBeDefined();
    ledger.recordResult(answered!, "accepted", "wamid.2");
    ledger.recordResult(failed!, "failed");
    await ledger.flush();

    const after = await new WaLedger(dir).load();
    expect(after.unconfirmedAtStart).toBe(1);
    expect([...after.contactsLast24h()].sort()).toEqual(["911", "912"]);
    expect(after.sentTemplateRecently("913", "promo")).toBe(false);
  });

  it("still reads send logs written by earlier versions", async () => {
    const dir = await tmp();
    const old = { t: "send", at: new Date().toISOString(), number: "915", template: "promo", state: "accepted", campaignId: "c" };
    await writeFile(path.join(dir, "whatsapp-sent.jsonl"), JSON.stringify(old) + "\n");
    expect((await new WaLedger(dir).load()).sentTemplateRecently("915", "promo")).toBe(true);
  });

  it("has the attempt on disk before the message is handed over", async () => {
    const dir = await tmp();
    const ledger = await new WaLedger(dir).load();
    const onDiskAtSend: unknown[][] = [];
    const store = new WaCampaignStore({ ratePerSec: 80, ledger });
    const p = provider(async (b) => {
      onDiskAtSend.push(await lines(ledger.sentFile));
      return b.items.map((i): ItemResult => ({ index: i.index, ok: true, messageId: `wamid.${i.to}` }));
    });
    const c = store.start({ provider: p, template: hello, fileName: "x", recipients: contacts(1) });
    await store.waitFor(c.id);
    await ledger.flush();
    expect(onDiskAtSend[0]).toEqual([expect.objectContaining({ t: "attempt", number: "91900000000", template: "hello_world" })]);
    expect((await lines(ledger.sentFile)).map((l) => l.t)).toEqual(["attempt", "result"]);
  });

  it("logs every try of a retried message, so failures don't count as sent", async () => {
    const dir = await tmp();
    const ledger = await new WaLedger(dir).load();
    const store = new WaCampaignStore({ ratePerSec: 80, ledger, retryDelaysMs: [1, 1, 1] });
    let calls = 0;
    const p = provider(async (b) =>
      b.items.map((i): ItemResult => (++calls < 3 ? { index: i.index, ok: false, error: httpError(503, "busy") } : { index: i.index, ok: true, messageId: "m" })),
    );
    const c = store.start({ provider: p, template: hello, fileName: "x", recipients: contacts(1) });
    await store.waitFor(c.id);
    await ledger.flush();
    const log = await lines(ledger.sentFile);
    expect(log.map((l) => `${l.t}${l.state ? ":" + l.state : ""}`)).toEqual([
      "attempt",
      "result:failed",
      "attempt",
      "result:failed",
      "attempt",
      "result:accepted",
    ]);
    expect(ledger.contactsLast24h().size).toBe(1);
  });

  it("stops without sending if the log can't be written", async () => {
    const dir = await tmp();
    const ledger = await new WaLedger(dir).load();
    await writeFile(path.join(dir, "blocker"), "");
    // Point the log at a path inside a file, which can't be created.
    Object.assign(ledger, { sentFile: path.join(dir, "blocker", "whatsapp-sent.jsonl") });
    let sent = 0;
    const store = new WaCampaignStore({ ratePerSec: 80, ledger });
    const p = provider(async (b) => {
      sent++;
      return b.items.map((i): ItemResult => ({ index: i.index, ok: true, messageId: "m" }));
    });
    const errors = console.error;
    console.error = () => {};
    try {
      const c = store.start({ provider: p, template: hello, fileName: "x", recipients: contacts(3) });
      await store.waitFor(c.id);
      expect(sent).toBe(0);
      expect(c.stopReason).toMatch(/couldn't write the send log/);
      expect(c.recipients.map((r) => [r.state, r.attempts])).toEqual([
        ["not_sent", 0],
        ["not_sent", 0],
        ["not_sent", 0],
      ]);
    } finally {
      console.error = errors;
    }
  });
});
