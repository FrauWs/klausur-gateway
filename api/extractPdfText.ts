// api/extractPdfText.ts

import pdfParse from "pdf-parse";

export const config = {
  maxDuration: 30,
};

const ALLOWED_ORIGINS = new Set([
  "https://korrekturraum.vercel.app",
  "https://klausur-gateway.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
]);

function getAllowedOrigin(req: any): string {
  const origin = String(req.headers?.origin ?? "");
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  return "https://korrekturraum.vercel.app";
}

function setCors(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", getAllowedOrigin(req));
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(req: any, res: any, status: number, payload: unknown) {
  setCors(req, res);
  res.setHeader("Content-Type", "application/json");
  return res.status(status).json(payload);
}

function stripDataUrl(value: string): string {
  const cleaned = String(value ?? "").trim();
  const commaIndex = cleaned.indexOf(",");
  if (cleaned.startsWith("data:") && commaIndex >= 0) {
    return cleaned.slice(commaIndex + 1);
  }
  return cleaned;
}

function cleanExtractedText(value: unknown): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default async function handler(req: any, res: any) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return sendJson(req, res, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const body = req.body ?? {};

    const rawBase64 = String(body.imageBase64 ?? body.fileBase64 ?? "").trim();
    const imageMimeType = String(body.imageMimeType ?? body.fileMimeType ?? "").trim();
    const fileName = String(body.fileName ?? "upload.pdf");

    if (!rawBase64) {
      return sendJson(req, res, 400, {
        ok: false,
        error: "NO_FILE",
      });
    }

    if (imageMimeType && imageMimeType !== "application/pdf") {
      return sendJson(req, res, 400, {
        ok: false,
        error: "INVALID_MIME_TYPE",
        received: imageMimeType,
      });
    }

    const buffer = Buffer.from(stripDataUrl(rawBase64), "base64");
    const parsed = await pdfParse(buffer);

    const text = cleanExtractedText(parsed.text);

    return sendJson(req, res, 200, {
      ok: true,
      text,
      debug: {
        fileName,
        textLength: text.length,
        pages: parsed.numpages ?? null,
      },
    });
  } catch (error: any) {
    return sendJson(req, res, 500, {
      ok: false,
      error: "PDF_PARSE_FAILED",
      message: error?.message ?? String(error),
    });
  }
}
