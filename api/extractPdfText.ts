// api/extractPdfText.ts

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

function stripDataUrl(value: string): string {
  const cleaned = String(value ?? "").trim();
  const commaIndex = cleaned.indexOf(",");
  if (cleaned.startsWith("data:") && commaIndex >= 0) {
    return cleaned.slice(commaIndex + 1);
  }
  return cleaned;
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    const { fileBase64, imageBase64, fileName } = req.body ?? {};
    const base64 = stripDataUrl(String(fileBase64 ?? imageBase64 ?? ""));

    if (!base64) {
      return sendJson(res, 400, {
        ok: false,
        error: "EMPTY_INPUT",
      });
    }

    const buffer = Buffer.from(base64, "base64");

    const pdfParseModule: any = await import("pdf-parse");
    const pdfParse = pdfParseModule.default ?? pdfParseModule;

    const result = await pdfParse(buffer);
    const text = cleanText(result?.text ?? "");

    return sendJson(res, 200, {
      ok: true,
      fileName: String(fileName ?? "upload.pdf"),
      text,
      textLength: text.length,
      pages: result?.numpages ?? null,
    });
  } catch (error: any) {
    return sendJson(res, 500, {
      ok: false,
      error: "PDF_TEXT_EXTRACTION_FAILED",
      message: error?.message ?? String(error),
    });
  }
}
