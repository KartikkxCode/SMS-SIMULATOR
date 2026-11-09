import type { WaParam, WaTemplate } from "./types.js";

/** Where a template value comes from: a column of the uploaded file, or the same text for everyone. */
export type ParamSource = { column: number } | { fixed: string };
export type ParamMapping = Record<string, ParamSource>;

export const LIMITS = { header: 60, body: 1024, couponCode: 15 } as const;

/** WhatsApp rejects values containing new lines, tabs or runs of spaces (error 132018). */
export function cleanValue(raw: string): string {
  return raw.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

export function paramLabel(p: WaParam): string {
  if (p.component === "button") return p.buttonType === "COPY_CODE" ? "the coupon code" : `the link button's {{${p.name}}}`;
  return p.component === "header" ? `header {{${p.name}}}` : `{{${p.name}}}`;
}

/** Returns a problem with the mapping itself (applies to every contact), or null. */
export function checkMapping(t: WaTemplate, mapping: ParamMapping, columnCount: number): string | null {
  for (const p of t.params) {
    const source = mapping[p.key];
    if (!source) return `Choose a column or type a value for ${paramLabel(p)}.`;
    if ("column" in source && (source.column < 0 || source.column >= columnCount)) {
      return `The column chosen for ${paramLabel(p)} doesn't exist in the file.`;
    }
    if ("fixed" in source && !cleanValue(source.fixed)) return `Type a value for ${paramLabel(p)}.`;
  }
  return null;
}

export type Resolved = { ok: true; values: Record<string, string> } | { ok: false; reason: string };

/** Works out one contact's values from their row, or says why the contact can't be sent to. */
export function resolveValues(t: WaTemplate, mapping: ParamMapping, cells: string[], columns: string[]): Resolved {
  const values: Record<string, string> = {};
  for (const p of t.params) {
    const source = mapping[p.key];
    if (!source) return { ok: false, reason: `No value chosen for ${paramLabel(p)}` };
    const value = cleanValue("column" in source ? (cells[source.column] ?? "") : source.fixed);
    if (!value) {
      const where = "column" in source ? ` (column "${columns[source.column] ?? source.column}")` : "";
      return { ok: false, reason: `Empty value for ${paramLabel(p)}${where}` };
    }
    values[p.key] = value;
  }
  const problem = validateValues(t, values);
  return problem ? { ok: false, reason: problem } : { ok: true, values };
}

/** Checks filled-in values against WhatsApp's limits. Returns a problem or null. */
export function validateValues(t: WaTemplate, values: Record<string, string>): string | null {
  for (const p of t.params) {
    const value = values[p.key];
    if (!value) return `Missing value for ${paramLabel(p)}`;
    if (value !== cleanValue(value)) return `The value for ${paramLabel(p)} has line breaks, tabs or extra spaces`;
    if (p.buttonType === "COPY_CODE" && value.length > LIMITS.couponCode) {
      return `The coupon code is longer than ${LIMITS.couponCode} characters`;
    }
    if (p.buttonType === "URL" && /\s/.test(value)) return `The link value can't contain spaces`;
  }
  const rendered = renderTemplate(t, values);
  if (rendered.header && rendered.header.length > LIMITS.header) {
    return `The header would be ${rendered.header.length} characters (limit ${LIMITS.header})`;
  }
  if (rendered.body.length > LIMITS.body) {
    return `The message would be ${rendered.body.length} characters (limit ${LIMITS.body})`;
  }
  return null;
}

export type Rendered = {
  header?: string;
  body: string;
  footer?: string;
  buttons: Array<{ type: string; text: string; url?: string; code?: string }>;
};

/** The message as the contact will see it. Variables without a value stay as {{…}}. */
export function renderTemplate(t: WaTemplate, values: Record<string, string>): Rendered {
  const fill = (text: string, component: "header" | "body") =>
    text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name: string) => values[`${component}.${name}`] ?? whole);
  return {
    header: t.header.format === "TEXT" && t.header.text ? fill(t.header.text, "header") : undefined,
    body: fill(t.body, "body"),
    footer: t.footer,
    buttons: t.buttons.map((b) => {
      const value = values[`button.${b.index}`];
      if (b.type === "URL" && b.url) {
        return { type: b.type, text: b.text, url: value ? b.url.replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/, value) : b.url };
      }
      if (b.type === "COPY_CODE") return { type: b.type, text: b.text || "Copy code", code: value };
      return { type: b.type, text: b.text };
    }),
  };
}
