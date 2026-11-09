import type { WhatsAppConfig } from "../../config.js";
import { WaApiError, httpError, networkError } from "../errors.js";
import { PayloadError, buildMsg91Payload } from "../payload.js";
import { fromMetaTemplate, type MetaTemplateJson } from "../templates.js";
import type { WaTemplate } from "../types.js";
import type { FetchLike, ItemResult, SendBatch, WaProvider } from "./types.js";

type Msg91Template = MetaTemplateJson & {
  languages?: Array<{
    language?: string;
    status?: string;
    category?: string;
    code?: MetaTemplateJson["components"];
    components?: MetaTemplateJson["components"];
  }>;
};

/**
 * WhatsApp through MSG91's bulk API (one request carries up to `chunkSize` contacts).
 * MSG91 publishes few details of these endpoints, so the request and response handling is
 * kept to this file: adjust it here if your account answers differently.
 */
export class Msg91WaProvider implements WaProvider {
  readonly id = "msg91";
  readonly mode = "live";
  readonly maxPerRequest: number;

  constructor(
    private readonly options: WhatsAppConfig["msg91"],
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
  ) {
    this.maxPerRequest = options.chunkSize;
  }

  async listTemplates(): Promise<WaTemplate[]> {
    const body = await this.call("GET", `get-template-client/${this.options.integratedNumber}`);
    const data = (body as { data?: unknown })?.data ?? body;
    const items = Array.isArray(data) ? (data as Msg91Template[]) : [];
    const templates = items.flatMap((item): WaTemplate[] => {
      if (Array.isArray(item.languages)) {
        return item.languages.map((lang) =>
          fromMetaTemplate({
            name: item.name,
            namespace: item.namespace,
            category: lang.category ?? item.category,
            language: lang.language ?? "en",
            status: lang.status,
            components: lang.code ?? lang.components ?? [],
          }),
        );
      }
      return item.components ? [fromMetaTemplate(item)] : [];
    });
    if (templates.length === 0 && items.length > 0) {
      throw new WaApiError("Couldn't read MSG91's template list. Enter the template by hand instead.", { action: "fail" });
    }
    return templates.sort((a, b) => Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name));
  }

  preview(batch: SendBatch): unknown {
    return buildMsg91Payload(batch.template, this.options.integratedNumber, batch.items.slice(0, 3), batch.media);
  }

  async send(batch: SendBatch): Promise<ItemResult[]> {
    const fail = (error: WaApiError): ItemResult[] => batch.items.map((i) => ({ index: i.index, ok: false, error }));
    let payload;
    try {
      payload = buildMsg91Payload(batch.template, this.options.integratedNumber, batch.items, batch.media);
    } catch (err) {
      if (err instanceof PayloadError) return fail(new WaApiError(err.message, { action: "stop" }));
      throw err;
    }
    try {
      const body = (await this.call("POST", "whatsapp-outbound-message/bulk/", payload)) as Record<string, unknown>;
      const data = body.data as Record<string, unknown> | string | undefined;
      const requestId = String(
        body.request_id ?? (typeof data === "object" ? data?.request_id : data) ?? body.message ?? "",
      );
      return batch.items.map((i) => ({ index: i.index, ok: true, messageId: requestId }));
    } catch (err) {
      if (err instanceof WaApiError) return fail(err);
      throw err;
    }
  }

  private async call(method: "GET" | "POST", path: string, json?: unknown): Promise<unknown> {
    const url = `${this.options.apiUrl}/${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { authkey: this.options.authKey, accept: "application/json", "content-type": "application/json" },
        body: json !== undefined ? JSON.stringify(json) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const classified = networkError(err, "MSG91");
      if (method === "GET" && classified.info.ambiguous) throw new WaApiError(classified.message, { action: "retry" });
      throw classified;
    }
    const text = await res.text();
    let body: Record<string, unknown> | undefined;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const detail = typeof body?.message === "string" ? body.message : typeof body?.errors === "string" ? body.errors : text.slice(0, 200);
    if (!res.ok) throw httpError(res.status, detail || res.statusText);
    // Only an explicit failure counts as one: treating an unclear 200 as failed could lead to a duplicate resend.
    const failed = body === undefined || ["fail", "failed", "error"].includes(String(body.status ?? body.type)) || body.hasError === true;
    if (failed) {
      throw new WaApiError(`MSG91 rejected the request: ${detail || "no reason given"}`, { action: "fail", httpStatus: res.status });
    }
    return body;
  }
}
