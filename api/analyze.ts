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

  const body = (req.body ?? {}) as AnalyzeRequestBody;

  const sanitizedText = String(body.sanitizedText ?? "").trim();
  const expectationHorizonText = String(body.expectationHorizonText ?? "").trim();
  const assignmentText = String(body.assignmentText ?? "").trim();

  if (!sanitizedText) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_SANITIZED_TEXT",
      message: "sanitizedText fehlt.",
    });
  }

  if (!expectationHorizonText) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_EXPECTATION_HORIZON",
      message: "expectationHorizonText fehlt.",
    });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "MISSING_API_KEY",
      message: "OPENAI_API_KEY ist nicht gesetzt.",
    });
  }

  const prompt = buildAnalysisPrompt({
    sanitizedText,
    expectationHorizonText,
    assignmentText,
  });

  try {
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
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Du bist ein präziser Korrekturassistent für schulische Klausuren. Du gibst ausschließlich gültiges JSON zurück.",
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
      const errorText = await response.text();

      return res.status(500).json({
        ok: false,
        error: "OPENAI_ERROR",
        details: errorText,
      });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? "";

    let parsed: unknown;

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
      error: err?.name === "AbortError" ? "TIMEOUT" : "UNKNOWN_ERROR",
      message: err?.message ?? "Unbekannter Fehler.",
    });
  }
}

function buildAnalysisPrompt(input: {
  sanitizedText: string;
  expectationHorizonText: string;
  assignmentText: string;
}) {
  const { sanitizedText, expectationHorizonText, assignmentText } = input;

  return `
Analysiere einen anonymisierten Schülertext auf Grundlage eines individuell bereitgestellten Erwartungshorizonts.

WICHTIG:
- Der Erwartungshorizont ist die maßgebliche Bewertungsgrundlage.
- Extrahiere die Kriterien aus dem Erwartungshorizont.
- Erfinde keine zusätzlichen Bewertungskriterien.
- Formuliere Randbemerkungen und ein kurzes Gutachten.
- Die Formulierungen sollen sachlich, schulisch und korrekturpraktisch verwendbar sein.
- Es geht NICHT um eine freie allgemeine Bewertung.
- Es geht NICHT um eine abschließende Rechtschreibdiagnose.

EINSCHRÄNKUNG ZUR SPRACHE:
Der Schülertext kann aus OCR/Texterkennung stammen.
Bewerte Rechtschreibung, Zeichensetzung und einzelne Grammatikfehler daher NICHT abschließend.
Du darfst nur vorsichtige Hinweise auf sprachliche Muster geben, wenn sie trotz möglicher OCR-Ungenauigkeiten erkennbar sind.
Keine Formulierungen wie:
- "häufige Rechtschreibfehler"
- "fehlerhafte Zeichensetzung"
- "sprachlich mangelhaft"
Stattdessen vorsichtig formulieren:
- "Auf Satz- und Formulierungsebene zeigen sich stellenweise Unklarheiten."
- "Einzelne sprachliche Auffälligkeiten sollten am Originaltext überprüft werden."
- "Eine abschließende Bewertung von Rechtschreibung und Zeichensetzung ist auf Grundlage der Texterkennung nicht zuverlässig möglich."

AUFGABENSTELLUNG:
${assignmentText || "Keine separate Aufgabenstellung übergeben."}

ERWARTUNGSHORIZONT:
${expectationHorizonText}

ANONYMISIERTER SCHÜLERTEXT:
${sanitizedText}

Gib ausschließlich gültiges JSON in exakt dieser Struktur zurück:

{
  "extractedExpectation": {
    "taskType": "string",
    "operators": ["string"],
    "criteria": [
      {
        "name": "string",
        "expectedElements": ["string"],
        "weighting": "string oder leer"
      }
    ]
  },
  "marginComments": {
    "content": ["string"],
    "structure": ["string"],
    "materialUse": ["string"],
    "argumentation": ["string"],
    "languageCautious": ["string"]
  },
  "finalComment": "string",
  "limitations": {
    "spellingAssessment": "not_reliable_due_to_ocr",
    "note": "string"
  }
}

REGELN FÜR DIE AUSGABE:
- Jede Randbemerkung muss konkret auf den Schülertext oder den Erwartungshorizont bezogen sein.
- Keine Noten vergeben.
- Keine Punkte vergeben.
- Keine personenbezogenen Daten nennen.
- Keine Rechtschreibkorrektur einzelner Wörter.
- Keine erfundenen Textstellen.
- Wenn der Erwartungshorizont unklar ist, benenne dies im finalComment.
`;
}
