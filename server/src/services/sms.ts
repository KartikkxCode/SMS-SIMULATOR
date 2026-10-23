import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export type SendMode = "simulate" | "live";

export type BatchRequest = {
  templateId: string;
  /** Numbers in MSG91 format: country code first, digits only. */
  numbers: string[];
  /** Template variable values (e.g. { var1: "Diwali" }), the same for every recipient. */
  variables: Record<string, string>;
};

/** Request body for MSG91's Flow API (POST /api/v5/flow). */
export type Msg91FlowPayload = {
  template_id: string;
  short_url: "0" | "1";
  recipients: Array<{ mobiles: string } & Record<string, string>>;
};

export type BatchResult = { requestId: string; payload: Msg91FlowPayload };

export interface SmsProvider {
  readonly mode: SendMode;
  sendBatch(request: BatchRequest): Promise<BatchResult>;
}

export class SmsApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    /** True when trying again later might work (network trouble, MSG91 overloaded). */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function buildFlowPayload({ templateId, numbers, variables }: BatchRequest): Msg91FlowPayload {
  return {
    template_id: templateId,
    short_url: "0",
    recipients: numbers.map((mobiles) => ({ ...variables, mobiles })),
  };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class Msg91Provider implements SmsProvider {
  readonly mode = "live";

  constructor(
    private readonly authKey: string,
    private readonly apiUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async sendBatch(request: BatchRequest): Promise<BatchResult> {
    const payload = buildFlowPayload(request);
    let res: Response;
    try {
      res = await this.fetchImpl(this.apiUrl, {
        method: "POST",
        headers: {
          authkey: this.authKey,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SmsApiError(`Couldn't reach MSG91 (${reason}). Check your internet connection.`, undefined, true);
    }

    const text = await res.text();
    let body: { type?: unknown; message?: unknown } | undefined;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const detail = typeof body?.message === "string" ? body.message : text.slice(0, 200) || res.statusText;

    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      throw new SmsApiError(`MSG91 returned HTTP ${res.status}: ${detail}`, res.status, retryable);
    }
    // MSG91 also reports problems such as a wrong authkey or template with HTTP 200 and type "error".
    if (body?.type !== "success") {
      throw new SmsApiError(`MSG91 rejected the request: ${detail}`, res.status, false);
    }
    return { requestId: String(body.message ?? ""), payload };
  }
}

/** Behaves like MSG91 without contacting it: nothing is sent and nothing is charged. */
export class SimulatedProvider implements SmsProvider {
  readonly mode = "simulate";

  constructor(private readonly latencyMs = 200) {}

  async sendBatch(request: BatchRequest): Promise<BatchResult> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    return { requestId: `SIM-${randomUUID().slice(0, 8)}`, payload: buildFlowPayload(request) };
  }
}
