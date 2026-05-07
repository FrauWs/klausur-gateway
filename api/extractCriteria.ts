// api/extractCriteria.ts

export const config = {
  runtime: "nodejs",
  maxDuration: 30,
};

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
  res.status(status).json(payload);
}

function clean(input: unknown): string {
  return String(input ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractJson(raw: string) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start === -1 || end === -1) {
    throw new Error("NO_JSON_IN_OPENAI_RESPONSE");
  }

  return JSON.parse(raw.slice(start, end + 1));
}

export default async function handler(req: any, res: any) {
  applyCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return json(res, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return json(res, 500, {
        ok: false,
        error: "MISSING_OPENAI_API_KEY",
      });
    }

    const expectationHorizonText = clean(
      req.body?.expectationHorizonText ?? "",
    );

    if (!expectationHorizonText) {
      return json(res, 400, {
        ok: false,
        error: "NO_EXPECTATION_HORIZON_TEXT",
      });
    }

    const prompt = `
Extrahiere aus dem folgenden Bewertungsraster eine strukturierte Kriterienliste.

Regeln:
- Keine Wiederholungen.
- Kurze Kriterien.
- expectedElements nur als konkrete Stichpunkte.
- Kein Fließtext.
- Maximal 16 Kriterien.
- Antworte ausschließlich als JSON.

Format:
{
  "criteria": [
    {
      "bereich": "Inhalt",
      "kriterium": "Interpretationshypothese",
      "beschreibung": "Die Deutungsidee wird nachvollziehbar dargestellt.",
      "erwartung": "Eine schlüssige Interpretation wird formuliert.",
      "expectedElements": [
        {
          "label": "Symbolik",
          "erwartung": "Der Pflaumenbaum wird symbolisch gedeutet."
        }
      ],
      "gewichtung": "hoch",
      "aktiv": true
    }
  ]
}

TEXT:
${expectationHorizonText.slice(0, 12000)}
`.trim();

    const openAiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "Du extrahierst Bewertungsraster und antwortest ausschließlich mit validem JSON.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      },
    );

    const raw = await openAiResponse.text();

    if (!openAiResponse.ok) {
      return json(res, 500, {
        ok: false,
        error: "OPENAI_REQUEST_FAILED",
        status: openAiResponse.status,
        raw,
      });
    }

    const parsedOpenAi = JSON.parse(raw);

    const content =
      parsedOpenAi?.choices?.[0]?.message?.content ?? "{}";

    const parsed = extractJson(content);

    return json(res, 200, {
      ok: true,
      criteria: parsed.criteria ?? [],
      usage: parsedOpenAi?.usage ?? null,
    });
  } catch (error: any) {
    console.error("extractCriteria crash", error);

    return json(res, 500, {
      ok: false,
      error: "EXTRACT_CRITERIA_FAILED",
      message: error?.message ?? String(error),
      stack:
        process.env.NODE_ENV === "development"
          ? error?.stack
          : undefined,
    });
  }
}
