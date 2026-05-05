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
        error: "MISSING_API_KEY",
      });
    }

    const prompt = buildPrompt(text);

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
              "Du extrahierst präzise Bewertungsraster aus Erwartungshorizonten. Keine Vereinfachung. Kein Zusammenfassen.",
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

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "INVALID_JSON",
        raw: content,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      criteria: parsed.criteria ?? [],
    });
  } catch (e: any) {
    return sendJson(res, 500, {
      ok: false,
      error: e?.message ?? "UNKNOWN_ERROR",
    });
  }
}

/* ============================================================
   🔥 DER ENTSCHEIDENDE TEIL
   ============================================================ */

function buildPrompt(text: string) {
  return `
Extrahiere ein Bewertungsraster aus dem folgenden Erwartungshorizont.

WICHTIG:
Du darfst NICHT verallgemeinern.
Du darfst NICHT zusammenfassen.

❌ VERBOTEN:
- "Prüft, ob ..."
- "Es wird erwartet ..."
- "Analyse der Strophe"
- abstrakte Kriterien

✅ STATT DESSEN:
Jeder konkrete Inhalt wird eigenes Kriterium.

BEISPIEL:

Aus:
"Einleitung enthält: Textsorte Gedicht, Titel Der Pflaumenbaum, Autor Brecht"

Wird:
- Textsorte: Gedicht
- Titel: Der Pflaumenbaum
- Autor: Bertolt Brecht

STROPHEN:
Jeder einzelne Punkt wird eigenes Kriterium.

BEISPIEL:
- Strophe 1: Baum ist klein
- Strophe 1: Baum ist von Gitter umgeben
- Strophe 1: Gitter schützt vor Tritten

STRUKTUR:
- Interpretationshypothese ist eigenes Kriterium
- Fazit ist eigenes Kriterium
- Reihenfolge berücksichtigen

FORMAT:

{
  "criteria": [
    {
      "bereich": "string",
      "kriterium": "string",
      "beschreibung": "konkreter erwarteter Inhalt",
      "expectedElements": ["string"],
      "weighting": ""
    }
  ]
}

TEXT:
${text}
`;
}
