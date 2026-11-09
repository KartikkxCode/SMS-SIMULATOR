export type SendMode = "simulate" | "live";

export type AppConfig = {
  liveAvailable: boolean;
  defaultTemplateId: string;
  defaultCountryCode: string;
  batchSize: number;
};

export type UploadInfo = {
  uploadId: string;
  fileName: string;
  columns: string[];
  rowCount: number;
  preview: string[][];
  phoneColumn: number;
};

export type ContactSummary = {
  column: number;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  sample: Array<{ row: number; number: string }>;
  invalid: Array<{ row: number; value: string; reason: string }>;
  duplicates: Array<{ row: number; number: string; firstRow: number }>;
};

export type FlowPayload = {
  template_id: string;
  short_url: string;
  recipients: Array<Record<string, string>>;
};

export type CampaignStatus = "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";

export type CampaignView = {
  id: string;
  mode: SendMode;
  status: CampaignStatus;
  stopReason?: string;
  templateId: string;
  message: string;
  fileName: string;
  createdAt: string;
  finishedAt?: string;
  counts: { total: number; submitted: number; failed: number; notSent: number; pending: number };
  batches: Array<{
    index: number;
    size: number;
    status: "pending" | "sending" | "submitted" | "failed" | "not_sent";
    attempts: number;
    requestId?: string;
    error?: string;
  }>;
  samplePayload?: FlowPayload;
  samplePayloadRecipients: number;
};

export type SendOptions = {
  mode: SendMode;
  templateId: string;
  variables: Record<string, string>;
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

export const api = {
  config: () => call<AppConfig>("/api/config"),

  upload(file: File) {
    const form = new FormData();
    form.append("file", file);
    return call<UploadInfo>("/api/upload", { method: "POST", body: form });
  },

  contacts: (uploadId: string, column: number) =>
    call<ContactSummary>(`/api/uploads/${uploadId}/contacts?column=${column}`),

  problemsCsvUrl: (uploadId: string, column: number) => `/api/uploads/${uploadId}/problems.csv?column=${column}`,

  testSend: (options: SendOptions & { number: string }) =>
    postJson<{ number: string; requestId: string; payload: FlowPayload }>("/api/test-send", options),

  startCampaign: (options: SendOptions & { uploadId: string; column: number; message: string }) =>
    postJson<{ id: string }>("/api/campaigns", options),

  campaign: (id: string) => call<CampaignView>(`/api/campaigns/${id}`),

  cancelCampaign: (id: string) => postJson<{ ok: true }>(`/api/campaigns/${id}/cancel`, {}),

  reportCsvUrl: (id: string) => `/api/campaigns/${id}/report.csv`,
};
