// api/extractCriteria.ts

import OpenAI from "openai";

type Req = {
  method?: string;
  body?: any;
};

type Res = {
  status: (code: number) => Res;
  json: (data: any) => void;
  end: () => void;
  setHeader: (key: string, value: string) => void;
};

function setCors(res: Res) {
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

function normalizeCriteria(input: any) {
  const rawCriteria = Array.isArray(input?.criteria) ? input.criteria : [];

  return rawCriteria
    .filter((item) => item && typeof item === "object")
    .map((item, index) => ({
      id: item.id || `criterion-${index + 1}`,
      bereich: String(item.bereich || "Allgemein"),
      kriterium: String(item.kriterium || item.title || `Kriterium ${index + 1}`),
      beschreibung: String(item.beschreibung || ""),
      erwartung: String(item.erwartung || ""),
      gewichtung: String(item.gewichtung || ""),
      aktiv: typeof item.aktiv === "boolean" ? item.aktiv : true,
    }))
    .filter((item) => item.kriterium.trim().length > 0);
}

export default async function handler(req: Req, res: Res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST.",
    });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OPENAI_API_KEY fehlt.",
      });
    }

    const body = req.body || {};

    const expectationHorizonText = String(body.expectationHorizonText || "").trim();
    const imageBase64 = String(body.imageBase64 || "").trim();
    const imageMimeType = String(body.imageMimeType || "image/png").trim();
    const fileName = String(body.fileName || "Erwartungshorizont").trim();

    if (!expectationHorizonText && !imageBase64) {
      return res.status(400).json({
        error: "Kein Erwartungshorizont übergeben.",
      });
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const systemPrompt = `
Du extrahierst Bewertungskriterien aus einem schulischen Erwartungshorizont.

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
- Normalerweise 8 bis 18 Kriterien.
- Keine erfundenen Textdetails.
- Keine Kommentare außerhalb des JSON.
`.trim();

    const userText = `
Dateiname: ${fileName}

Erwartungshorizont:
${expectationHorizonText || "[Bildmaterial wurde übergeben.]"}
`.trim();

    const content: any[] = [{ type: "text", text: userText }];

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
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content;

    if (!raw) {
      return res.status(502).json({
        error: "Keine KI-Antwort erhalten.",
      });
    }

    let parsed: any;

    try {
      parsed = JSON.parse(cleanJsonText(raw));
    } catch {
      return res.status(502).json({
        error: "KI-Antwort war kein valides JSON.",
        raw,
      });
    }

    const criteria = normalizeCriteria(parsed);

    if (criteria.length === 0) {
      return res.status(502).json({
        error: "Es konnten keine Kriterien extrahiert werden.",
        raw: parsed,
      });
    }

    return res.status(200).json({
      criteria,
    });
  } catch (error) {
    return res.status(500).json({
      error: "extractCriteria ist fehlgeschlagen.",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
