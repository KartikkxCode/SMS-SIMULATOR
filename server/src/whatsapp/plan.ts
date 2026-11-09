import type { WaLedger } from "./ledger.js";
import { resolveValues, type ParamMapping } from "./params.js";
import type { WaRecipient } from "./runner.js";
import type { WaTemplate } from "./types.js";

export type Candidate = { row: number; number: string; cells?: string[]; values?: Record<string, string> };

export type PlanInput = {
  template: WaTemplate;
  candidates: Candidate[];
  mapping: ParamMapping;
  columns: string[];
  ledger?: WaLedger;
  /** Skip people who got this template in the last 24 hours. */
  skipRecent: boolean;
  /** Unique contacts allowed per 24 hours; 0 means no limit. */
  dailyLimit: number;
};

export type Plan = { recipients: WaRecipient[]; warnings: string[] };

/**
 * Decides who gets the message and who is skipped, and why. Live and Simulate use the same
 * rules, so a simulation shows exactly what a live send would do.
 */
export function planRecipients(input: PlanInput): Plan {
  const { template, ledger } = input;
  const used = ledger?.contactsLast24h() ?? new Set<string>();
  let capacity = input.dailyLimit === 0 ? Infinity : Math.max(0, input.dailyLimit - used.size);

  const recipients = input.candidates.map((c): WaRecipient => {
    const base = { row: c.row, number: c.number, attempts: 0 };
    const resolved = c.values ? { ok: true as const, values: c.values } : resolveValues(template, input.mapping, c.cells ?? [], input.columns);
    if (!resolved.ok) return { ...base, values: {}, state: "skipped", skipReason: "values", reason: resolved.reason };
    const values = resolved.values;
    if (ledger?.isOptedOut(c.number)) {
      return { ...base, values, state: "skipped", skipReason: "opted_out", reason: "Opted out of WhatsApp messages" };
    }
    if (input.skipRecent && ledger?.sentTemplateRecently(c.number, template.name)) {
      return { ...base, values, state: "skipped", skipReason: "recent", reason: "Already got this template in the last 24 hours" };
    }
    if (!used.has(c.number)) {
      if (capacity <= 0) {
        return {
          ...base,
          values,
          state: "skipped",
          skipReason: "over_limit",
          reason: `Over your limit of ${input.dailyLimit} new contacts per 24 hours. Send later with "Send to the rest".`,
        };
      }
      capacity--;
    }
    return { ...base, values, state: "pending" };
  });

  const warnings: string[] = [];
  const overLimit = recipients.filter((r) => r.skipReason === "over_limit").length;
  if (overLimit > 0) {
    warnings.push(
      `${overLimit} contact(s) are over your 24-hour limit of ${input.dailyLimit} and will be skipped. ` +
        "This counts only messages sent from this app; if your WhatsApp limit is higher, raise WHATSAPP_DAILY_LIMIT in .env.",
    );
  }
  if (template.category === "MARKETING") {
    const us = recipients.filter((r) => r.state === "pending" && r.number.startsWith("1")).length;
    if (us > 0) warnings.push(`${us} number(s) start with +1. Meta doesn't deliver marketing messages to US numbers.`);
  }
  return { recipients, warnings };
}
