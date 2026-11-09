export type WaProviderId = "meta" | "msg91";
export type WaMode = "simulate" | "live";

export type WaParam = {
  key: string;
  component: "header" | "body" | "button";
  name: string;
  buttonIndex?: number;
  buttonType?: "URL" | "COPY_CODE";
  example?: string;
};

export type WaTemplate = {
  ref: string;
  name: string;
  language: string;
  category: string;
  status: string;
  parameterFormat: "POSITIONAL" | "NAMED";
  header: { format: string; text?: string };
  body: string;
  footer?: string;
  buttons: Array<{ index: number; type: string; text: string; url?: string; phone?: string }>;
  params: WaParam[];
  supported: boolean;
  unsupportedReason?: string;
  namespace?: string;
};

export type ManualTemplate = {
  name: string;
  language: string;
  category: "MARKETING" | "UTILITY";
  headerFormat: "NONE" | "TEXT" | "IMAGE" | "DOCUMENT";
  headerText?: string;
  body: string;
  footer?: string;
  namespace?: string;
};

export type TemplateChoice = { ref: string } | { manual: ManualTemplate };
export type ParamSource = { column: number } | { fixed: string };
export type Mapping = Record<string, ParamSource>;

export type PhoneInfo = { displayNumber?: string; verifiedName?: string; quality?: string; tier?: string; dailyLimit?: number };

export type WaConfig = {
  providers: Record<WaProviderId, { configured: boolean }>;
  defaultProvider: WaProviderId;
  phone?: PhoneInfo;
  phoneError?: string;
  dailyLimit: number;
  usedLast24h: number;
  ratePerSec: number;
  pricePerMessage?: number;
  webhookEnabled: boolean;
  optOutCount: number;
};

export type WaMediaInfo = { ref: string; kind: "image" | "document"; filename: string; previewUrl?: string };

export type Rendered = {
  header?: string;
  body: string;
  footer?: string;
  buttons: Array<{ type: string; text: string; url?: string; code?: string }>;
};

export type Preflight = {
  preflightId: string;
  ready: number;
  skippedCount: number;
  skippedByReason: Record<"values" | "opted_out" | "recent" | "over_limit", number>;
  skipped: Array<{ row: number; number: string; reason: string }>;
  samples: Array<{ row: number; number: string; values: Record<string, string>; rendered: Rendered }>;
  warnings: string[];
  estimate: { messages: number; cost?: number };
  template: { name: string; category: string; header: string };
};

export type WaCampaignView = {
  id: string;
  mode: WaMode;
  provider: WaProviderId;
  status: "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";
  stopReason?: string;
  template: { name: string; language: string; category: string };
  fileName: string;
  createdAt: string;
  finishedAt?: string;
  parentId?: string;
  counts: { total: number; accepted: number; failed: number; unknown: number; skipped: number; notSent: number; pending: number };
  rate: number;
  etaSeconds?: number;
  errors: Array<{ code?: number; state: "failed" | "unknown"; count: number; message: string }>;
  deliveries: { sent: number; delivered: number; read: number; failed: number };
  resendable: number;
  samplePayload?: unknown;
};

export type SendSetup = {
  provider: WaProviderId;
  mode: WaMode;
  template: TemplateChoice;
  mapping: Mapping;
  mediaRef?: string;
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("Can't reach the SMS Simulator server. Is it still running?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
  return data as T;
}

const postJson = <T>(url: string, body: unknown) =>
  call<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const waApi = {
  config: () => call<WaConfig>("/api/whatsapp/config"),

  templates: (provider: WaProviderId, refresh = false) =>
    call<{ source: WaProviderId | "demo"; templates: WaTemplate[] }>(`/api/whatsapp/templates?provider=${provider}${refresh ? "&refresh=1" : ""}`),

  manualTemplate: (manual: ManualTemplate) => postJson<WaTemplate>("/api/whatsapp/templates/manual", manual),

  uploadMedia(file: File) {
    const form = new FormData();
    form.append("file", file);
    return call<WaMediaInfo>("/api/whatsapp/media", { method: "POST", body: form });
  },

  mediaLink: (link: string, kind: "image" | "document") => postJson<WaMediaInfo>("/api/whatsapp/media/link", { link, kind }),

  preflight: (setup: SendSetup & { uploadId: string; column: number; skipRecent: boolean }) =>
    postJson<Preflight>("/api/whatsapp/preflight", setup),

  skippedCsvUrl: (preflightId: string) => `/api/whatsapp/preflight/${preflightId}/skipped.csv`,

  testSend: (setup: SendSetup & { number: string; values: Record<string, string> }) =>
    postJson<{ mode: WaMode; number: string; messageId: string }>("/api/whatsapp/test-send", setup),

  startCampaign: (setup: SendSetup & { uploadId: string; column: number; skipRecent: boolean; optInConfirmed: boolean }) =>
    postJson<{ id: string }>("/api/whatsapp/campaigns", setup),

  campaign: (id: string) => call<WaCampaignView>(`/api/whatsapp/campaigns/${id}`),

  cancel: (id: string) => postJson<{ ok: true }>(`/api/whatsapp/campaigns/${id}/cancel`, {}),

  resend: (id: string, optInConfirmed: boolean) => postJson<{ id: string }>(`/api/whatsapp/campaigns/${id}/resend`, { optInConfirmed }),

  reportCsvUrl: (id: string) => `/api/whatsapp/campaigns/${id}/report.csv`,
};

export function paramLabel(p: WaParam): string {
  if (p.component === "button") return p.buttonType === "COPY_CODE" ? "Coupon code" : `Link button {{${p.name}}}`;
  return p.component === "header" ? `Header {{${p.name}}}` : `{{${p.name}}}`;
}
