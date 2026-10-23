export type PhoneResult = { ok: true; number: string } | { ok: false; reason: string };

const fail = (reason: string): PhoneResult => ({ ok: false, reason });

/**
 * Turns whatever is in a spreadsheet cell into the format MSG91 expects:
 * digits only, country code first, no "+" (e.g. 919876543210).
 */
export function normalizePhone(raw: unknown, countryCode = "91"): PhoneResult {
  if (raw === null || raw === undefined) return fail("Empty");
  let s = String(raw).trim();
  if (s === "") return fail("Empty");

  // Excel shows long numbers as 9.19877E+11 and the CSV export keeps only those digits.
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(s)) {
    return fail("Shortened by Excel (scientific notation). Format the column as Text and export again");
  }

  s = s.replace(/\.0+$/, ""); // 9876543210.0 from a numeric cell
  let international = false;
  if (s.startsWith("+")) {
    international = true;
    s = s.slice(1);
  }
  s = s.replace(/[\s\-()]/g, "");
  if (!/^\d+$/.test(s)) return fail("Contains characters other than digits");

  if (s.startsWith("00")) {
    international = true;
    s = s.slice(2);
  } else if (!international) {
    s = s.replace(/^0+/, ""); // trunk prefix, e.g. 09876543210
  }

  if (countryCode === "91") return normalizeIndian(s, international);

  if (international) {
    return s.length >= 8 && s.length <= 15 ? { ok: true, number: s } : fail("Wrong length");
  }
  if (s.startsWith(countryCode) && s.length >= countryCode.length + 8 && s.length <= 15) {
    return { ok: true, number: s };
  }
  const withCode = countryCode + s;
  return withCode.length >= 8 && withCode.length <= 15 ? { ok: true, number: withCode } : fail("Wrong length");
}

function normalizeIndian(s: string, international: boolean): PhoneResult {
  if (/^91[6-9]\d{9}$/.test(s)) return { ok: true, number: s };
  if (international) {
    return s.startsWith("91")
      ? fail("Not a valid Indian mobile number")
      : fail("Not an Indian (+91) number");
  }
  if (/^[6-9]\d{9}$/.test(s)) return { ok: true, number: "91" + s };
  if (/^\d{10}$/.test(s)) return fail("Indian mobile numbers start with 6, 7, 8 or 9");
  return fail(`Expected 10 digits, found ${s.length}`);
}

export type ContactInput = { row: number; value: string };
export type ValidContact = { row: number; number: string };
export type InvalidContact = { row: number; value: string; reason: string };
export type DuplicateContact = { row: number; number: string; firstRow: number };

export type ContactCheck = {
  valid: ValidContact[];
  invalid: InvalidContact[];
  duplicates: DuplicateContact[];
};

/** Normalizes every value, keeping the first occurrence of each number. */
export function checkContacts(inputs: ContactInput[], countryCode = "91"): ContactCheck {
  const valid: ValidContact[] = [];
  const invalid: InvalidContact[] = [];
  const duplicates: DuplicateContact[] = [];
  const firstSeen = new Map<string, number>();

  for (const { row, value } of inputs) {
    const result = normalizePhone(value, countryCode);
    if (!result.ok) {
      invalid.push({ row, value, reason: result.reason });
      continue;
    }
    const firstRow = firstSeen.get(result.number);
    if (firstRow !== undefined) {
      duplicates.push({ row, number: result.number, firstRow });
      continue;
    }
    firstSeen.set(result.number, row);
    valid.push({ row, number: result.number });
  }
  return { valid, invalid, duplicates };
}
