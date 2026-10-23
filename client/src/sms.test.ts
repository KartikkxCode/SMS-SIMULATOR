import { describe, expect, it } from "vitest";
import { fillTemplate, smsInfo, templateVariables } from "./sms.ts";

describe("smsInfo", () => {
  it("counts plain text as GSM, 160 per SMS", () => {
    expect(smsInfo("")).toEqual({ encoding: "GSM", length: 0, parts: 0, remaining: 160 });
    expect(smsInfo("a".repeat(160))).toEqual({ encoding: "GSM", length: 160, parts: 1, remaining: 0 });
    expect(smsInfo("a".repeat(161))).toEqual({ encoding: "GSM", length: 161, parts: 2, remaining: 145 });
    expect(smsInfo("a".repeat(307)).parts).toBe(3);
  });

  it("counts extended GSM characters twice", () => {
    expect(smsInfo("€10 [offer]").length).toBe(14);
  });

  it("switches to Unicode for Hindi text and emoji", () => {
    expect(smsInfo("नमस्ते")).toMatchObject({ encoding: "Unicode", parts: 1 });
    expect(smsInfo("Hi 🎉").length).toBe(5);
    expect(smsInfo("क".repeat(71))).toMatchObject({ parts: 2, remaining: 63 });
  });
});

describe("templates", () => {
  it("finds each variable once, in order", () => {
    expect(templateVariables("Hi ##name##, your ##item## is ready. Bye ##name##")).toEqual(["name", "item"]);
    expect(templateVariables("No variables here")).toEqual([]);
  });

  it("fills known values and leaves the rest visible", () => {
    expect(fillTemplate("Hi ##name##, code ##otp##", { name: "Asha" })).toBe("Hi Asha, code ##otp##");
  });
});
