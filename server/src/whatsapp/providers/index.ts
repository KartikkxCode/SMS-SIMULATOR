import type { WhatsAppConfig } from "../../config.js";
import { HttpError } from "../../http.js";
import { demoTemplates } from "../templates.js";
import type { WaMode, WaProviderId, WaTemplate } from "../types.js";
import { MetaProvider } from "./meta.js";
import { Msg91WaProvider } from "./msg91.js";
import { SimulatedWaProvider } from "./simulated.js";
import type { FetchLike, PhoneInfo, WaProvider } from "./types.js";

const TEMPLATE_CACHE_MS = 60_000;
const PHONE_INFO_CACHE_MS = 5 * 60_000;

export type TemplateList = { source: WaProviderId | "demo"; templates: WaTemplate[] };

/** Creates providers from the settings and caches what is slow to fetch. */
export class WaProviders {
  private readonly live: Partial<Record<WaProviderId, WaProvider>> = {};
  private readonly templateCache = new Map<WaProviderId, { at: number; list: TemplateList }>();
  private phoneCache?: { at: number; info: PhoneInfo };

  constructor(
    private readonly config: WhatsAppConfig,
    fetchImpl: FetchLike = fetch,
    private readonly simulateLatencyMs = 150,
    overrides: Partial<Record<WaProviderId, WaProvider>> = {},
  ) {
    const { meta, msg91 } = config;
    if (overrides.meta) this.live.meta = overrides.meta;
    else if (meta.token && meta.phoneNumberId && meta.wabaId) this.live.meta = new MetaProvider(meta, fetchImpl);
    if (overrides.msg91) this.live.msg91 = overrides.msg91;
    else if (msg91.authKey && msg91.integratedNumber) this.live.msg91 = new Msg91WaProvider(msg91, fetchImpl);
  }

  isConfigured(id: WaProviderId): boolean {
    return Boolean(this.live[id]);
  }

  /** The provider to send with. Simulate mode works whether or not the real one is set up. */
  get(id: WaProviderId, mode: WaMode): WaProvider {
    if (mode === "simulate") {
      return new SimulatedWaProvider(id, async () => (await this.templates(id)).templates, {
        latencyMs: this.simulateLatencyMs,
        errors: this.config.simulateErrors,
        msg91ChunkSize: this.config.msg91.chunkSize,
      });
    }
    const provider = this.live[id];
    if (!provider) {
      throw new HttpError(
        400,
        id === "meta"
          ? "Live WhatsApp through Meta needs WHATSAPP_META_TOKEN, WHATSAPP_META_PHONE_NUMBER_ID and WHATSAPP_META_WABA_ID in .env. Add them and restart the app."
          : "Live WhatsApp through MSG91 needs MSG91_AUTH_KEY and MSG91_WHATSAPP_NUMBER in .env. Add them and restart the app.",
      );
    }
    return provider;
  }

  /** Real templates when the provider is set up, otherwise the demo ones. */
  async templates(id: WaProviderId, refresh = false): Promise<TemplateList> {
    const provider = this.live[id];
    if (!provider) return { source: "demo", templates: demoTemplates() };
    const cached = this.templateCache.get(id);
    if (!refresh && cached && Date.now() - cached.at < TEMPLATE_CACHE_MS) return cached.list;
    const list: TemplateList = { source: id, templates: await provider.listTemplates() };
    this.templateCache.set(id, { at: Date.now(), list });
    return list;
  }

  async phoneInfo(): Promise<PhoneInfo | undefined> {
    const meta = this.live.meta;
    if (!meta?.phoneInfo) return undefined;
    if (this.phoneCache && Date.now() - this.phoneCache.at < PHONE_INFO_CACHE_MS) return this.phoneCache.info;
    const info = await meta.phoneInfo();
    this.phoneCache = { at: Date.now(), info };
    return info;
  }
}
