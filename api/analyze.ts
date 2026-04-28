// api/analyze.ts

declare const process: {
  env: {
    OPENAI_API_KEY?: string;
  };
};

type AnalyzeRequestBody = {
  sanitizedText?: string;
  expectationHorizonText?: string;
  assignmentText?: string;
  subject?: string;
  gradeLevel?: string;
  taskType?: string;
};

type CriteriaResult = {
  criterion: string;
  status: "erfüllt" | "teilweise" | "nicht erfüllt";
  comment: string;
  confidence: "hoch" | "mittel" | "niedrig";
  textEvidence: string; // 🔴 WICHTIG
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
  if (req.method !== "POST") return sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });

  try {
    const body = req.body as AnalyzeRequestBody;

    const sanitizedText = String(body.sanitizedText || "").trim();
    const expectationHorizonText = String(body.expectationHorizonText || "").trim();

    if (!sanitizedText) {
      return sendJson(res, 400, { error: "NO_TEXT" });
    }

    if (!expectationHorizonText) {
      return sendJson(res, 400, { error: "NO_RUBRIC" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return sendJson(res, 500, { error: "NO_API_KEY" });
    }

    const prompt = `
Analysiere den Schülertext strikt anhand des Erwartungshorizonts.

WICHTIG:
- Jede Bewertung MUSS durch eine konkrete Textstelle belegt werden
- Zitiere wörtlich aus dem Schülertext
- Wenn kein Beleg vorhanden → "" (leer)

ERWARTUNGSHORIZONT:
${expectationHorizonText}

SCHÜLERTEXT:
${sanitizedText}

AUSGABE:

{
  "criteriaResults": [
    {
      "criterion": "string",
      "status": "erfüllt | teilweise | nicht erfüllt",
      "comment": "string",
      "confidence": "hoch | mittel | niedrig",
      "textEvidence": "exakte Textstelle aus Schülertext"
    }
  ]
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
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Du gibst nur JSON zurück." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const txt = await response.text();
      return sendJson(res, 500, { error: "OPENAI_ERROR", details: txt });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return sendJson(res, 500, { error: "INVALID_JSON", raw: content });
    }

    return sendJson(res, 200, {
      analysis: parsed.criteriaResults || [],
    });
  } catch (e: any) {
    return sendJson(res, 500, { error: e.message });
  }
}
