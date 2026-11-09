import fc from "fast-check";
import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { toCsv } from "../src/services/csv.js";
import { parseContactsFile } from "../src/services/parseContacts.js";
import { checkContacts, normalizePhone } from "../src/services/phone.js";
import { cleanValue, renderTemplate, validateValues } from "../src/whatsapp/params.js";
import { buildMetaPayload, buildMsg91Payload } from "../src/whatsapp/payload.js";
import { fromMetaTemplate } from "../src/whatsapp/templates.js";

// Any text, including emoji, Hindi, control characters and lone surrogates.
const anyText = fc.string({ unit: "binary", maxLength: 40 });
const indianMobile = fc.tuple(fc.constantFrom("6", "7", "8", "9"), fc.stringMatching(/^\d{9}$/)).map(([a, b]) => a + b);

describe("phone numbers (random input)", () => {
  it("never throws, and only ever returns digits-only numbers of a sane length", () => {
    fc.assert(
      fc.property(anyText, fc.stringMatching(/^\d{1,4}$/), (raw, cc) => {
        const r = normalizePhone(raw, cc);
        if (r.ok) expect(r.number).toMatch(/^\d{8,15}$/);
        else expect(r.reason.length).toBeGreaterThan(0);
      }),
      { numRuns: 2000 },
    );
  });

  it("reads any common way of writing an Indian mobile number the same", () => {
    const written = fc.tuple(
      indianMobile,
      fc.constantFrom("", "+91", "+91 ", "91", "0", "0091 "),
      fc.constantFrom("", " ", "-"),
    );
    fc.assert(
      fc.property(written, ([n, prefix, sep]) => {
        const formatted = prefix + n.slice(0, 5) + sep + n.slice(5);
        expect(normalizePhone(formatted)).toEqual({ ok: true, number: "91" + n });
      }),
    );
  });

  it("puts every input in exactly one list, and each valid number once", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(indianMobile, anyText), { maxLength: 60 }), (values) => {
        const inputs = values.map((value, i) => ({ row: i + 2, value }));
        const { valid, invalid, duplicates } = checkContacts(inputs);
        expect(valid.length + invalid.length + duplicates.length).toBe(inputs.length);
        expect(new Set(valid.map((v) => v.number)).size).toBe(valid.length);
        for (const d of duplicates) expect(valid.some((v) => v.number === d.number && v.row === d.firstRow)).toBe(true);
      }),
    );
  });
});

describe("CSV (random input)", () => {
  it("reports read back cell for cell, with formulas defused", () => {
    const cell = fc.oneof(anyText, fc.integer().map(String));
    fc.assert(
      fc.property(fc.array(fc.array(cell, { minLength: 3, maxLength: 3 }), { maxLength: 20 }), (rows) => {
        const csv = toCsv(["a", "b", "c"], rows);
        expect(csv.startsWith("﻿")).toBe(true);
        const parsed = Papa.parse<string[]>(csv.slice(1), { newline: "\r\n" }).data;
        expect(parsed.at(-1)).toEqual([""]); // the final line break
        expect(parsed.slice(1, -1)).toEqual(rows.map((r) => r.map((v) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v))));
      }),
      { numRuns: 500 },
    );
  });

  it("contact files read back the cells that were written", async () => {
    // Printable cells without line breaks: what people actually put in a contacts sheet.
    const cell = fc.string({ unit: "grapheme", maxLength: 20 }).filter((s) => !/[\r\n]/.test(s));
    await fc.assert(
      fc.asyncProperty(fc.array(fc.array(cell, { minLength: 2, maxLength: 2 }), { minLength: 1, maxLength: 15 }), async (rows) => {
        const kept = rows.filter((r) => r.some((c) => c.trim() !== ""));
        fc.pre(kept.length > 0);
        const csv = Papa.unparse([["Name", "Phone"], ...rows], { quotes: true });
        const sheet = await parseContactsFile("c.csv", Buffer.from(csv, "utf8"));
        expect(sheet.rows).toEqual(kept.map((r) => r.map((c) => c.trim())));
      }),
      { numRuns: 300 },
    );
  });
});

describe("WhatsApp values and payloads (random input)", () => {
  it("cleaned values have no line breaks, tabs or double spaces, and cleaning twice changes nothing", () => {
    fc.assert(
      fc.property(anyText, (raw) => {
        const once = cleanValue(raw);
        expect(once).not.toMatch(/[\r\n\t]| {2}/);
        expect(once).toBe(once.trim());
        expect(cleanValue(once)).toBe(once);
      }),
    );
  });

  // A template whose body uses {{1}}..{{k}} in random order, some more than once.
  const templateCase = fc
    .tuple(fc.integer({ min: 0, max: 6 }), fc.array(fc.stringMatching(/^[a-z ]{0,8}$/), { minLength: 1, maxLength: 8 }), fc.nat())
    .chain(([k, words, seed]) => {
      const vars = Array.from({ length: k }, (_, i) => `{{${i + 1}}}`);
      const parts = [...words, ...vars, ...(k > 0 ? [`{{${(seed % k) + 1}}}`] : [])];
      return fc.tuple(fc.shuffledSubarray(parts, { minLength: parts.length, maxLength: parts.length }), fc.array(fc.string({ unit: "grapheme", minLength: 1, maxLength: 15 }), { minLength: k, maxLength: k }));
    })
    .map(([parts, rawValues]) => {
      const template = fromMetaTemplate({ name: "t", language: "en", components: [{ type: "BODY", text: `Hi ${parts.join(" ")}` }] });
      const values = Object.fromEntries(template.params.map((p, i) => [p.key, cleanValue(rawValues[i]!) || "x"]));
      return { template, values };
    });

  it("Meta payloads carry exactly one value per variable, in order", () => {
    fc.assert(
      fc.property(templateCase, ({ template, values }) => {
        const payload = buildMetaPayload(template, "919876543210", values);
        const body = payload.template.components?.find((c) => c.type === "body");
        const sent = body ? body.parameters.map((p) => p.text) : [];
        expect(sent).toEqual(template.params.map((p) => values[p.key]));
        expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
      }),
    );
  });

  it("MSG91 payloads carry body_1..body_k for every contact", () => {
    fc.assert(
      fc.property(templateCase, fc.integer({ min: 1, max: 5 }), ({ template, values }, n) => {
        const items = Array.from({ length: n }, (_, i) => ({ to: `9190000000${i}`, values }));
        const payload = buildMsg91Payload(template, "91", items);
        for (const entry of payload.payload.template.to_and_components) {
          expect(Object.keys(entry.components)).toEqual(template.params.map((_, i) => `body_${i + 1}`));
        }
      }),
    );
  });

  it("the rendered message contains every value, and passing checks means it fits", () => {
    fc.assert(
      fc.property(templateCase, ({ template, values }) => {
        const rendered = renderTemplate(template, values);
        for (const v of Object.values(values)) expect(rendered.body).toContain(v);
        if (validateValues(template, values) === null) expect(rendered.body.length).toBeLessThanOrEqual(1024);
      }),
    );
  });
});
