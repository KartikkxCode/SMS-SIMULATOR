import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WaApiError, metaApiError } from "../errors.js";
import { validateValues } from "../params.js";
import { PayloadError, buildMetaPayload, buildMsg91Payload } from "../payload.js";
import type { WaMedia, WaProviderId, WaTemplate } from "../types.js";
import type { ItemResult, MediaFile, SendBatch, WaProvider } from "./types.js";

export type SimulateOptions = {
  latencyMs?: number;
  /** Fake WhatsApp errors at these rates, e.g. [{ code: 131026, rate: 0.05 }]. */
  errors?: Array<{ code: number; rate: number }>;
  msg91ChunkSize?: number;
  random?: () => number;
};

/**
 * Behaves like the chosen provider without contacting it: nothing is sent and nothing is charged.
 * It still checks every message against the template, so mistakes show up before a live send.
 */
export class SimulatedWaProvider implements WaProvider {
  readonly mode = "simulate";
  readonly maxPerRequest: number;
  private readonly random: () => number;

  constructor(
    readonly id: WaProviderId,
    private readonly templates: () => Promise<WaTemplate[]>,
    private readonly options: SimulateOptions = {},
  ) {
    this.maxPerRequest = id === "msg91" ? (options.msg91ChunkSize ?? 100) : 1;
    this.random = options.random ?? Math.random;
  }

  listTemplates(): Promise<WaTemplate[]> {
    return this.templates();
  }

  async uploadMedia(_file: MediaFile): Promise<string> {
    return `SIM-MEDIA-${randomUUID().slice(0, 8)}`;
  }

  preview(batch: SendBatch): unknown {
    const media = simulatedMedia(batch.media);
    return this.id === "msg91"
      ? buildMsg91Payload(batch.template, "SIMULATED-NUMBER", batch.items.slice(0, 3), media)
      : batch.items[0] && buildMetaPayload(batch.template, batch.items[0].to, batch.items[0].values, media);
  }

  async send(batch: SendBatch): Promise<ItemResult[]> {
    const { latencyMs = 150 } = this.options;
    if (latencyMs > 0) await sleep(latencyMs);
    try {
      this.preview(batch);
    } catch (err) {
      if (err instanceof PayloadError) {
        const error = new WaApiError(err.message, { action: "stop" });
        return batch.items.map((i) => ({ index: i.index, ok: false, error }));
      }
      throw err;
    }
    const requestId = `SIM-REQ-${randomUUID().slice(0, 8)}`;
    return batch.items.map((item): ItemResult => {
      const problem = validateValues(batch.template, item.values);
      if (problem) return { index: item.index, ok: false, error: metaApiError(400, { error: { code: 132005, message: problem } }, "") };
      const injected = this.pickError();
      if (injected !== undefined) {
        return { index: item.index, ok: false, error: metaApiError(400, { error: { code: injected, message: "Simulated error" } }, "") };
      }
      return { index: item.index, ok: true, messageId: this.id === "msg91" ? requestId : `wamid.SIM.${randomUUID().slice(0, 12)}` };
    });
  }

  private pickError(): number | undefined {
    let r = this.random();
    for (const { code, rate } of this.options.errors ?? []) {
      if (r < rate) return code;
      r -= rate;
    }
    return undefined;
  }
}

/** In Simulate mode an uploaded file has no real media ID or public link yet, so stand-ins are used. */
function simulatedMedia(media: WaMedia | undefined): WaMedia | undefined {
  if (!media) return undefined;
  return {
    ...media,
    id: media.id ?? "SIMULATED-MEDIA-ID",
    link: media.link ?? `https://simulated.invalid/${encodeURIComponent(media.filename ?? "file")}`,
  };
}
