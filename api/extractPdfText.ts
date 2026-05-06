// api/extractPdfText.ts

import pdfParse from "pdf-parse";

export const config = {
  maxDuration: 30,
};

function setCors(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res: any, status: number, payload: unknown) {
  setCors(res);
  res.setHeader("Content-Type", "application/json");
  return res.status(status).json(payload);
}

export default async function handler(req: any, res: any) {
  setCors(res);

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
    const { imageBase64, imageMimeType, fileName } = req.body ?? {};

    if (!imageBase64) {
      return sendJson(res, 400, {
        ok: false,
        error: "NO_FILE",
      });
    }

    if (imageMimeType !== "application/pdf") {
      return sendJson(res, 400, {
        ok: false,
        error: "INVALID_MIME_TYPE",
      });
    }

    const buffer = Buffer.from(String(imageBase64), "base64");
    const parsed = await pdfParse(buffer);

    const text = String(parsed.text ?? "")
      .replace(/\u0000/g, "")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return sendJson(res, 200, {
      ok: true,
      text,
      debug: {
        fileName: String(fileName ?? "upload.pdf"),
        textLength: text.length,
        pages: parsed.numpages ?? null,
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
