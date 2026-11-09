import { describe, expect, it } from "vitest";
import { isBlank, parseContactLines } from "./manualContacts.ts";

describe("parseContactLines", () => {
  it("reads name and number in either order, with commas, semicolons or tabs", () => {
    expect(parseContactLines("Asha, 98765 43210\n+91 91234 56789; Ravi\nMeera\t098200-11223")).toEqual([
      { name: "Asha", phone: "98765 43210" },
      { name: "Ravi", phone: "+91 91234 56789" },
      { name: "Meera", phone: "098200-11223" },
    ]);
  });

  it("accepts just a number, and keeps short or wrong numbers as numbers", () => {
    expect(parseContactLines("9876543210\n12345\n  \n")).toEqual([
      { name: "", phone: "9876543210" },
      { name: "", phone: "12345" },
    ]);
  });

  it("finds a number written after the name without a separator", () => {
    expect(parseContactLines("Asha Patil 98765 43210")).toEqual([{ name: "Asha Patil", phone: "98765 43210" }]);
  });

  it("joins the other parts into the name", () => {
    expect(parseContactLines("Flat 12B, Asha, 9876543210,")).toEqual([{ name: "Flat 12B Asha", phone: "9876543210" }]);
  });

  it("keeps lines without a number as names, so the contact check can point them out", () => {
    expect(parseContactLines("Just a name\r\nनमस्ते राम, 9876543210")).toEqual([
      { name: "Just a name", phone: "" },
      { name: "नमस्ते राम", phone: "9876543210" },
    ]);
  });

  it("knows a blank row", () => {
    expect(isBlank({ name: " ", phone: "" })).toBe(true);
    expect(isBlank({ name: "", phone: "1" })).toBe(false);
  });
});
