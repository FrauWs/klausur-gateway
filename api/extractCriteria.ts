// api/extractCriteria.ts

declare const process: {
  env: {
    OPENAI_API_KEY?: string;
  };
};

type ExtractCriteriaRequestBody = {
  expectationHorizonText?: string;
};

type ExtractedCriterion = {
  area: string;
  name: string;
  expectedElements: string[];
  weighting: string;
};

type ExtractCriteriaResult = {
  criteria?: ExtractedCriterion[];
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

function sendJson(res: any, status: number, payload: unknown) {
  applyCors(res);
  res.setHeader("Content-Type", "application/json");
  return res.status(status).json(payload);
}

export default async function handler(req: any, res: any) {
  applyCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      method: req.method,
    });
  }

  try {
    const body = (req.body ?? {}) as ExtractCriteriaRequestBody;
    const expectationHorizonText = String(body.expectationHorizonText ?? "").trim();

    if (!expectationHorizonText) {
      return sendJson(res, 400, {
        ok: false,
        error: "MISSING_EXPECTATION_HORIZON",
        message: "expectationHorizonText fehlt.",
      });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!OPENAI_API_KEY) {
      return sendJson(res, 500, {
        ok: false,
        error: "MISSING_API_KEY",
        message: "OPENAI_API_KEY ist nicht gesetzt.",
      });
    }

    const prompt = buildPrompt(expectationHorizonText);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Du extrahierst ausschließlich Bewertungskriterien aus schulischen Bewertungsrastern und Erwartungshorizonten. Du gibst ausschließlich gültiges JSON zurück.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();

      return sendJson(res, 500, {
        ok: false,
        error: "OPENAI_ERROR",
        details: text,
      });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? "";

    let parsed: ExtractCriteriaResult;

    try {
      parsed = JSON.parse(content) as ExtractCriteriaResult;
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "INVALID_JSON_FROM_MODEL",
        raw: content,
      });
    }

    const criteria = normalizeCriteria(parsed.criteria);

    return sendJson(res, 200, {
      ok: true,
      criteria,
      usage: data?.usage ?? null,
    });
  } catch (err: any) {
    return sendJson(res, 500, {
      ok: false,
      error: err?.name === "AbortError" ? "TIMEOUT" : "UNKNOWN_ERROR",
      message: err?.message ?? "Unbekannter Fehler.",
    });
  }
}

function buildPrompt(expectationHorizonText: string) {
  return `
Extrahiere aus dem folgenden Erwartungshorizont ein klares Bewertungsraster.

ERWARTUNGSHORIZONT:
${expectationHorizonText}

AUFGABE:
- Finde die tatsächlichen Bewertungskriterien.
- Gruppiere sie in sinnvolle Bereiche.
- Erfinde keine Kriterien.
- Halte die Kriterien prüfbar und knapp.
- Vermeide Dopplungen.
- Wenn Gewichtungen genannt werden, übernimm sie.
- Wenn keine Gewichtung genannt wird, lasse weighting leer.

Gib ausschließlich gültiges JSON in exakt dieser Struktur zurück:

{
  "criteria": [
    {
      "area": "string",
      "name": "string",
      "expectedElements": ["string"],
      "weighting": "string"
    }
  ]
}

AUSGABEREGELN:
- Kein Markdown.
- Kein Text außerhalb des JSON.
- Maximal 30 Kriterien.
- Lieber sinnvolle Zusammenfassung als 60 kleinteilige Kriterien.
`;
}

function normalizeCriteria(input: unknown): ExtractedCriterion[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      const raw = item as Partial<ExtractedCriterion>;

      return {
        area: String(raw.area ?? "").trim(),
        name: String(raw.name ?? "").trim(),
        expectedElements: Array.isArray(raw.expectedElements)
          ? raw.expectedElements.map((entry) => String(entry).trim()).filter(Boolean)
          : [],
        weighting: String(raw.weighting ?? "").trim(),
      };
    })
    .filter((criterion) => criterion.name || criterion.expectedElements.length > 0)
    .slice(0, 30);
}
