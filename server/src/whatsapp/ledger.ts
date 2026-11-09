import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 30 * DAY_MS;

export type LedgerSend = {
  t: "send";
  at: string;
  number: string;
  template: string;
  /** "unknown": the request may have reached WhatsApp, so it counts as sent. */
  state: "accepted" | "unknown";
  messageId?: string;
  campaignId: string;
};
export type LedgerStatus = { t: "status"; at: string; messageId: string; status: string; errorCode?: number };

/**
 * A record of real WhatsApp sends, appended to data/whatsapp-sent.jsonl as each one happens,
 * so a crash or restart never forgets who was already messaged. Simulate mode never writes here.
 * Also holds the opt-out list (data/whatsapp-optouts.txt, one number per line).
 */
export class WaLedger {
  private sends: LedgerSend[] = [];
  private readonly statuses = new Map<string, LedgerStatus>();
  private readonly optOuts = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  readonly sentFile: string;
  readonly optOutFile: string;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.sentFile = path.join(dir, "whatsapp-sent.jsonl");
    this.optOutFile = path.join(dir, "whatsapp-optouts.txt");
  }

  /** Reads both files, dropping sends older than 30 days (and rewriting the file if any were dropped). */
  async load(): Promise<this> {
    await mkdir(this.dir, { recursive: true });
    const lines = (await readOptional(this.sentFile)).split("\n").filter((l) => l.trim());
    const cutoff = this.now() - KEEP_MS;
    const kept: string[] = [];
    for (const line of lines) {
      let entry: LedgerSend | LedgerStatus;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // A line cut short by a crash.
      }
      if (Date.parse(entry.at) < cutoff) continue;
      kept.push(line);
      if (entry.t === "send") this.sends.push(entry);
      else if (entry.t === "status") this.statuses.set(entry.messageId, entry);
    }
    if (kept.length < lines.length) {
      const tmp = `${this.sentFile}.tmp`;
      await writeFile(tmp, kept.map((l) => l + "\n").join(""), "utf8");
      await rename(tmp, this.sentFile);
    }
    for (const line of (await readOptional(this.optOutFile)).split(/\r?\n/)) {
      const digits = line.replace(/\D/g, "");
      if (digits) this.optOuts.add(digits);
    }
    return this;
  }

  recordSend(entry: Omit<LedgerSend, "t" | "at">): void {
    const full: LedgerSend = { t: "send", at: new Date(this.now()).toISOString(), ...entry };
    this.sends.push(full);
    this.append(this.sentFile, JSON.stringify(full) + "\n");
  }

  recordStatus(messageId: string, status: string, errorCode?: number): void {
    const entry: LedgerStatus = { t: "status", at: new Date(this.now()).toISOString(), messageId, status, ...(errorCode ? { errorCode } : {}) };
    this.statuses.set(messageId, entry);
    this.append(this.sentFile, JSON.stringify(entry) + "\n");
  }

  /** Numbers sent to (accepted or unknown) in the last `ms` milliseconds. */
  contactsSince(ms: number): Set<string> {
    const since = this.now() - ms;
    return new Set(this.sends.filter((s) => Date.parse(s.at) >= since).map((s) => s.number));
  }

  contactsLast24h(): Set<string> {
    return this.contactsSince(DAY_MS);
  }

  sentTemplateRecently(number: string, template: string, withinMs = DAY_MS): boolean {
    const since = this.now() - withinMs;
    return this.sends.some((s) => s.number === number && s.template === template && Date.parse(s.at) >= since);
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
    this.append(this.optOutFile, digits + "\n");
    return true;
  }

  /** Resolves once everything recorded so far is on disk. */
  flush(): Promise<void> {
    return this.writes;
  }

  private append(file: string, text: string): void {
    this.writes = this.writes
      .then(() => appendFile(file, text, "utf8"))
      .catch((err) => console.error(`Couldn't write to ${file}. Duplicate protection may miss this send.`, err));
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
