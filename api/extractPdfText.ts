// api/extractPdfText.ts

import pdfParse from "pdf-parse";

export const config = {
  maxDuration: 30,
};

function applyCors(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: any, status: number, payload: unknown) {
  applyCors(res);
  res.setHeader("Content-Type", "application/json");
  return res.status(status).json(payload);
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripDataUrl(value: string): string {
  const cleaned = String(value ?? "").trim();
  const commaIndex = cleaned.indexOf(",");

  if (cleaned.startsWith("data:") && commaIndex >= 0) {
    return cleaned.slice(commaIndex + 1);
  }

  return cleaned;
}

function parseRequestBody(req: any): {
  imageBase64: string;
  fileName: string;
} {
  const body = req.body;

  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      return {
        imageBase64: String(parsed.imageBase64 ?? parsed.fileBase64 ?? ""),
        fileName: String(parsed.fileName ?? "upload.pdf"),
      };
    } catch {
      return {
        imageBase64: body,
        fileName: "upload.pdf",
      };
    }
  }

  return {
    imageBase64: String(body?.imageBase64 ?? body?.fileBase64 ?? ""),
    fileName: String(body?.fileName ?? "upload.pdf"),
  };
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
    const { imageBase64, fileName } = parseRequestBody(req);

    if (!imageBase64) {
      return sendJson(res, 400, {
        ok: false,
        error: "NO_FILE",
      });
    }

    const buffer = Buffer.from(stripDataUrl(imageBase64), "base64");
    const parsed = await pdfParse(buffer);
    const text = cleanText(parsed?.text ?? "");

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
