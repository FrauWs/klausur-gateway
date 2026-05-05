// api/extractCriteria.ts

import { z } from "zod";

declare const process: {
  env: {
    OPENAI_API_KEY?: string;
  };
};

const CriteriaSchema = z.object({
  criteria: z.array(
    z.object({
      bereich: z.string(),
      kriterium: z.string(),
      beschreibung: z.string(),
    })
  ),
});

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
    const text = String(req.body?.expectationHorizonText ?? "").trim();

    if (!text) {
      return sendJson(res, 400, {
        ok: false,
        error: "EMPTY_INPUT",
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return sendJson(res, 500, {
        ok: false,
        error: "NO_API_KEY",
      });
    }

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
            content:
              "Du extrahierst Bewertungsraster vollständig. Kein Zusammenfassen. Nur JSON.",
          },
          {
            role: "user",
            content: buildPrompt(text),
          },
        ],
      }),
    });

    const raw = await response.text();

    console.log("RAW:", raw);

    if (!response.ok) {
      return sendJson(res, 500, {
        ok: false,
        error: "OPENAI_ERROR",
        raw,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "INVALID_OPENAI_RESPONSE",
        raw,
      });
    }

    const content = parsed?.choices?.[0]?.message?.content;

    if (!content) {
      return sendJson(res, 500, {
        ok: false,
        error: "EMPTY_MODEL_RESPONSE",
        parsed,
      });
    }

    let json;
    try {
      json = JSON.parse(content);
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "MODEL_NOT_JSON",
        content,
      });
    }

    const result = CriteriaSchema.safeParse(json);

    if (!result.success) {
      return sendJson(res, 500, {
        ok: false,
        error: "INVALID_SCHEMA",
        issues: result.error.issues,
        json,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      criteria: result.data.criteria,
      debug: {
        count: result.data.criteria.length,
      },
    });
  } catch (e: any) {
    return sendJson(res, 500, {
      ok: false,
      error: "SERVER_ERROR",
      message: e?.message,
    });
  }
}

function buildPrompt(text: string) {
  return `
Extrahiere ein vollständiges Bewertungsraster.

WICHTIG:
- Jede Zeile = eigenes Kriterium
- KEINE Zusammenfassung
- KEIN Zusammenfassen mehrerer Punkte
- Struktur erhalten

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
