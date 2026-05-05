// api/extractCriteria.ts

import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { z } from "zod";

type ExtractCriteriaRequestBody = {
  expectationHorizonText?: string;
  imageBase64?: string;
  imageMimeType?: string;
  fileName?: string;
};

const CriteriaSchema = z.object({
  criteria: z.array(
    z.object({
      bereich: z.string().min(1),
      kriterium: z.string().min(1),
      beschreibung: z.string().min(1),
      erwartung: z.string().min(1),
      gewichtung: z.string().optional().default(""),
      aktiv: z.boolean().optional().default(true),
    })
  ),
});

function setCors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function cleanJsonText(text: string): string {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST.",
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "OPENAI_API_KEY fehlt in den Environment Variables.",
    });
  }

  const body = (req.body ?? {}) as ExtractCriteriaRequestBody;

  const expectationHorizonText = body.expectationHorizonText?.trim() ?? "";
  const imageBase64 = body.imageBase64?.trim() ?? "";
  const imageMimeType = body.imageMimeType?.trim() || "image/png";
  const fileName = body.fileName?.trim() || "Erwartungshorizont";

  if (!expectationHorizonText && !imageBase64) {
    return res.status(400).json({
      error: "Kein Erwartungshorizont übergeben.",
    });
  }

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const systemPrompt = `
Du extrahierst Bewertungskriterien aus einem Erwartungshorizont für schulische Klausuren.

Gib ausschließlich valides JSON zurück.

Format:
{
  "criteria": [
    {
      "bereich": "Inhalt / Analyse / Darstellung / Sprache / Transfer",
      "kriterium": "Kurzer Kriterientitel",
      "beschreibung": "Was wird bewertet?",
      "erwartung": "Welche Leistung wird erwartet?",
      "gewichtung": "hoch / mittel / gering / Prozentangabe / leer",
      "aktiv": true
    }
  ]
}

Regeln:
- Keine übertriebene Kleinteiligkeit.
- Ähnliche Punkte zusammenfassen.
- In der Regel 8 bis 18 Kriterien.
- Keine erfundenen Textdetails.
- Keine Kommentare außerhalb des JSON.
`.trim();

  const userText = `
Dateiname: ${fileName}

Erwartungshorizont:
${expectationHorizonText || "[Bildmaterial wurde übergeben.]"}
`.trim();

  try {
    const content:
      | Array<
          | { type: "text"; text: string }
          | { type: "image_url"; image_url: { url: string } }
        > = [{ type: "text", text: userText }];

    if (imageBase64) {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${imageMimeType};base64,${imageBase64}`,
        },
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content;

    if (!raw) {
      return res.status(502).json({
        error: "Keine auswertbare KI-Antwort erhalten.",
      });
    }

    let parsedJson: unknown;

    try {
      parsedJson = JSON.parse(cleanJsonText(raw));
    } catch {
      return res.status(502).json({
        error: "KI-Antwort war kein valides JSON.",
        raw,
      });
    }

    const parsed = CriteriaSchema.safeParse(parsedJson);

    if (!parsed.success) {
      return res.status(502).json({
        error: "KI-Antwort hat nicht das erwartete Kriterienformat.",
        details: parsed.error.flatten(),
        raw: parsedJson,
      });
    }

    return res.status(200).json({
      criteria: parsed.data.criteria.map((criterion, index) => ({
        id: `criterion-${index + 1}`,
        bereich: criterion.bereich,
        kriterium: criterion.kriterium,
        beschreibung: criterion.beschreibung,
        erwartung: criterion.erwartung,
        gewichtung: criterion.gewichtung ?? "",
        aktiv: criterion.aktiv ?? true,
      })),
    });
  } catch (error) {
    return res.status(500).json({
      error: "extractCriteria ist fehlgeschlagen.",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
