// api/extractCriteria.ts

import OpenAI from "openai";

declare const process: {
  env: {
    OPENAI_API_KEY?: string;
  };
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
  return res.status(status).json(payload);
}

function cleanup(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();

  return lines.filter((line) => {
    const normalized = line
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) return false;

    if (seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
}

export default async function handler(req: any, res: any) {
  if (req.method === "OPTIONS") {
    applyCors(res);
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return json(res, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const body = req.body ?? {};

    const expectationHorizonText = cleanup(
      body.expectationHorizonText,
    );

    if (!expectationHorizonText) {
      return json(res, 400, {
        ok: false,
        error: "NO_TEXT",
      });
    }

    const systemPrompt = `
Du extrahierst Bewertungsraster aus deutschen Erwartungshorizonten.

WICHTIGE REGELN:

1. Keine Wiederholungen.
2. Keine doppelten Inhalte.
3. Keine Rekonstruktion ganzer Absätze.
4. Keine Vermischung mehrerer Kriterien.
5. Jedes Kriterium MUSS kurz und eindeutig sein.
6. expectedElements dürfen nur konkrete Stichpunkte enthalten.
7. Keine Formulierungen wie:
   - "Konkrete Anforderungen:"
   - "Erwartet:"
   - "Du hast..."
8. Niemals denselben Satz mehrfach ausgeben.
9. Keine langen Fließtexte.
10. Maximal 1-2 Sätze pro Beschreibung.
11. expectedElements nur als kurze Einzelpunkte.
12. Keine Rekonstruktion des kompletten Erwartungshorizonts.

FORMAT:

{
  "bereich": "Inhalt",
  "kriterium": "Interpretationshypothese",
  "beschreibung": "Hypothese zur Bedeutung des Gedichts formuliert.",
  "erwartung": "Deutung nachvollziehbar erklärt.",
  "expectedElements": [
    {
      "label": "Symbolik",
      "erwartung": "Pflaumenbaum als Symbol erkannt."
    }
  ],
  "gewichtung": "mittel",
  "aktiv": true
}
`;

    const userPrompt = `
Extrahiere daraus ein sauberes Bewertungsraster:

${expectationHorizonText}
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.1,
      response_format: {
        type: "json_object",
      },
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content ?? "{}";

    let parsed: any = {};

    try {
      parsed = JSON.parse(raw);
    } catch {
      return json(res, 500, {
        ok: false,
        error: "INVALID_JSON",
        raw,
      });
    }

    const criteriaRaw = Array.isArray(parsed.criteria)
      ? parsed.criteria
      : [];

    const criteria = criteriaRaw.map((criterion: any, index: number) => {
      const expectedElements = Array.isArray(
        criterion.expectedElements,
      )
        ? dedupe(
            criterion.expectedElements.map((item: any) =>
              cleanup(
                `${cleanup(item?.label)}: ${cleanup(item?.erwartung)}`,
              ),
            ),
          ).map((line) => {
            const parts = line.split(":");

            return {
              label: cleanup(parts[0]),
              erwartung: cleanup(parts.slice(1).join(":")),
            };
          })
        : [];

      return {
        id: criterion.id ?? `crit-${index}`,

        bereich: cleanup(criterion.bereich),

        kriterium: cleanup(criterion.kriterium),

        beschreibung: cleanup(criterion.beschreibung),

        erwartung: cleanup(criterion.erwartung),

        expectedElements,

        gewichtung: cleanup(criterion.gewichtung || "mittel"),

        aktiv: criterion.aktiv !== false,
      };
    });

    return json(res, 200, {
      ok: true,
      criteria,
      debug: {
        count: criteria.length,
        sourceTextLength: expectationHorizonText.length,
      },
    });
  } catch (error: any) {
    return json(res, 500, {
      ok: false,
      error: "EXTRACT_FAILED",
      message: error?.message ?? String(error),
    });
  }
}
