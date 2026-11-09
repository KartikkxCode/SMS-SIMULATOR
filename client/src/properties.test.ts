import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatWhatsApp } from "./channels/whatsapp/format.ts";
import { parseContactLines } from "./steps/manualContacts.ts";

const anyText = fc.string({ unit: "binary", maxLength: 60 });

describe("formatWhatsApp (random input)", () => {
  it("never throws, never returns empty parts, and keeps the text in order", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const segments = formatWhatsApp(text);
        let from = 0;
        for (const s of segments) {
          expect(s.text.length).toBeGreaterThan(0);
          const at = text.indexOf(s.text, from);
          expect(at).toBeGreaterThanOrEqual(from);
          from = at + s.text.length;
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("leaves text without formatting marks untouched", () => {
    fc.assert(
      fc.property(anyText.filter((t) => t.length > 0 && !/[*_~`]/.test(t)), (text) => {
        expect(formatWhatsApp(text)).toEqual([{ type: "text", text }]);
      }),
    );
  });
});

describe("parseContactLines (random input)", () => {
  it("never throws and returns one contact per non-blank line", () => {
    fc.assert(
      fc.property(fc.array(anyText, { maxLength: 20 }), (lines) => {
        const text = lines.join("\n");
        const expected = text.split(/\r?\n/).filter((l) => l.trim() !== "").length;
        expect(parseContactLines(text)).toHaveLength(expected);
      }),
      { numRuns: 1000 },
    );
  });

  it("reads back a name and number written in either order with any separator", () => {
    const name = fc.stringMatching(/^[A-Za-z][A-Za-z .']{0,20}[A-Za-z]$/);
    const number = fc.stringMatching(/^(\+91 ?)?[6-9]\d{4}[ -]?\d{5}$/);
    fc.assert(
      fc.property(name, number, fc.constantFrom(", ", ",", "\t", "; "), fc.boolean(), (n, num, sep, nameFirst) => {
        const line = nameFirst ? `${n}${sep}${num}` : `${num}${sep}${n}`;
        expect(parseContactLines(line)).toEqual([{ name: n.trim(), phone: num }]);
      }),
    );
  });
});
