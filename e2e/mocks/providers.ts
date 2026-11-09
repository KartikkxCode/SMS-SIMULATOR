import { jsonBody, startMock, type MockCall, type MockReply } from "./server.ts";

/** MSG91's SMS Flow API. `fail` decides per call (1-based) whether to answer with an error. */
export function mockMsg91Sms(opts: { authKey: string; fail?: (callNumber: number) => MockReply | undefined }) {
  let n = 0;
  return startMock((call) => {
    if (call.headers.authkey !== opts.authKey) return { status: 200, json: { type: "error", message: "Authentication failure" } };
    if (call.method === "POST" && call.path === "/api/v5/flow") {
      n++;
      return opts.fail?.(n) ?? { json: { type: "success", message: `SMSREQ${n}` } };
    }
    return { status: 404, json: { type: "error", message: "not found" } };
  });
}

export type MetaTemplate = { name: string; language: string; status?: string; category?: string; components: unknown[] };

export { metaError };

export const META_TEMPLATES: MetaTemplate[] = [
  {
    name: "festival_offer",
    language: "en",
    status: "APPROVED",
    category: "MARKETING",
    components: [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Hi {{1}}! Our *{{2}} sale* is live.", example: { body_text: [["Asha", "Diwali"]] } },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Shop now", url: "https://example.com/shop/{{1}}", example: ["diwali"] }] },
    ],
  },
  {
    name: "order_ready",
    language: "en",
    status: "APPROVED",
    category: "UTILITY",
    components: [
      { type: "HEADER", format: "TEXT", text: "Order {{1}} is ready" },
      { type: "BODY", text: "Hello {{1}}, pick it up at our {{2}} store." },
    ],
  },
  { name: "pending_promo", language: "en", status: "PENDING", category: "MARKETING", components: [{ type: "BODY", text: "Soon" }] },
];

/** What the mock Meta API does with a message to `to` on its `attempt`-th try (`path` is the endpoint used). */
export type MetaScript = (to: string, attempt: number, path: string) => MockReply | undefined;

const metaError = (status: number, code: number, message: string): MockReply => ({ status, json: { error: { code, message, fbtrace_id: "trace" } } });

/**
 * Meta's Graph API for WhatsApp. By default every message succeeds; numbers ending in these
 * digits behave differently: 11 rate limit then OK, 22 "too many to this person" then OK,
 * 33 marketing cap (131049), 26 undeliverable (131026), 44 dropped connection, 90 bad token (190),
 * 77 slow (800 ms).
 */
export function mockMeta(opts: { token: string; phone?: Record<string, unknown> | null; script?: MetaScript } = { token: "test-token" }) {
  const attempts = new Map<string, number>();
  const defaultScript: MetaScript = (to, attempt) => {
    const end = to.slice(-2);
    if (end === "11" && attempt === 1) return metaError(429, 130429, "Rate limit hit");
    if (end === "22" && attempt === 1) return metaError(400, 131056, "Pair rate limit hit");
    if (end === "33") return metaError(400, 131049, "Not delivered to maintain healthy ecosystem engagement");
    if (end === "26") return metaError(400, 131026, "Message undeliverable");
    if (end === "44") return { dropConnection: true };
    if (end === "90") return metaError(401, 190, "Error validating access token: Session has expired");
    if (end === "77") return { delayMs: 800, json: { messages: [{ id: `wamid.MOCK${to}` }] } };
    return undefined;
  };
  const script = opts.script ?? defaultScript;
  return startMock((call: MockCall): MockReply => {
    if (call.headers.authorization !== `Bearer ${opts.token}`) return metaError(401, 190, "Invalid OAuth access token");
    if (call.method === "GET" && call.path.endsWith("/message_templates")) return { json: { data: META_TEMPLATES, paging: { cursors: { after: "end" } } } };
    if (call.method === "GET" && /\/v\d+\.\d+\/PHONE1$/.test(call.path)) {
      return opts.phone === null
        ? metaError(500, 1, "unavailable")
        : { json: opts.phone ?? { display_phone_number: "+91 90000 00001", verified_name: "ABC Store", quality_rating: "GREEN", messaging_limit_tier: "TIER_250" } };
    }
    if (call.method === "POST" && call.path.endsWith("/PHONE1/media")) return { json: { id: "MEDIA-777" } };
    if (call.method === "POST" && /\/PHONE1\/(messages|marketing_messages)$/.test(call.path)) {
      const { to } = jsonBody<{ to: string }>(call);
      const attempt = (attempts.get(to) ?? 0) + 1;
      attempts.set(to, attempt);
      return script(to, attempt, call.path) ?? { json: { messaging_product: "whatsapp", messages: [{ id: `wamid.MOCK${to}` }] } };
    }
    return metaError(404, 100, `Unknown path ${call.path}`);
  });
}

/** MSG91's WhatsApp API: template list in MSG91's per-language shape, and the bulk endpoint. */
export function mockMsg91WhatsApp(opts: { authKey: string; number: string }) {
  let n = 0;
  return startMock((call): MockReply => {
    if (call.headers.authkey !== opts.authKey) return { status: 401, json: { status: "fail", message: "Unauthorized" } };
    if (call.method === "GET" && call.path === `/api/v5/whatsapp/get-template-client/${opts.number}`) {
      return {
        json: {
          status: "success",
          data: [
            {
              name: "order_ready",
              namespace: "ns-123",
              category: "UTILITY",
              languages: [
                {
                  language: "en",
                  status: "APPROVED",
                  code: [
                    { type: "HEADER", format: "TEXT", text: "Order {{1}} is ready" },
                    { type: "BODY", text: "Hello {{1}}, pick it up at our {{2}} store." },
                  ],
                },
              ],
            },
          ],
        },
      };
    }
    if (call.method === "POST" && call.path === "/api/v5/whatsapp/whatsapp-outbound-message/bulk/") {
      return { json: { status: "success", hasError: false, data: { request_id: `MSGREQ${++n}` } } };
    }
    return { status: 404, json: { status: "fail", message: "not found" } };
  });
}
