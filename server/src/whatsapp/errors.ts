/**
 * What to do when sending a WhatsApp message fails:
 * - retry: try the same message again shortly (temporary problem)
 * - retry_later: wait longer, then try this contact again (too many messages to one person)
 * - fail: give up on this contact only
 * - stop: stop the whole campaign, because every other message would fail the same way
 */
export type ErrorAction = "retry" | "retry_later" | "fail" | "stop";

export type WaErrorInfo = {
  action: ErrorAction;
  code?: number;
  httpStatus?: number;
  /** The request may have reached WhatsApp even though no answer came back. Never retried, to avoid duplicates. */
  ambiguous?: boolean;
  /** WhatsApp asked us to send more slowly. */
  slowDown?: boolean;
  fbtraceId?: string;
};

export class WaApiError extends Error {
  constructor(
    message: string,
    readonly info: WaErrorInfo,
  ) {
    super(message);
  }
}

type Rule = { action: ErrorAction; explanation: string; slowDown?: boolean };

const STOP_TOKEN = "The access token is invalid or expired. Create a new System User token in Meta Business Settings.";

/** Meta WhatsApp Cloud API error codes and what they mean in plain words. */
export const META_ERRORS: Record<number, Rule> = {
  1: { action: "retry", explanation: "WhatsApp had a temporary problem." },
  2: { action: "retry", explanation: "WhatsApp's service was temporarily unavailable." },
  4: { action: "retry", explanation: "Too many API calls; slowing down.", slowDown: true },
  10: { action: "stop", explanation: "The token doesn't have permission to send WhatsApp messages." },
  100: { action: "fail", explanation: "WhatsApp rejected a value in the request." },
  190: { action: "stop", explanation: STOP_TOKEN },
  200: { action: "stop", explanation: "The token is missing the whatsapp_business_messaging permission." },
  368: { action: "stop", explanation: "This number is temporarily blocked for breaking WhatsApp's policies." },
  80007: { action: "retry", explanation: "WhatsApp's rate limit for this account was reached; slowing down.", slowDown: true },
  130429: { action: "retry", explanation: "WhatsApp's sending speed limit was reached; slowing down.", slowDown: true },
  130472: { action: "fail", explanation: "Meta held this message back as part of a marketing experiment." },
  131000: { action: "retry", explanation: "Something went wrong at WhatsApp." },
  131005: { action: "stop", explanation: "Access denied: check the token's permissions." },
  131008: { action: "stop", explanation: "A required value is missing from the message." },
  131009: { action: "fail", explanation: "WhatsApp says a value in this message isn't valid." },
  131016: { action: "retry", explanation: "WhatsApp's service is temporarily overloaded." },
  131021: { action: "fail", explanation: "The recipient is your own business number." },
  131026: { action: "fail", explanation: "Message undeliverable: the number may not be on WhatsApp, or hasn't accepted WhatsApp's latest terms." },
  131031: { action: "stop", explanation: "Your WhatsApp Business account is restricted or disabled." },
  131042: { action: "stop", explanation: "There's a payment problem on your WhatsApp Business account." },
  131045: { action: "stop", explanation: "This phone number isn't registered correctly on the WhatsApp Business Platform." },
  131047: { action: "fail", explanation: "More than 24 hours since this person last messaged you; only templates can be sent." },
  131048: { action: "stop", explanation: "WhatsApp limited this number because of spam reports or low quality. Check quality in WhatsApp Manager." },
  131049: { action: "fail", explanation: "Meta didn't deliver this marketing message, to limit how many each person gets. Try them again after 24 hours." },
  131050: { action: "fail", explanation: "This person has stopped marketing messages from your business." },
  131051: { action: "fail", explanation: "Unsupported message type." },
  131052: { action: "stop", explanation: "WhatsApp couldn't download the header image or document." },
  131053: { action: "stop", explanation: "WhatsApp couldn't use the header image or document (wrong type or too large)." },
  131056: { action: "retry_later", explanation: "Too many messages to this person in a short time; waiting before trying again." },
  131057: { action: "stop", explanation: "Your WhatsApp Business account is in maintenance mode." },
  131063: { action: "stop", explanation: "Meta now requires marketing templates to be sent through the Marketing Messages API." },
  132000: { action: "stop", explanation: "The number of values doesn't match the template's variables." },
  132001: { action: "stop", explanation: "The template doesn't exist in this language or isn't approved." },
  132005: { action: "fail", explanation: "The message is too long once this person's values are filled in." },
  132007: { action: "stop", explanation: "The template breaks WhatsApp's content policy." },
  132012: { action: "stop", explanation: "A value has the wrong format for the template (for example the header type)." },
  132015: { action: "stop", explanation: "The template is paused because of low quality." },
  132016: { action: "stop", explanation: "The template has been disabled." },
  132018: { action: "fail", explanation: "A value contains line breaks, tabs or too many spaces." },
  133004: { action: "retry", explanation: "WhatsApp's server was temporarily unavailable." },
  133010: { action: "stop", explanation: "This phone number isn't registered on the WhatsApp Business Platform." },
  135000: { action: "fail", explanation: "WhatsApp couldn't send this message (generic error)." },
};

type MetaErrorBody = {
  error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string; error_data?: { details?: string } };
};

/** Turns a failed Graph API response into a WaApiError with the right action. */
export function metaApiError(httpStatus: number, body: unknown, rawText: string): WaApiError {
  const err = (body as MetaErrorBody | undefined)?.error;
  const code = err?.code;
  const detail = err?.error_data?.details || err?.message || rawText.slice(0, 200) || `HTTP ${httpStatus}`;
  const rule = code !== undefined ? META_ERRORS[code] : undefined;
  if (rule) {
    return new WaApiError(`${rule.explanation} (WhatsApp error ${code}: ${detail})`, {
      action: rule.action,
      code,
      httpStatus,
      slowDown: rule.slowDown,
      fbtraceId: err?.fbtrace_id,
    });
  }
  if (code !== undefined && code >= 200 && code < 300) {
    return new WaApiError(`${META_ERRORS[200]!.explanation} (WhatsApp error ${code}: ${detail})`, { action: "stop", code, httpStatus });
  }
  return httpError(httpStatus, detail, code);
}

/** Classifies an HTTP failure that has no known WhatsApp error code. */
export function httpError(httpStatus: number, detail: string, code?: number): WaApiError {
  const where = code !== undefined ? `error ${code}` : `HTTP ${httpStatus}`;
  if (httpStatus === 401) return new WaApiError(`The API key or token was rejected (${where}: ${detail})`, { action: "stop", code, httpStatus });
  if (httpStatus === 403) return new WaApiError(`Access denied (${where}: ${detail})`, { action: "stop", code, httpStatus });
  if (httpStatus === 429) {
    return new WaApiError(`Too many requests; slowing down (${where}: ${detail})`, { action: "retry", code, httpStatus, slowDown: true });
  }
  if (httpStatus >= 500) return new WaApiError(`The server had a temporary problem (${where}: ${detail})`, { action: "retry", code, httpStatus });
  return new WaApiError(`The request was rejected (${where}: ${detail})`, { action: "fail", code, httpStatus });
}

// Errors that happen before the request leaves this computer: retrying can't cause a duplicate.
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Classifies a fetch() failure: safe to retry if the request never left, otherwise "unknown". */
export function networkError(err: unknown, service: string): WaApiError {
  const cause = (err as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? (err as { code?: string })?.code;
  if (code && NOT_SENT_CODES.has(code)) {
    return new WaApiError(`Couldn't reach ${service} (${code}). Check your internet connection.`, { action: "retry" });
  }
  const reason = err instanceof Error ? (err.name === "TimeoutError" ? "no answer in time" : err.message) : String(err);
  return new WaApiError(
    `No answer from ${service} (${code ?? reason}). The message may or may not have been sent, so it isn't retried automatically.`,
    { action: "fail", ambiguous: true },
  );
}
