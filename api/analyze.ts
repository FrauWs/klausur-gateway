// api/analyze.ts

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

    const sanitizedText = String(body.sanitizedText ?? "").trim();
    const expectationHorizonText = String(body.expectationHorizonText ?? "").trim();

    if (!sanitizedText) {
      return sendJson(res, 400, {
        ok: false,
        error: "MISSING_SANITIZED_TEXT",
      });
    }

    if (!expectationHorizonText) {
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

    const prompt = `
Analysiere den Schülertext anhand des Erwartungshorizonts.

TEXT:
${sanitizedText}

ERWARTUNG:
${expectationHorizonText}

Gib NUR JSON zurück:
{
  "summary": "string",
  "strengths": ["string"],
  "weaknesses": ["string"]
}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
            content: "Du bist ein Korrekturassistent. Nur JSON.",
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
      return sendJson(res, 500, {
        ok: false,
        error: "OPENAI_ERROR",
        details: err,
      });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? "";

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch {
      return sendJson(res, 200, {
        ok: true,
        fallback: true,
        raw: content,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      analysis: parsed,
    });
  } catch (e: any) {
    return sendJson(res, 500, {
      ok: false,
      error: e?.message ?? "UNKNOWN_ERROR",
    });
  }
}
