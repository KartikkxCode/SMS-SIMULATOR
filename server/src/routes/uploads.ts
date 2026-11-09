import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { Config } from "../config.js";
import { HttpError } from "../http.js";
import { toCsv } from "../services/csv.js";
import { parseContactsFile, suggestPhoneColumn, type ParsedSheet } from "../services/parseContacts.js";
import { checkContacts, type ContactCheck } from "../services/phone.js";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_MANUAL_CONTACTS = 1000;
const PREVIEW_ROWS = 10;
const LIST_LIMIT = 500;

export type Upload = { id: string; fileName: string; sheet: ParsedSheet };

/** Keeps the last few uploaded files in memory so the browser doesn't have to send contacts back. */
export class UploadStore {
  private readonly uploads = new Map<string, Upload>();

  constructor(private readonly limit = 10) {}

  add(fileName: string, sheet: ParsedSheet): Upload {
    const upload = { id: randomUUID(), fileName, sheet };
    this.uploads.set(upload.id, upload);
    while (this.uploads.size > this.limit) this.uploads.delete(this.uploads.keys().next().value!);
    return upload;
  }

  get(id: string): Upload {
    const upload = this.uploads.get(id);
    if (!upload) throw new HttpError(404, "This upload has expired. Please upload the file again.");
    return upload;
  }
}

export function contactsFor(upload: Upload, column: number, countryCode: string): ContactCheck {
  const { sheet } = upload;
  if (column >= sheet.columns.length) throw new HttpError(400, "That column doesn't exist in the file.");
  return checkContacts(
    sheet.rows.map((cells, i) => ({ row: sheet.rowNumbers[i]!, value: cells[column] ?? "" })),
    countryCode,
  );
}

const columnQuery = z.object({ column: z.coerce.number().int().min(0) });

const manualBody = z.object({
  contacts: z
    .array(z.object({ name: z.string().max(100).default(""), phone: z.string().max(30) }))
    .min(1, "Add at least one number.")
    .max(MAX_MANUAL_CONTACTS, `You can type up to ${MAX_MANUAL_CONTACTS} contacts. For more, upload a file.`),
});

/** Contacts typed in the app become a two-column sheet, so everything after the upload works the same. */
export function manualSheet(contacts: Array<{ name: string; phone: string }>): ParsedSheet {
  const kept = contacts.map((c) => [c.name.trim(), c.phone.trim()]).filter(([name, phone]) => name || phone);
  if (kept.length === 0) throw new HttpError(400, "Add at least one number.");
  return { columns: ["Name", "Phone"], rows: kept, rowNumbers: kept.map((_, i) => i + 1) };
}

function uploadInfo(saved: Upload, phoneColumn: number) {
  return {
    uploadId: saved.id,
    fileName: saved.fileName,
    columns: saved.sheet.columns,
    rowCount: saved.sheet.rows.length,
    preview: saved.sheet.rows.slice(0, PREVIEW_ROWS),
    phoneColumn,
  };
}

export function uploadsRouter(uploads: UploadStore, config: Config): Router {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  router.post("/upload", upload.single("file"), async (req, res) => {
    if (!req.file) throw new HttpError(400, "Choose a .csv or .xlsx file to upload.");
    const sheet = await parseContactsFile(req.file.originalname, req.file.buffer);
    const saved = uploads.add(req.file.originalname, sheet);
    res.json(uploadInfo(saved, suggestPhoneColumn(sheet)));
  });

  router.post("/upload/manual", (req, res) => {
    const { contacts } = manualBody.parse(req.body ?? {});
    const sheet = manualSheet(contacts);
    const saved = uploads.add(`Typed contacts (${sheet.rows.length})`, sheet);
    res.json(uploadInfo(saved, 1));
  });

  router.get("/uploads/:id/contacts", (req, res) => {
    const { column } = columnQuery.parse(req.query);
    const check = contactsFor(uploads.get(req.params.id), column, config.defaultCountryCode);
    res.json({
      column,
      validCount: check.valid.length,
      invalidCount: check.invalid.length,
      duplicateCount: check.duplicates.length,
      sample: check.valid.slice(0, 5),
      invalid: check.invalid.slice(0, LIST_LIMIT),
      duplicates: check.duplicates.slice(0, LIST_LIMIT),
    });
  });

  router.get("/uploads/:id/problems.csv", (req, res) => {
    const { column } = columnQuery.parse(req.query);
    const check = contactsFor(uploads.get(req.params.id), column, config.defaultCountryCode);
    const rows = [
      ...check.invalid.map((c) => [c.row, c.value, c.reason]),
      ...check.duplicates.map((c) => [c.row, c.number, `Duplicate of row ${c.firstRow} (sent once)`]),
    ].sort((a, b) => Number(a[0]) - Number(b[0]));
    res.attachment("skipped-contacts.csv").type("text/csv").send(toCsv(["file_row", "value", "problem"], rows));
  });

  return router;
}
