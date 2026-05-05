// api/extractCriteria.ts

declare const process: {
  env: {
    OPENAI_API_KEY?: string;
  };
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

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const body = req.body ?? {};

    const text = String(body.expectationHorizonText ?? "").trim();
    const imageBase64 = body.imageBase64;

    if (!text && !imageBase64) {
      return sendJson(res, 400, {
        ok: false,
        error: "EMPTY_INPUT",
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(res, 500, {
        ok: false,
        error: "MISSING_API_KEY",
      });
    }

    const isOCR = !!imageBase64;

    const prompt = isOCR
      ? buildOCRPrompt()
      : buildTextPrompt(text);

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

    if (!response.ok) {
      const err = await response.text();
      return sendJson(res, 500, { ok: false, error: err });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";

    return sendJson(res, 200, {
      ok: true,
      criteria: JSON.parse(content).criteria ?? [],
    });
  } catch (e: any) {
    return sendJson(res, 500, {
      ok: false,
      error: e?.message ?? "UNKNOWN_ERROR",
    });
  }
}

/* ================================
   PROMPTS
================================ */

function buildTextPrompt(text: string) {
  return `
Extrahiere ein vollständiges Bewertungsraster aus diesem Erwartungshorizont.

WICHTIG:
- Jeder Spiegelstrich = eigenes Kriterium
- KEIN Zusammenfassen
- KEIN Generalisieren
- Wortlaut möglichst nah am Original

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
`;
}

function buildOCRPrompt() {
  return `
Das Bild enthält einen Erwartungshorizont.

Extrahiere daraus ein Bewertungsraster.

REGELN:
- Jeder einzelne Punkt wird ein Kriterium
- KEINE Zusammenfassung
- Original möglichst beibehalten

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
`;
}
