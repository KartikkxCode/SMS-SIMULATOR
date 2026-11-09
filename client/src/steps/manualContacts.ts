export type TypedContact = { name: string; phone: string };

// A phone number: optional +, then at least 6 digits with spaces, dashes, dots or brackets between.
const PHONE_PART = /^\+?[\d\s\-().]+$/;
const PHONE_IN_TEXT = /\+?\(?\d[\d\s\-().]*\d/g;

const digitCount = (s: string) => (s.match(/\d/g) ?? []).length;
const looksLikePhone = (s: string) => PHONE_PART.test(s.trim()) && digitCount(s) >= 6;

/**
 * Reads a pasted list, one contact per line: "Name, Number", "Number, Name", "Name<TAB>Number"
 * (as copied from Excel) or just "Number". Lines without a number keep their text as the name,
 * so the contact check can point them out.
 */
export function parseContactLines(text: string): TypedContact[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): TypedContact => {
      // No letters at all: it's a number, even a wrong one (the contact check will say why).
      if (!/\p{L}/u.test(line)) return { name: "", phone: line };
      const parts = line.split(/[\t,;]/).map((p) => p.trim()).filter(Boolean);
      const phoneIndex = parts.findIndex(looksLikePhone);
      if (phoneIndex !== -1) {
        return { phone: parts[phoneIndex]!, name: parts.filter((_, i) => i !== phoneIndex).join(" ") };
      }
      // "Asha 98765 43210": the number is inside the text.
      const match = [...line.matchAll(PHONE_IN_TEXT)].filter((m) => digitCount(m[0]) >= 6).at(-1);
      if (match) {
        const name = (line.slice(0, match.index) + line.slice(match.index + match[0].length)).replace(/\s{2,}/g, " ").trim();
        return { phone: match[0].trim(), name };
      }
      return { name: line, phone: "" };
    });
}

export const isBlank = (c: TypedContact) => !c.name.trim() && !c.phone.trim();
