// api/extractCriteria.ts

declare const process: {
  env: {
    OPENAI_API_KEY?: string;
  };
};

type ExtractCriteriaRequestBody = {
  expectationHorizonText?: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function applyCors(res: any) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
}

function sendJson(res: any, status: number, payload: unknown) {
  applyCors(res);
  res.setHeader("Content-Type", "application/json");
  return res.status(status).json(payload);
}

export default async function handler(req: any, res: any) {
  applyCors(res);

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const body = (req.body ?? {}) as ExtractCriteriaRequestBody;

    const text = String(body.expectationHorizonText ?? "").trim();

    if (!text) {
      return sendJson(res, 400, {
        ok: false,
        error: "MISSING_EXPECTATION_HORIZON",
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(res, 500, {
        ok: false,
        error: "MISSING_API_KEY",
      });
    }

    const prompt = buildPrompt(text);

    console.log("=== EXTRACT CRITERIA INPUT ===");
    console.log(text);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Extrahiere ein vollständiges Bewertungsraster. Nur JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    const rawText = await response.text();

    console.log("=== OPENAI RAW RESPONSE ===");
    console.log(rawText);

    if (!response.ok) {
      return sendJson(res, 500, {
        ok: false,
        error: "OPENAI_ERROR",
        raw: rawText,
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(rawText);
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "INVALID_JSON",
        raw: rawText,
      });
    }

    const content = parsed?.choices?.[0]?.message?.content ?? "";

    console.log("=== MODEL CONTENT ===");
    console.log(content);

    let final;

    try {
      final = JSON.parse(content);
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "INVALID_MODEL_JSON",
        content,
      });
    }

    const criteria = Array.isArray(final.criteria) ? final.criteria : [];

    console.log("=== FINAL CRITERIA ===");
    console.log(criteria);

    return sendJson(res, 200, {
      ok: true,
      criteria,
      debug: {
        inputLength: text.length,
        criteriaCount: criteria.length,
      },
    });
  } catch (e: any) {
    return sendJson(res, 500, {
      ok: false,
      error: "SERVER_ERROR",
      message: e?.message ?? "UNKNOWN",
    });
  }
}

function buildPrompt(text: string) {
  return `
Extrahiere ALLE Bewertungskriterien aus dem folgenden Erwartungshorizont.

WICHTIG:
- Jeder Punkt = eigenes Kriterium
- Keine Zusammenfassung
- Keine Bündelung
- Original möglichst erhalten

TEXT:
${text}

FORMAT:

{
  "criteria": [
    {
      "bereich": "string",
      "kriterium": "string",
      "beschreibung": "string"
    }
  ]
}

Nur JSON.
`;
}
