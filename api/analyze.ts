// api/analyze.ts

type AnalyzeRequestBody = {
  sanitizedText?: string;
  expectationHorizonText?: string;
  assignmentText?: string;
};

export default async function handler(req: any, res: any) {
  if (req.method === "OPTIONS") {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      method: req.method,
    });
  }

  const sanitizedText = String(req.body?.sanitizedText ?? "").trim();
  const expectationHorizonText = String(req.body?.expectationHorizonText ?? "").trim();
  const assignmentText = String(req.body?.assignmentText ?? "").trim();

  if (!sanitizedText) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_SANITIZED_TEXT",
    });
  }

  if (!expectationHorizonText) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_EXPECTATION_HORIZON",
    });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "MISSING_API_KEY",
    });
  }

  const prompt = buildPrompt({
    sanitizedText,
    expectationHorizonText,
    assignmentText,
  });

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Du bist ein professioneller Korrekturassistent für Abiturklausuren. Du formulierst strikt fachlich, knapp und korrekturpraktisch. Du gibst ausschließlich gültiges JSON zurück.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({
        ok: false,
        error: "OPENAI_ERROR",
        details: text,
      });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? "";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "INVALID_JSON_FROM_MODEL",
        raw: content,
      });
    }

    return res.status(200).json({
      ok: true,
      analysis: parsed,
    });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      error: "UNKNOWN_ERROR",
      message: err?.message,
    });
  }
}

function buildPrompt(input: {
  sanitizedText: string;
  expectationHorizonText: string;
  assignmentText: string;
}) {
  return `
Analysiere einen Schülertext anhand eines Erwartungshorizonts.

AUFGABENSTELLUNG:
${input.assignmentText || "Nicht angegeben"}

ERWARTUNGSHORIZONT:
${input.expectationHorizonText}

SCHÜLERTEXT:
${input.sanitizedText}

AUFGABE:

1. Extrahiere die zentralen Bewertungskriterien aus dem Erwartungshorizont.
2. Analysiere den Schülertext ausschließlich anhand dieser Kriterien.
3. Formuliere präzise Randbemerkungen.

WICHTIG:
- Keine Note
- Keine Punkte
- Keine Ich-Form
- Keine Fragen
- Kein Coaching-Ton
- Nur fachliche Korrektursprache

SPRACHEINSCHRÄNKUNG:
Der Text kann OCR-Fehler enthalten.
Rechtschreibung darf nur vorsichtig bewertet werden.

AUSGABEFORMAT (JSON):

{
  "extractedExpectation": {
    "taskType": "",
    "operators": [],
    "criteria": [
      {
        "name": "",
        "expectedElements": []
      }
    ]
  },
  "marginComments": {
    "aufgabenbezug": [],
    "inhalt": [],
    "materialbezug": [],
    "argumentation": [],
    "struktur": [],
    "sprache": []
  },
  "finalComment": "",
  "limitations": {
    "spellingAssessment": "not_reliable_due_to_ocr",
    "note": ""
  }
}
`;
}
