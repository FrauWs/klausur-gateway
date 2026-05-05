// api/extractCriteria.ts

import OpenAI from "openai";

export default async function handler(req: any, res: any) {
  // --- CORS ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const { expectationHorizonText } = req.body || {};

    if (!expectationHorizonText) {
      return res.status(400).json({ error: "No input text" });
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
Extrahiere Bewertungskriterien aus einem Erwartungshorizont.

Gib JSON zurück:

{
  "summary": "2-4 Sätze Zusammenfassung",
  "criteria": [
    {
      "bereich": "...",
      "kriterium": "...",
      "beschreibung": "...",
      "erwartung": "...",
      "gewichtung": "...",
      "aktiv": true
    }
  ]
}

Regeln:
- max. ca. 10–15 Kriterien
- keine Mini-Zerlegung
- keine Kommentare außerhalb JSON
          `.trim(),
        },
        {
          role: "user",
          content: expectationHorizonText,
        },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content;

    if (!raw) {
      return res.status(500).json({ error: "No AI response" });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: "Invalid JSON from AI", raw });
    }

    return res.status(200).json({
      summary: parsed.summary || "",
      criteria: (parsed.criteria || []).map((c: any, i: number) => ({
        id: `criterion-${i + 1}`,
        bereich: c.bereich || "",
        kriterium: c.kriterium || "",
        beschreibung: c.beschreibung || "",
        erwartung: c.erwartung || "",
        gewichtung: c.gewichtung || "",
        aktiv: c.aktiv ?? true,
      })),
    });
  } catch (err: any) {
    return res.status(500).json({
      error: "Server error",
      message: err.message,
    });
  }
}
