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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
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
  if (cleaned.startsWith("data:") && commaIndex >= 0) return cleaned.slice(commaIndex + 1);
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

function extractOutputText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;

  const output = Array.isArray(response?.output) ? response.output : [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") return part.text;
    }
  }

  return "";
}

async function extractWithPdfParse(buffer: Buffer): Promise<{ text: string; pages: number | null }> {
  try {
    const parsed = await pdfParse(buffer);
    return {
      text: cleanText(parsed?.text ?? ""),
      pages: parsed?.numpages ?? null,
    };
  } catch {
    return {
      text: "",
      pages: null,
    };
  }
}

async function extractWithOpenAI(params: {
  apiKey: string;
  base64: string;
  fileName: string;
}): Promise<string> {
  const { apiKey, base64, fileName } = params;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Lies den Text aus dieser PDF vollständig aus.",
                "Gib ausschließlich den ausgelesenen Text zurück.",
                "Keine Zusammenfassung.",
                "Keine Analyse.",
                "Keine Bewertung.",
                "Seitenreihenfolge beibehalten.",
              ].join("\n"),
            },
            {
              type: "input_file",
              filename: fileName.toLowerCase().endsWith(".pdf") ? fileName : `${fileName}.pdf`,
              file_data: `data:application/pdf;base64,${base64}`,
            },
          ],
        },
      ],
    }),
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`OPENAI_PDF_TEXT_FAILED: ${response.status} ${raw}`);
  }

  const parsed = JSON.parse(raw);
  return cleanText(extractOutputText(parsed));
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
    const mimeType = String(body.imageMimeType ?? body.fileMimeType ?? "application/pdf").trim();
    const fileName = String(body.fileName ?? "upload.pdf");

    if (!rawBase64) {
      return sendJson(req, res, 400, {
        ok: false,
        error: "NO_FILE",
      });
    }

    if (mimeType !== "application/pdf") {
      return sendJson(req, res, 400, {
        ok: false,
        error: "INVALID_MIME_TYPE",
        received: mimeType,
      });
    }

    const base64 = stripDataUrl(rawBase64);
    const buffer = Buffer.from(base64, "base64");

    const parsed = await extractWithPdfParse(buffer);

    if (parsed.text.length > 0) {
      return sendJson(req, res, 200, {
        ok: true,
        text: parsed.text,
        debug: {
          method: "pdf-parse",
          fileName,
          textLength: parsed.text.length,
          pages: parsed.pages,
        },
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(req, res, 500, {
        ok: false,
        error: "PDF_PARSE_EMPTY_AND_MISSING_OPENAI_API_KEY",
      });
    }

    const openAiText = await extractWithOpenAI({
      apiKey,
      base64,
      fileName,
    });

    return sendJson(req, res, 200, {
      ok: true,
      text: openAiText,
      debug: {
        method: "openai-file-fallback",
        fileName,
        textLength: openAiText.length,
        pages: parsed.pages,
      },
    });
  } catch (error: any) {
    return sendJson(req, res, 500, {
      ok: false,
      error: "PDF_TEXT_EXTRACTION_FAILED",
      message: error?.message ?? String(error),
    });
  }
}
