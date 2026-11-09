import { randomUUID } from "node:crypto";
import { HttpError } from "../http.js";
import type { FetchLike, WaProvider } from "./providers/types.js";
import type { WaMedia, WaProviderId } from "./types.js";

export const MEDIA_LIMITS = { image: 5 * 1024 * 1024, document: 16 * 1024 * 1024 } as const;

export type StoredMedia = {
  ref: string;
  kind: "image" | "document";
  filename: string;
  mimeType: string;
  buffer?: Buffer;
  link?: string;
  /** Media IDs from providers that needed an upload, so each file is uploaded once. */
  providerIds: Partial<Record<WaProviderId, string>>;
};

/** Works out the file type from its first bytes, not its name. */
export function detectMedia(buffer: Buffer): { kind: "image" | "document"; mimeType: string } | undefined {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { kind: "image", mimeType: "image/jpeg" };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", mimeType: "image/png" };
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "document", mimeType: "application/pdf" };
  return undefined;
}

/** Keeps the last few header files in memory for this session. */
export class MediaStore {
  private readonly items = new Map<string, StoredMedia>();

  constructor(private readonly limit = 20) {}

  addFile(buffer: Buffer, filename: string): StoredMedia {
    const type = detectMedia(buffer);
    if (!type) throw new HttpError(400, "Use a JPEG or PNG image, or a PDF document.");
    if (buffer.length > MEDIA_LIMITS[type.kind]) {
      throw new HttpError(413, type.kind === "image" ? "Images can be up to 5 MB." : "PDF documents can be up to 16 MB.");
    }
    return this.save({ ref: randomUUID(), ...type, filename: safeName(filename, type.kind), buffer, providerIds: {} });
  }

  addLink(link: string, kind: "image" | "document", filename?: string): StoredMedia {
    const mimeType = kind === "image" ? "image/*" : "application/pdf";
    const name = filename || decodeURIComponent(new URL(link).pathname.split("/").pop() || "") || (kind === "image" ? "image" : "document.pdf");
    return this.save({ ref: randomUUID(), kind, filename: safeName(name, kind), mimeType, link, providerIds: {} });
  }

  get(ref: string): StoredMedia {
    const media = this.items.get(ref);
    if (!media) throw new HttpError(404, "The header file has expired. Please add it again.");
    return media;
  }

  private save(media: StoredMedia): StoredMedia {
    this.items.set(media.ref, media);
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value!);
    return media;
  }
}

function safeName(name: string, kind: "image" | "document"): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, "_").slice(0, 100) || "file";
  return kind === "document" && !/\.pdf$/i.test(cleaned) ? `${cleaned}.pdf` : cleaned;
}

/**
 * Turns a stored file into what the provider needs: Meta gets an uploaded media ID (uploaded
 * once and reused), MSG91 needs a public link. In Simulate mode nothing is uploaded.
 */
export async function mediaForProvider(media: StoredMedia, provider: WaProvider): Promise<WaMedia> {
  const base = { kind: media.kind, filename: media.filename };
  if (media.link) return { ...base, link: media.link };
  if (provider.id === "msg91") {
    if (provider.mode === "simulate") return base;
    throw new HttpError(400, "MSG91 needs a public link (https://…) to the header file. Paste a link instead of uploading the file.");
  }
  if (provider.mode === "simulate") return { ...base, id: `SIM-MEDIA-${media.ref.slice(0, 8)}` };
  if (!media.providerIds.meta) {
    if (!provider.uploadMedia || !media.buffer) throw new HttpError(400, "This header file can't be uploaded. Add it again.");
    media.providerIds.meta = await provider.uploadMedia({ buffer: media.buffer, mimeType: media.mimeType, filename: media.filename });
  }
  return { ...base, id: media.providerIds.meta };
}

/** Checks that a pasted link is public HTTPS and points at the right kind of file. */
export async function checkMediaLink(link: string, kind: "image" | "document", fetchImpl: FetchLike = fetch): Promise<void> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new HttpError(400, "That isn't a valid link.");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "The link must start with https://");
  let res: Response;
  try {
    res = await fetchImpl(link, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new HttpError(400, "Couldn't open that link from this computer. Check it opens in a private browser window.");
  }
  if (res.status === 405 || res.status === 501) return; // Some servers don't answer HEAD; the provider will fetch it.
  if (!res.ok) throw new HttpError(400, `The link answered with HTTP ${res.status}. It must be publicly reachable.`);
  const type = res.headers.get("content-type") ?? "";
  const ok = kind === "image" ? /^image\/(jpeg|png)/i.test(type) : /^application\/pdf/i.test(type);
  if (type && !ok) {
    throw new HttpError(400, `The link points to "${type}", not ${kind === "image" ? "a JPEG or PNG image" : "a PDF"}.`);
  }
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > MEDIA_LIMITS[kind]) throw new HttpError(400, `The file is too large (limit ${MEDIA_LIMITS[kind] / 1024 / 1024} MB).`);
}
