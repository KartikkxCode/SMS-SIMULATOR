import type { WaApiError } from "../errors.js";
import type { WaMedia, WaMode, WaProviderId, WaTemplate } from "../types.js";

export type SendItem = { index: number; to: string; values: Record<string, string> };
export type SendBatch = { template: WaTemplate; items: SendItem[]; media?: WaMedia };
export type ItemResult = { index: number; ok: true; messageId: string } | { index: number; ok: false; error: WaApiError };

export type PhoneInfo = {
  displayNumber?: string;
  verifiedName?: string;
  /** GREEN, YELLOW or RED. */
  quality?: string;
  tier?: string;
  /** Unique contacts per 24 hours from the tier; 0 means unlimited. */
  dailyLimit?: number;
};

export type MediaFile = { buffer: Buffer; mimeType: string; filename: string };

export interface WaProvider {
  readonly id: WaProviderId;
  readonly mode: WaMode;
  /** Contacts per API request: 1 for Meta, a chunk for MSG91's bulk endpoint. */
  readonly maxPerRequest: number;
  listTemplates(): Promise<WaTemplate[]>;
  /** Uploads header media and returns the provider's media ID (Meta only). */
  uploadMedia?(file: MediaFile): Promise<string>;
  phoneInfo?(): Promise<PhoneInfo>;
  /** Sends one request. Never throws for API errors: each item gets its own result. */
  send(batch: SendBatch): Promise<ItemResult[]>;
  /** The request body that `send` would use, for showing in the app. Contains no secrets. */
  preview(batch: SendBatch): unknown;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
