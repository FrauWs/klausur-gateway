// api/extractPdfText.ts

import pdf from "pdf-parse";

export const config = {
  runtime: "nodejs",
  maxDuration: 30,
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function applyCors(res: any) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}

function json(res: any, status: number, payload: unknown) {
  applyCors(res);
  res.status(status).json(payload);
}

function cleanText(input: unknown): string {
  return String(input ?? "")
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
    return json(res, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const base64 = String(req.body?.fileBase64 ?? "").trim();

    if (!base64) {
      return json(res, 400, {
        ok: false,
        error: "NO_FILE_BASE64",
      });
    }

    const pureBase64 = base64.includes(",")
      ? base64.split(",")[1]
      : base64;

    const buffer = Buffer.from(pureBase64, "base64");

    const parsed = await pdf(buffer);

    const text = cleanText(parsed?.text ?? "");

    return json(res, 200, {
      ok: true,
      text,
      debug: {
        textLength: text.length,
        pages: parsed?.numpages ?? null,
      },
    });
  } catch (error: any) {
    console.error("extractPdfText crash", error);

    return json(res, 500, {
      ok: false,
      error: "PDF_TEXT_EXTRACTION_FAILED",
      message: error?.message ?? String(error),
    });
  }
}
