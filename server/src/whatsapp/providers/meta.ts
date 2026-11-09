import { createHmac } from "node:crypto";
import type { WhatsAppConfig } from "../../config.js";
import { WaApiError, httpError, metaApiError, networkError } from "../errors.js";
import { PayloadError, buildMetaPayload } from "../payload.js";
import { fromMetaTemplate, type MetaTemplateJson } from "../templates.js";
import type { WaTemplate } from "../types.js";
import type { FetchLike, ItemResult, MediaFile, PhoneInfo, SendBatch, SendItem, WaProvider } from "./types.js";

const TEMPLATE_FIELDS = "name,language,status,category,components,parameter_format";
const MAX_TEMPLATE_PAGES = 20;

const TIER_LIMITS: Record<string, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1000,
  TIER_2K: 2000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  TIER_UNLIMITED: 0,
};

type Endpoint = "messages" | "marketing_messages";

/** WhatsApp Cloud API by Meta (graph.facebook.com). */
export class MetaProvider implements WaProvider {
  readonly id = "meta";
  readonly mode = "live";
  readonly maxPerRequest = 1;
  /** Where MARKETING templates go. "auto" starts on /messages and moves when Meta answers 131063. */
  private marketingEndpoint: Endpoint;

  constructor(
    private readonly options: WhatsAppConfig["meta"],
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
  ) {
    this.marketingEndpoint = options.marketingEndpoint === "marketing_messages" ? "marketing_messages" : "messages";
  }

  async listTemplates(): Promise<WaTemplate[]> {
    const templates: WaTemplate[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_TEMPLATE_PAGES; page++) {
      const body = (await this.call("GET", `${this.options.wabaId}/message_templates`, {
        query: { fields: TEMPLATE_FIELDS, limit: "100", ...(after ? { after } : {}) },
      })) as { data?: MetaTemplateJson[]; paging?: { next?: string; cursors?: { after?: string } } };
      templates.push(...(body.data ?? []).map(fromMetaTemplate));
      after = body.paging?.next ? body.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return templates.sort((a, b) => Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name));
  }

  async uploadMedia(file: MediaFile): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", file.mimeType);
    form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }), file.filename);
    const body = (await this.call("POST", `${this.options.phoneNumberId}/media`, { form })) as { id?: string };
    if (!body.id) throw new WaApiError("WhatsApp didn't return a media ID for the upload.", { action: "stop" });
    return body.id;
  }

  async phoneInfo(): Promise<PhoneInfo> {
    const body = (await this.call("GET", this.options.phoneNumberId, {
      query: { fields: "display_phone_number,verified_name,quality_rating,messaging_limit_tier" },
    })) as { display_phone_number?: string; verified_name?: string; quality_rating?: string; messaging_limit_tier?: string };
    const tier = body.messaging_limit_tier;
    return {
      displayNumber: body.display_phone_number,
      verifiedName: body.verified_name,
      quality: body.quality_rating,
      tier,
      dailyLimit: tier !== undefined ? TIER_LIMITS[tier] : undefined,
    };
  }

  preview(batch: SendBatch): unknown {
    const item = batch.items[0];
    return item ? buildMetaPayload(batch.template, item.to, item.values, batch.media) : undefined;
  }

  async send(batch: SendBatch): Promise<ItemResult[]> {
    const results: ItemResult[] = [];
    for (const item of batch.items) results.push(await this.sendOne(batch, item));
    return results;
  }

  private async sendOne(batch: SendBatch, item: SendItem): Promise<ItemResult> {
    let payload;
    try {
      payload = buildMetaPayload(batch.template, item.to, item.values, batch.media);
    } catch (err) {
      if (err instanceof PayloadError) return { index: item.index, ok: false, error: new WaApiError(err.message, { action: "stop" }) };
      throw err;
    }
    const marketing = batch.template.category === "MARKETING";
    const endpoint: Endpoint = marketing ? this.marketingEndpoint : "messages";
    try {
      return { index: item.index, ok: true, messageId: await this.post(endpoint, payload) };
    } catch (err) {
      if (!(err instanceof WaApiError)) throw err;
      // 131063 means /messages refused the marketing template, so nothing was sent: move to the
      // Marketing Messages API (when allowed) and try once more.
      if (err.info.code === 131063 && marketing && endpoint === "messages" && this.options.marketingEndpoint === "auto") {
        this.marketingEndpoint = "marketing_messages";
        try {
          return { index: item.index, ok: true, messageId: await this.post("marketing_messages", payload) };
        } catch (retryErr) {
          if (retryErr instanceof WaApiError) return { index: item.index, ok: false, error: retryErr };
          throw retryErr;
        }
      }
      return { index: item.index, ok: false, error: err };
    }
  }

  private async post(endpoint: Endpoint, payload: unknown): Promise<string> {
    const body = (await this.call("POST", `${this.options.phoneNumberId}/${endpoint}`, { json: payload })) as {
      messages?: Array<{ id?: string }>;
    };
    const id = body.messages?.[0]?.id;
    if (!id) {
      throw new WaApiError("WhatsApp answered without a message ID, so it's unclear whether the message was sent.", {
        action: "fail",
        ambiguous: true,
      });
    }
    return id;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    { query = {}, json, form }: { query?: Record<string, string>; json?: unknown; form?: FormData },
  ): Promise<unknown> {
    const params = new URLSearchParams(query);
    if (this.options.appSecret) {
      // Proves the request comes from the app; needed when "Require app secret" is on.
      params.set("appsecret_proof", createHmac("sha256", this.options.appSecret).update(this.options.token).digest("hex"));
    }
    const qs = params.toString();
    const url = `${this.options.apiUrl}/${this.options.apiVersion}/${path}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.token}`, accept: "application/json" };
    if (json !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: json !== undefined ? JSON.stringify(json) : form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // A GET can always be repeated; only a POST that may have arrived is "unknown".
      const classified = networkError(err, "WhatsApp (Meta)");
      if (method === "GET" && classified.info.ambiguous) {
        throw new WaApiError(classified.message, { action: "retry" });
      }
      throw classified;
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = undefined;
    }
    if (!res.ok) throw metaApiError(res.status, body, text);
    if (body === undefined) throw httpError(res.status, `Unexpected answer: ${text.slice(0, 200)}`);
    return body;
  }
}
