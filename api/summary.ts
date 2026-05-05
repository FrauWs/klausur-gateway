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

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const body = req.body ?? {};

    const results = body.criteriaResults ?? [];
    const text = String(body.sanitizedText ?? "").trim();

    if (!Array.isArray(results) || results.length === 0) {
      return sendJson(res, 400, { ok: false, error: "MISSING_ANALYSIS" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return sendJson(res, 500, { ok: false, error: "MISSING_API_KEY" });
    }

    const prompt = buildPrompt(results, text);

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
            content:
              "Du formulierst präzise, sachliche Gutachten auf Deutsch. Keine Noten, keine Punkte.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      return sendJson(res, 500, { ok: false, error: raw });
    }

    const data = JSON.parse(raw);
    const content = data?.choices?.[0]?.message?.content ?? "";

    return sendJson(res, 200, {
      ok: true,
      summary: {
        kurzkommentar: content,
      },
    });
  } catch (e: any) {
    return sendJson(res, 500, {
      ok: false,
      error: e?.message ?? "UNKNOWN_ERROR",
    });
  }
}

function buildPrompt(results: any[], text: string) {
  return `
Formuliere ein präzises Gutachten auf Basis der Analyse.

ANALYSEERGEBNISSE:
${JSON.stringify(results, null, 2)}

SCHÜLERTEXT:
${text}

REGELN:
- Nur Beschreibung, keine Bewertung
- Keine Noten, keine Punkte
- Fachlich präzise
- Maximal 6–8 Sätze
- Bezug zu konkreten Kriterien

ZIEL:
Ein zusammenhängender Kurzkommentar.

OUTPUT:
Nur Text.
`;
}
