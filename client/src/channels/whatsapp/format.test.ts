import { describe, expect, it } from "vitest";
import { formatWhatsApp } from "./format.ts";

describe("formatWhatsApp", () => {
  it("splits bold, italic, strike and monospace", () => {
    expect(formatWhatsApp("Hi *Asha*, _today_ ~₹999~ ```CODE10``` only")).toEqual([
      { type: "text", text: "Hi " },
      { type: "bold", text: "Asha" },
      { type: "text", text: ", " },
      { type: "italic", text: "today" },
      { type: "text", text: " " },
      { type: "strike", text: "₹999" },
      { type: "text", text: " " },
      { type: "mono", text: "CODE10" },
      { type: "text", text: " only" },
    ]);
  });

  it("leaves markers that don't hug the text, or span lines, as typed", () => {
    expect(formatWhatsApp("2 * 3 * 4")).toEqual([{ type: "text", text: "2 * 3 * 4" }]);
    expect(formatWhatsApp("*one\ntwo*")).toEqual([{ type: "text", text: "*one\ntwo*" }]);
    expect(formatWhatsApp("snake_case_name")).toEqual([{ type: "text", text: "snake_case_name" }]);
    expect(formatWhatsApp("(*sale*)")).toEqual([
      { type: "text", text: "(" },
      { type: "bold", text: "sale" },
      { type: "text", text: ")" },
    ]);
  });

  it("keeps plain text and HTML-like text as plain text", () => {
    expect(formatWhatsApp("<b>hi</b>")).toEqual([{ type: "text", text: "<b>hi</b>" }]);
    expect(formatWhatsApp("")).toEqual([]);
  });
});
