import type { ErrorRequestHandler, RequestHandler } from "express";
import multer from "multer";
import { ZodError } from "zod";
import { FileFormatError } from "./services/parseContacts.js";
import { WaApiError } from "./whatsapp/errors.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Only answers requests addressed to this computer. This stops a web page on another site
 * from pointing its own domain at 127.0.0.1 (DNS rebinding) and sending SMS on your account.
 */
export function hostCheck(extraHosts: string[], webhookHost = ""): RequestHandler {
  const allowed = new Set(["localhost", "127.0.0.1", "[::1]", ...extraHosts]);
  return (req, res, next) => {
    const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (allowed.has(host)) return next();
    // A public tunnel address (for WhatsApp delivery receipts) may reach the signed webhook and nothing else.
    if (webhookHost && host === webhookHost && req.path.startsWith("/webhooks/")) return next();
    res
      .status(403)
      .type("text/plain")
      .send(`Host "${host}" is not allowed. Open the app at http://localhost, or add the host to ALLOWED_HOSTS in .env.`);
  };
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
  } else if (err instanceof ZodError) {
    const issue = err.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    res.status(400).json({ error: `${where}${issue?.message ?? "Invalid request"}` });
  } else if (err instanceof WaApiError) {
    res.status(502).json({ error: err.message });
  } else if (err instanceof FileFormatError) {
    res.status(400).json({ error: err.message });
  } else if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE" ? "The file is larger than 5 MB." : err.message;
    res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: message });
  } else if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "The request body isn't valid JSON." });
  } else {
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server. Check the terminal for details." });
  }
};
