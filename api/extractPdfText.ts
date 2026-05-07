// api/extractPdfText.ts

import pdfParse from "pdf-parse";

export const config = {
  maxDuration: 30,
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

function applyCors(res: any) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}

function sendJson(res: any, status: number, payload: unknown) {
  applyCors(res);
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
  applyCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const body = req.body ?? {};

    const rawBase64 = String(body.imageBase64 ?? body.fileBase64 ?? "").trim();
    const fileName = String(body.fileName ?? "upload.pdf");

    if (!rawBase64) {
      return sendJson(res, 400, {
        ok: false,
        error: "NO_FILE",
      });
    }

    const buffer = Buffer.from(stripDataUrl(rawBase64), "base64");
    const parsed = await pdfParse(buffer);

    const text = cleanExtractedText(parsed?.text ?? "");

    return sendJson(res, 200, {
      ok: true,
      text,
      debug: {
        method: "pdf-parse",
        fileName,
        textLength: text.length,
        pages: parsed?.numpages ?? null,
      },
    });
  } catch (error: any) {
    return sendJson(res, 500, {
      ok: false,
      error: "PDF_PARSE_FAILED",
      message: error?.message ?? String(error),
    });
  }
}
