// api/extractCriteria.ts

import { z } from "zod";

export const config = {
  maxDuration: 30,
};

const BodySchema = z.object({
  expectationHorizonText: z.string().optional(),
  imageBase64: z.string().optional(),
  imageMimeType: z.string().optional(),
  fileName: z.string().optional(),
  instructions: z.string().optional(),
});

function setCors(req: any, res: any) {
  const origin = req.headers.origin || "*";

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization",
  );
}

function sendJson(req: any, res: any, status: number, payload: unknown) {
  setCors(req, res);
  return res.status(status).json(payload);
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
    const parsed = BodySchema.parse(req.body ?? {});

    const expectationHorizonText = String(
      parsed.expectationHorizonText ?? "",
    ).trim();

    const shortenedText = expectationHorizonText
      .replace(/\s+/g, " ")
      .slice(0, 4000);

    console.log("EXTRACT_CRITERIA_INPUT", {
      originalLength: expectationHorizonText.length,
      shortenedLength: shortenedText.length,
      preview: shortenedText.slice(0, 1000),
    });

    if (!shortenedText) {
      return sendJson(req, res, 400, {
        ok: false,
        error: "NO_TEXT",
      });
    }

    // TEMP DEBUG RESPONSE
    // Damit prüfen wir erstmal:
    // Route stabil?
    // Kein 504 mehr?
    // Frontend verarbeitet Antwort korrekt?

    return sendJson(req, res, 200, {
      ok: true,
      summary: "Debug-Antwort aktiv",
      criteria: [
        {
          id: "crit-0",
          bereich: "Debug",
          kriterium: "Text erkannt",
          beschreibung: shortenedText.slice(0, 300),
          erwartung: "Debug",
          expectedElements: [
            {
              label: "Debug",
              erwartung: "Debug",
            },
          ],
          gewichtung: "hoch",
          aktiv: true,
        },
      ],
      debug: {
        originalLength: expectationHorizonText.length,
        shortenedLength: shortenedText.length,
      },
    });
  } catch (error: any) {
    console.error("EXTRACT_CRITERIA_ERROR", error);

    return sendJson(req, res, 500, {
      ok: false,
      error: "EXTRACT_CRITERIA_FAILED",
      message: error?.message ?? String(error),
    });
  }
}
