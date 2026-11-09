import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { META_ERRORS, httpError, metaApiError, networkError } from "../../src/whatsapp/errors.js";
import { checkMapping, cleanValue, renderTemplate, resolveValues, validateValues } from "../../src/whatsapp/params.js";
import { PayloadError, buildMetaPayload, buildMsg91Payload } from "../../src/whatsapp/payload.js";
import { demoTemplates, fromMetaTemplate, manualTemplate, templateVariables } from "../../src/whatsapp/templates.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8")) as unknown;
const demo = (name: string) => demoTemplates().find((t) => t.name === name)!;

describe("templates", () => {
  it("lists variables once, in order of appearance", () => {
    expect(templateVariables("Hi {{1}}, {{ 2 }} and {{1}} again")).toEqual(["1", "2"]);
    expect(templateVariables(undefined)).toEqual([]);
  });

  it("reads a Meta template with an image header, body variables and buttons", () => {
    const t = demo("festival_offer");
    expect(t).toMatchObject({
      ref: "festival_offer|en",
      category: "MARKETING",
      parameterFormat: "POSITIONAL",
      header: { format: "IMAGE" },
      footer: "Reply STOP to unsubscribe",
      supported: true,
    });
    expect(t.params.map((p) => [p.key, p.example])).toEqual([
      ["body.1", "Asha"],
      ["body.2", "Diwali"],
      ["body.3", "20%"],
      ["button.0", "diwali"],
    ]);
    expect(t.buttons.map((b) => b.type)).toEqual(["URL", "QUICK_REPLY"]);
  });

  it("sorts positional variables by number and keeps header and body apart", () => {
    const t = fromMetaTemplate({
      name: "x",
      language: "en",
      components: [
        { type: "HEADER", format: "TEXT", text: "Order {{1}}" },
        { type: "BODY", text: "{{2}} then {{1}}" },
      ],
    });
    expect(t.params.map((p) => p.key)).toEqual(["header.1", "body.1", "body.2"]);
  });

  it("reads named-parameter templates", () => {
    const t = demo("invoice_ready");
    expect(t.parameterFormat).toBe("NAMED");
    expect(t.params.map((p) => [p.key, p.example])).toEqual([
      ["body.customer_name", "Meera"],
      ["body.amount", "₹1,250"],
    ]);
  });

  it("adds a parameter for copy-code buttons", () => {
    expect(demo("welcome_coupon").params.at(-1)).toMatchObject({ key: "button.0", buttonType: "COPY_CODE", name: "coupon_code" });
  });

  it.each([
    [{ status: "PENDING" }, /Not approved yet \(status: pending\)/],
    [{ category: "AUTHENTICATION" }, /Authentication/],
    [{ components: [{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "x" }] }, /Video headers/],
    [{ components: [{ type: "BODY", text: "x" }, { type: "CAROUSEL" }] }, /Carousel templates/],
    [{ components: [{ type: "BODY", text: "x" }, { type: "BUTTONS", buttons: [{ type: "FLOW", text: "Go" }] }] }, /Flow buttons/],
    [{ components: [{ type: "HEADER", format: "TEXT", text: "Hi" }] }, /no body/],
  ])("marks unsupported templates (%#)", (overrides, reason) => {
    const t = fromMetaTemplate({ name: "x", language: "en", components: [{ type: "BODY", text: "Hi" }], ...overrides });
    expect(t.supported).toBe(false);
    expect(t.unsupportedReason).toMatch(reason);
  });

  it("builds a template from manual input", () => {
    const t = manualTemplate({ name: "promo", language: "hi", category: "MARKETING", headerFormat: "IMAGE", body: "नमस्ते {{1}}" });
    expect(t).toMatchObject({ ref: "promo|hi", header: { format: "IMAGE" }, supported: true });
    expect(t.params.map((p) => p.key)).toEqual(["body.1"]);
  });
});

describe("values", () => {
  const t = demo("festival_offer");
  const columns = ["Name", "Phone", "Code"];
  const mapping = { "body.1": { column: 0 }, "body.2": { fixed: "Diwali" }, "body.3": { fixed: "20%" }, "button.0": { column: 2 } };

  it("cleans line breaks, tabs and repeated spaces", () => {
    expect(cleanValue("  Asha\n Patil\t  Pune  ")).toBe("Asha Patil Pune");
  });

  it("resolves each contact's values from columns and fixed text", () => {
    expect(resolveValues(t, mapping, ["Asha  Patil", "98", "diwali"], columns)).toEqual({
      ok: true,
      values: { "body.1": "Asha Patil", "body.2": "Diwali", "body.3": "20%", "button.0": "diwali" },
    });
  });

  it("skips contacts with an empty value and names the column", () => {
    expect(resolveValues(t, mapping, ["", "98", "x"], columns)).toEqual({ ok: false, reason: 'Empty value for {{1}} (column "Name")' });
  });

  it("rejects link values with spaces and over-long coupon codes", () => {
    expect(resolveValues(t, mapping, ["Asha", "98", "two words"], columns)).toMatchObject({ ok: false, reason: /can't contain spaces/ });
    const coupon = demo("welcome_coupon");
    expect(validateValues(coupon, { "body.1": "Asha", "button.0": "A".repeat(16) })).toMatch(/longer than 15/);
  });

  it("rejects messages over WhatsApp's length limits", () => {
    expect(validateValues(t, { "body.1": "x".repeat(1100), "body.2": "a", "body.3": "b", "button.0": "c" })).toMatch(/limit 1024/);
    const order = demo("order_ready");
    expect(validateValues(order, { "header.1": "#".repeat(60), "body.1": "a", "body.2": "b" })).toMatch(/header would be 75 characters \(limit 60\)/);
  });

  it("checks the mapping covers every variable", () => {
    expect(checkMapping(t, {}, 3)).toMatch(/Choose a column or type a value for \{\{1\}\}/);
    expect(checkMapping(t, { ...mapping, "body.1": { column: 9 } }, 3)).toMatch(/doesn't exist/);
    expect(checkMapping(t, { ...mapping, "body.2": { fixed: "  " } }, 3)).toMatch(/Type a value/);
    expect(checkMapping(t, mapping, 3)).toBeNull();
  });

  it("renders the message as the contact will see it", () => {
    const r = renderTemplate(demo("order_ready"), { "header.1": "#1042", "body.1": "Ravi", "body.2": "Pune" });
    expect(r.header).toBe("Order #1042 is ready");
    expect(r.body).toContain("Hello Ravi, your order is ready for pickup at our Pune store.");
    expect(renderTemplate(t, { "button.0": "diwali" }).buttons[0]).toEqual({ type: "URL", text: "Shop now", url: "https://example.com/shop/diwali" });
    expect(renderTemplate(t, {}).body).toContain("Hi {{1}}!");
  });
});

describe("payloads", () => {
  it("builds Meta's request body (positional, image header, URL button)", () => {
    const values = { "body.1": "Asha", "body.2": "Diwali", "body.3": "20%", "button.0": "diwali" };
    expect(buildMetaPayload(demo("festival_offer"), "919876543210", values, { kind: "image", id: "1234567890" })).toEqual(
      fixture("meta-festival-offer.json"),
    );
  });

  it("builds Meta's request body (named parameters, PDF header)", () => {
    const values = { "body.customer_name": "Meera", "body.amount": "₹1,250" };
    const media = { kind: "document" as const, id: "998877", filename: "invoice.pdf" };
    expect(buildMetaPayload(demo("invoice_ready"), "919123456789", values, media)).toEqual(fixture("meta-invoice-named.json"));
  });

  it("builds a copy-code button and leaves out components when there are none", () => {
    const coupon = buildMetaPayload(demo("welcome_coupon"), "91", { "body.1": "Imran", "button.0": "WELCOME10" });
    expect(coupon.template.components?.at(-1)).toEqual({
      type: "button",
      sub_type: "copy_code",
      index: "0",
      parameters: [{ type: "coupon_code", coupon_code: "WELCOME10" }],
    });
    expect(buildMetaPayload(demo("hello_world"), "91", {}).template).toEqual({ name: "hello_world", language: { code: "en_US" } });
  });

  it("refuses to build a message without the header media or a value", () => {
    expect(() => buildMetaPayload(demo("festival_offer"), "91", {})).toThrow(PayloadError);
    expect(() => buildMetaPayload(demo("order_ready"), "91", { "header.1": "#1" })).toThrow(/Missing value for body.1/);
  });

  it("builds MSG91's bulk body with one entry per contact", () => {
    const t = demo("order_ready");
    const items = [
      { to: "919876543210", values: { "header.1": "#1042", "body.1": "Asha", "body.2": "Pune" } },
      { to: "919123456789", values: { "header.1": "#1043", "body.1": "Ravi", "body.2": "Pune" } },
    ];
    expect(buildMsg91Payload(t, "919000000001", items)).toEqual(fixture("msg91-order-ready.json"));
  });

  it("needs a public link for MSG91 media headers", () => {
    const t = demo("festival_offer");
    const values = { "body.1": "A", "body.2": "B", "body.3": "C", "button.0": "d" };
    expect(() => buildMsg91Payload(t, "91", [{ to: "91", values }], { kind: "image", id: "123" })).toThrow(/public link/);
    const payload = buildMsg91Payload(t, "91", [{ to: "91", values }], { kind: "image", link: "https://x.test/a.jpg" });
    expect(payload.payload.template.to_and_components[0]!.components).toEqual({
      header_1: { type: "image", value: "https://x.test/a.jpg" },
      body_1: { type: "text", value: "A" },
      body_2: { type: "text", value: "B" },
      body_3: { type: "text", value: "C" },
      button_1: { subtype: "url", type: "text", value: "d" },
    });
  });
});

describe("errors", () => {
  it.each([
    [130429, "retry", true],
    [131056, "retry_later", undefined],
    [131048, "stop", undefined],
    [190, "stop", undefined],
    [132001, "stop", undefined],
    [131049, "fail", undefined],
    [131026, "fail", undefined],
  ])("classifies Meta error %i as %s", (code, action, slowDown) => {
    const err = metaApiError(400, { error: { code, message: "msg", fbtrace_id: "trace" } }, "");
    expect(err.info).toMatchObject({ action, code, httpStatus: 400, fbtraceId: "trace" });
    expect(err.info.slowDown).toBe(slowDown);
    expect(err.message).toContain(META_ERRORS[code]!.explanation);
    expect(err.message).toContain(`WhatsApp error ${code}: msg`);
  });

  it("treats unknown permission codes (200-299) as stop", () => {
    expect(metaApiError(403, { error: { code: 250, message: "no" } }, "").info.action).toBe("stop");
  });

  it("falls back to the HTTP status when there's no known code", () => {
    expect(metaApiError(503, undefined, "<html>").info).toMatchObject({ action: "retry", httpStatus: 503 });
    expect(httpError(401, "bad key").info.action).toBe("stop");
    expect(httpError(429, "slow").info).toMatchObject({ action: "retry", slowDown: true });
    expect(httpError(400, "bad").info.action).toBe("fail");
  });

  it("retries network errors only when the request never left", () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(networkError(refused, "WhatsApp").info).toEqual({ action: "retry" });

    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    expect(networkError(reset, "WhatsApp").info).toEqual({ action: "fail", ambiguous: true });

    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const err = networkError(timeout, "WhatsApp");
    expect(err.info.ambiguous).toBe(true);
    expect(err.message).toMatch(/may or may not have been sent/);
  });
});
