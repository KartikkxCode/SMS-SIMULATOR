import { describe, expect, it, vi } from "vitest";
import { Msg91Provider, SimulatedProvider, SmsApiError, buildFlowPayload } from "../src/services/sms.js";

const URL = "https://control.msg91.com/api/v5/flow";
const request = { templateId: "tpl_123", numbers: ["919876543210", "919123456789"], variables: { var1: "Diwali" } };

function fakeFetch(status: number, body: string) {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(body, { status }));
}

describe("buildFlowPayload", () => {
  it("adds the same variables to every recipient", () => {
    expect(buildFlowPayload(request)).toEqual({
      template_id: "tpl_123",
      short_url: "0",
      recipients: [
        { var1: "Diwali", mobiles: "919876543210" },
        { var1: "Diwali", mobiles: "919123456789" },
      ],
    });
  });

  it("never lets a variable replace the phone number", () => {
    const payload = buildFlowPayload({ ...request, variables: { mobiles: "000" } });
    expect(payload.recipients[0]?.mobiles).toBe("919876543210");
  });
});

describe("Msg91Provider", () => {
  it("posts the flow payload with the authkey header", async () => {
    const fetch = fakeFetch(200, JSON.stringify({ type: "success", message: "req-42" }));
    const provider = new Msg91Provider("secret-key", URL, fetch);

    const result = await provider.sendBatch(request);

    expect(result.requestId).toBe("req-42");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authkey: "secret-key", "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual(buildFlowPayload(request));
  });

  it("treats type=error with HTTP 200 as a permanent failure", async () => {
    const provider = new Msg91Provider("bad", URL, fakeFetch(200, JSON.stringify({ type: "error", message: "Authentication failure" })));
    const err = await provider.sendBatch(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsApiError);
    expect(err).toMatchObject({ retryable: false, message: expect.stringContaining("Authentication failure") });
  });

  it.each([
    [500, true],
    [503, true],
    [429, true],
    [400, false],
    [401, false],
  ])("marks HTTP %i as retryable=%s", async (status, retryable) => {
    const provider = new Msg91Provider("k", URL, fakeFetch(status, JSON.stringify({ type: "error", message: "nope" })));
    await expect(provider.sendBatch(request)).rejects.toMatchObject({ status, retryable });
  });

  it("copes with a non-JSON error page", async () => {
    const provider = new Msg91Provider("k", URL, fakeFetch(502, "<html>Bad Gateway</html>"));
    await expect(provider.sendBatch(request)).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("Bad Gateway"),
    });
  });

  it("treats a network failure as retryable", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const provider = new Msg91Provider("k", URL, fetch);
    await expect(provider.sendBatch(request)).rejects.toMatchObject({ retryable: true, status: undefined });
  });
});

describe("SimulatedProvider", () => {
  it("returns a fake request id and the payload it would have sent", async () => {
    const result = await new SimulatedProvider(0).sendBatch(request);
    expect(result.requestId).toMatch(/^SIM-/);
    expect(result.payload).toEqual(buildFlowPayload(request));
  });
});
