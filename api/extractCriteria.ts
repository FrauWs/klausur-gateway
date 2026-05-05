// api/extractCriteria.ts

import OpenAI from "openai";
import { z } from "zod";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

type ExtractCriteriaRequestBody = {
  expectationHorizonText?: string;
  imageBase64?: string;
  imageMimeType?: string;
  fileName?: string;
};

function withCors(response: Response): Response {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

function jsonResponse(data: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    })
  );
}

function cleanJsonText(text: string): string {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function readBody(req: Request): Promise<ExtractCriteriaRequestBody> {
  try {
    return (await req.json()) as ExtractCriteriaRequestBody;
  } catch {
    return {};
  }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed. Use POST." },
      405
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return jsonResponse(
      { error: "OPENAI_API_KEY fehlt in den Environment Variables." },
      500
    );
  }

  const body = await readBody(req);

  const expectationHorizonText = body.expectationHorizonText?.trim() ?? "";
  const imageBase64 = body.imageBase64?.trim() ?? "";
  const imageMimeType = body.imageMimeType?.trim() || "image/png";
  const fileName = body.fileName?.trim() ?? "Erwartungshorizont";

  if (!expectationHorizonText && !imageBase64) {
    return jsonResponse(
      {
        error:
          "Kein Erwartungshorizont übergeben. Bitte Text oder Bilddaten senden.",
      },
      400
    );
  }

  const openai = new OpenAI({ apiKey });

  const systemPrompt = `
Du extrahierst Bewertungskriterien aus einem Erwartungshorizont für schulische Klausuren.

Ziel:
- Keine übertriebene Kleinteiligkeit.
- Keine 60+ Einzelkriterien.
- Kriterien sollen fachlich sinnvoll, prüfbar und bewertbar sein.
- Formuliere für Lehrpersonen, nicht für Schüler*innen.
- Gib ausschließlich valides JSON zurück.

Struktur:
{
  "criteria": [
    {
      "bereich": "Inhalt / Analyse / Darstellung / Sprache / Transfer / ...",
      "kriterium": "Kurzer Kriterientitel",
      "beschreibung": "Was wird bewertet?",
      "erwartung": "Welche Leistung wird erwartet?",
      "gewichtung": "optional, z. B. hoch / mittel / gering / 20%",
      "aktiv": true
    }
  ]
}

Regeln:
- Fasse ähnliche Punkte zusammen.
- Trenne nur dann, wenn tatsächlich unterschiedliche Leistungen bewertet werden.
- Für Abitur-/Oberstufenaufgaben reichen meist 8 bis 18 Kriterien.
- Falls der Erwartungshorizont Operatoren enthält, berücksichtige sie.
- Falls Aufgabenbereiche erkennbar sind, gliedere danach.
- Keine erfundenen Textdetails.
- Keine Kommentare außerhalb des JSON.
`.trim();

  const userText = `
Dateiname: ${fileName}

Erwartungshorizont / Material:
${expectationHorizonText || "[Bildmaterial wurde übergeben.]"}
`.trim();

  try {
    const content:
      | Array<
          | { type: "text"; text: string }
          | {
              type: "image_url";
              image_url: { url: string };
            }
        >
      = [{ type: "text", text: userText }];

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
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content;

    if (!raw) {
      return jsonResponse(
        { error: "Die KI hat keine auswertbare Antwort geliefert." },
        502
      );
    }

    let parsedUnknown: unknown;

    try {
      parsedUnknown = JSON.parse(cleanJsonText(raw));
    } catch {
      return jsonResponse(
        {
          error: "Die KI-Antwort war kein valides JSON.",
          raw,
        },
        502
      );
    }

    const parsed = CriteriaSchema.safeParse(parsedUnknown);

    if (!parsed.success) {
      return jsonResponse(
        {
          error: "Die extrahierten Kriterien entsprechen nicht dem erwarteten Format.",
          details: parsed.error.flatten(),
          raw: parsedUnknown,
        },
        502
      );
    }

    return jsonResponse({
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
    const message =
      error instanceof Error ? error.message : "Unbekannter Serverfehler.";

    return jsonResponse(
      {
        error: "extractCriteria ist fehlgeschlagen.",
        message,
      },
      500
    );
  }
}
