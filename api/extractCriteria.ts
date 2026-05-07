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

function clean(value: unknown): string {
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

    const expectationHorizonText = clean(
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

- Keine Wiederholungen
- Keine doppelten Inhalte
- Keine langen Fließtexte
- Keine Rekonstruktion kompletter Absätze
- Keine Formulierungen wie:
  - "Konkrete Anforderungen:"
  - "Erwartet:"
  - "Du hast..."
- Maximal 1-2 Sätze pro Beschreibung
- expectedElements nur als kurze Einzelpunkte
- Niemals denselben Satz mehrfach ausgeben

Antworte ausschließlich als JSON.

FORMAT:

{
  "criteria": [
    {
      "bereich": "Inhalt",
      "kriterium": "Interpretationshypothese",
      "beschreibung": "Hypothese zur Bedeutung formuliert.",
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
  ]
}
`;

    const userPrompt = `
Extrahiere daraus ein sauberes Bewertungsraster:

${expectationHorizonText}
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.1,
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

    const raw =
      completion.choices?.[0]?.message?.content ?? "{}";

    console.log("EXTRACT_CRITERIA_RAW", raw);

    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");

    if (start === -1 || end === -1) {
      return json(res, 500, {
        ok: false,
        error: "NO_JSON_FOUND",
        raw,
      });
    }

    const jsonString = raw.slice(start, end + 1);

    let parsed: any = {};

    try {
      parsed = JSON.parse(jsonString);
    } catch (error: any) {
      return json(res, 500, {
        ok: false,
        error: "INVALID_JSON",
        message: error?.message ?? String(error),
        raw: jsonString,
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
              clean(
                `${clean(item?.label)}: ${clean(item?.erwartung)}`,
              ),
            ),
          ).map((line) => {
            const parts = line.split(":");

            return {
              label: clean(parts[0]),
              erwartung: clean(parts.slice(1).join(":")),
            };
          })
        : [];

      return {
        id: criterion.id ?? `crit-${index}`,

        bereich: clean(criterion.bereich),

        kriterium: clean(criterion.kriterium),

        beschreibung: clean(criterion.beschreibung),

        erwartung: clean(criterion.erwartung),

        expectedElements,

        gewichtung: clean(criterion.gewichtung || "mittel"),

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
    console.error("EXTRACT_CRITERIA_FATAL", error);

    return json(res, 500, {
      ok: false,
      error: "EXTRACT_FAILED",
      message: error?.message ?? String(error),
    });
  }
}
