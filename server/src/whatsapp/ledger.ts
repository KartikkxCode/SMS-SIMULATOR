import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 30 * DAY_MS;

/** Written (and synced to disk) before a message is handed to WhatsApp. */
export type LedgerAttempt = { t: "attempt"; id: string; at: string; number: string; template: string; campaignId: string };
/** Written when WhatsApp answers. An attempt without a result (a crash) counts as possibly sent. */
export type LedgerResult = { t: "result"; id: string; at: string; state: "accepted" | "failed" | "unknown"; messageId?: string };
/** A send recorded in one step (test sends, and files written by earlier versions). */
export type LedgerSend = {
  t: "send";
  at: string;
  number: string;
  template: string;
  state: "accepted" | "unknown";
  messageId?: string;
  campaignId: string;
};
export type LedgerStatus = { t: "status"; at: string; messageId: string; status: string; errorCode?: number };
type LedgerLine = LedgerAttempt | LedgerResult | LedgerSend | LedgerStatus;

/** "pending": handed to WhatsApp with no answer recorded yet (in flight, or the app crashed). */
type SendState = "pending" | "accepted" | "unknown" | "failed";
type SendRecord = { at: number; number: string; template: string; state: SendState };

export type AttemptInput = { number: string; template: string; campaignId: string };

/**
 * A record of real WhatsApp sends in data/whatsapp-sent.jsonl, written so that nobody is messaged
 * twice even after a crash: each message is logged *before* it is sent, and its outcome after.
 * Everything not known to have failed counts as sent. Simulate mode never writes here.
 * Also holds the opt-out list (data/whatsapp-optouts.txt, one number per line).
 */
export class WaLedger {
  private readonly sends: SendRecord[] = [];
  private readonly attempts = new Map<string, SendRecord>();
  private readonly statuses = new Map<string, LedgerStatus>();
  private readonly optOuts = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  /** Messages a previous run handed to WhatsApp without recording the answer. */
  unconfirmedAtStart = 0;
  readonly sentFile: string;
  readonly optOutFile: string;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.sentFile = path.join(dir, "whatsapp-sent.jsonl");
    this.optOutFile = path.join(dir, "whatsapp-optouts.txt");
  }

  /** Reads both files, dropping entries older than 30 days (and rewriting the file if any were dropped). */
  async load(): Promise<this> {
    await mkdir(this.dir, { recursive: true });
    const lines = (await readOptional(this.sentFile)).split("\n").filter((l) => l.trim());
    const cutoff = this.now() - KEEP_MS;
    const kept: string[] = [];
    for (const line of lines) {
      let entry: LedgerLine;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // A line cut short by a crash.
      }
      if (typeof entry !== "object" || entry === null || !(Date.parse(entry.at) >= cutoff)) continue;
      kept.push(line);
      this.apply(entry);
    }
    if (kept.length < lines.length) {
      const tmp = `${this.sentFile}.tmp`;
      await writeFile(tmp, kept.map((l) => l + "\n").join(""), "utf8");
      await rename(tmp, this.sentFile);
    }
    this.unconfirmedAtStart = this.sends.filter((s) => s.state === "pending").length;
    for (const line of (await readOptional(this.optOutFile)).split(/\r?\n/)) {
      const digits = line.replace(/\D/g, "");
      if (digits) this.optOuts.add(digits);
    }
    return this;
  }

  private apply(entry: LedgerLine): void {
    if (entry.t === "attempt") {
      const record: SendRecord = { at: Date.parse(entry.at), number: entry.number, template: entry.template, state: "pending" };
      this.sends.push(record);
      this.attempts.set(entry.id, record);
    } else if (entry.t === "result") {
      const record = this.attempts.get(entry.id);
      if (record) record.state = entry.state;
    } else if (entry.t === "send") {
      this.sends.push({ at: Date.parse(entry.at), number: entry.number, template: entry.template, state: entry.state });
    } else if (entry.t === "status") {
      this.statuses.set(entry.messageId, entry);
    }
  }

  /**
   * Logs messages about to be sent and resolves once that is safely on disk, so a crash during
   * the send can't lead to a second message. Rejects if the log can't be written.
   */
  async recordAttempts(inputs: AttemptInput[]): Promise<string[]> {
    const at = new Date(this.now()).toISOString();
    const entries: LedgerAttempt[] = inputs.map((i) => ({ t: "attempt", id: randomUUID(), at, ...i }));
    for (const e of entries) this.apply(e);
    await this.enqueue(this.sentFile, entries.map((e) => JSON.stringify(e) + "\n").join(""), true);
    return entries.map((e) => e.id);
  }

  recordResult(id: string, state: LedgerResult["state"], messageId?: string): void {
    const entry: LedgerResult = { t: "result", id, at: new Date(this.now()).toISOString(), state, ...(messageId ? { messageId } : {}) };
    this.apply(entry);
    this.enqueue(this.sentFile, JSON.stringify(entry) + "\n").catch(() => {});
  }

  /** A send recorded in one step, for test messages. */
  recordSend(entry: Omit<LedgerSend, "t" | "at">): void {
    const full: LedgerSend = { t: "send", at: new Date(this.now()).toISOString(), ...entry };
    this.apply(full);
    this.enqueue(this.sentFile, JSON.stringify(full) + "\n").catch(() => {});
  }

  recordStatus(messageId: string, status: string, errorCode?: number): void {
    const entry: LedgerStatus = { t: "status", at: new Date(this.now()).toISOString(), messageId, status, ...(errorCode ? { errorCode } : {}) };
    this.apply(entry);
    this.enqueue(this.sentFile, JSON.stringify(entry) + "\n").catch(() => {});
  }

  private sentSince(ms: number): SendRecord[] {
    const since = this.now() - ms;
    return this.sends.filter((s) => s.at >= since && s.state !== "failed");
  }

  /** Numbers messaged (or possibly messaged) in the last `ms` milliseconds. */
  contactsSince(ms: number): Set<string> {
    return new Set(this.sentSince(ms).map((s) => s.number));
  }

  contactsLast24h(): Set<string> {
    return this.contactsSince(DAY_MS);
  }

  sentTemplateRecently(number: string, template: string, withinMs = DAY_MS): boolean {
    return this.sentSince(withinMs).some((s) => s.number === number && s.template === template);
  }

  deliveryStatus(messageId: string): LedgerStatus | undefined {
    return this.statuses.get(messageId);
  }

  isOptedOut(number: string): boolean {
    return this.optOuts.has(number);
  }

  get optOutCount(): number {
    return this.optOuts.size;
  }

  /** Returns false if the number was already on the list. */
  addOptOut(number: string): boolean {
    const digits = number.replace(/\D/g, "");
    if (!digits || this.optOuts.has(digits)) return false;
    this.optOuts.add(digits);
    this.enqueue(this.optOutFile, digits + "\n").catch(() => {});
    return true;
  }

  /** Resolves once everything recorded so far is on disk. */
  flush(): Promise<void> {
    return this.writes;
  }

  /** Appends in order; `sync` also waits for the disk to confirm. */
  private enqueue(file: string, text: string, sync = false): Promise<void> {
    const write = this.writes.then(async () => {
      if (!sync) return appendFile(file, text, "utf8");
      const handle = await open(file, "a");
      try {
        await handle.write(text);
        await handle.datasync();
      } finally {
        await handle.close();
      }
    });
    this.writes = write.catch((err) => console.error(`Couldn't write to ${file}. Duplicate protection may miss this send.`, err));
    return write;
  }
}

async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}
