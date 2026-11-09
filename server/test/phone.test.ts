import { describe, expect, it } from "vitest";
import { checkContacts, normalizePhone } from "../src/services/phone.js";

describe("normalizePhone (India)", () => {
  it.each([
    ["9876543210", "919876543210"],
    ["98765 43210", "919876543210"],
    ["98765-43210", "919876543210"],
    ["(98765) 43210", "919876543210"],
    ["+91 98765 43210", "919876543210"],
    ["+919876543210", "919876543210"],
    ["919876543210", "919876543210"],
    ["09876543210", "919876543210"],
    ["0091 9876543210", "919876543210"],
    ["9876543210.0", "919876543210"],
    [9876543210, "919876543210"],
    [919876543210, "919876543210"],
    ["  6123456789 ", "916123456789"],
  ])("accepts %j", (input, expected) => {
    expect(normalizePhone(input)).toEqual({ ok: true, number: expected });
  });

  it.each([
    ["", "Empty"],
    [null, "Empty"],
    [undefined, "Empty"],
    ["987654321", "Expected 10 digits, found 9"],
    ["98765432101", "Expected 10 digits, found 11"],
    ["5876543210", "Indian mobile numbers start with 6, 7, 8 or 9"],
    ["98765abc10", "Contains characters other than digits"],
    ["+1 415 555 0100", "Not an Indian (+91) number"],
    ["+91 5876543210", "Not a valid Indian mobile number"],
  ])("rejects %j", (input, reason) => {
    expect(normalizePhone(input)).toEqual({ ok: false, reason });
  });

  it("explains numbers Excel shortened to scientific notation", () => {
    const result = normalizePhone("9.19877E+11");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/scientific notation/);
  });
});

describe("normalizePhone (other country codes)", () => {
  it("adds the default country code to local numbers", () => {
    expect(normalizePhone("07911 123456", "44")).toEqual({ ok: true, number: "447911123456" });
  });

  it("keeps numbers that already start with the country code", () => {
    expect(normalizePhone("447911123456", "44")).toEqual({ ok: true, number: "447911123456" });
  });

  it("keeps international numbers from other countries", () => {
    expect(normalizePhone("+1 415 555 0100", "44")).toEqual({ ok: true, number: "14155550100" });
  });

  it("rejects numbers that are too short", () => {
    expect(normalizePhone("123", "44")).toEqual({ ok: false, reason: "Wrong length" });
  });
});

describe("checkContacts", () => {
  it("splits values into valid, invalid and duplicate", () => {
    const result = checkContacts([
      { row: 2, value: "9876543210" },
      { row: 3, value: "abc" },
      { row: 4, value: "+91 98765 43210" },
      { row: 5, value: "9123456789" },
    ]);
    expect(result.valid).toEqual([
      { row: 2, number: "919876543210" },
      { row: 5, number: "919123456789" },
    ]);
    expect(result.invalid).toEqual([{ row: 3, value: "abc", reason: "Contains characters other than digits" }]);
    expect(result.duplicates).toEqual([{ row: 4, number: "919876543210", firstRow: 2 }]);
  });
});
