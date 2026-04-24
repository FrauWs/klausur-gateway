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
              "Du bist ein präziser Korrekturassistent für schulische Klausuren. Du formulierst professionell, sachlich und korrekturpraktisch. Du gibst ausschließlich gültiges JSON zurück.",
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

GRUNDPRINZIP:
Der Erwartungshorizont ist die verbindliche Bewertungsgrundlage.
Du extrahierst zuerst die Kriterien aus dem Erwartungshorizont und spiegelst den Schülertext anschließend daran.

WICHTIGE REGELN:
- Erfinde keine zusätzlichen Bewertungskriterien.
- Vergib keine Note.
- Vergib keine Punkte.
- Nenne keine personenbezogenen Daten.
- Verwende keine Ich-Form.
- Stelle keine Fragen an die Schüler*innen.
- Verwende keinen Coaching-Ton.
- Formuliere wie Randbemerkungen und ein kurzes Gutachten zu einer Klausur.
- Formuliere sachlich, knapp, fachsprachlich und korrekturpraktisch.
- Benenne Stärken und Defizite präzise.
- Jede Randbemerkung muss sich auf den Schülertext oder auf den Erwartungshorizont beziehen.
- Keine erfundenen Textstellen.
- Keine freien pädagogischen Ratschläge ohne Bezug zur Leistung.

SPRACHLICHE EINSCHRÄNKUNG:
Der Schülertext kann aus OCR/Texterkennung stammen.
Rechtschreibung, Zeichensetzung und einzelne Grammatikfehler dürfen daher NICHT abschließend bewertet werden.

Verbotene Formulierungen:
- "häufige Rechtschreibfehler"
- "fehlerhafte Zeichensetzung"
- "sprachlich mangelhaft"
- "viele Grammatikfehler"

Erlaubte vorsichtige Formulierungen:
- "Auf Satz- und Formulierungsebene zeigen sich stellenweise Unklarheiten."
- "Einzelne sprachliche Auffälligkeiten sollten am Originaltext überprüft werden."
- "Eine abschließende Bewertung von Rechtschreibung und Zeichensetzung ist auf Grundlage der Texterkennung nicht zuverlässig möglich."
- "Die sprachliche Bewertung kann nur eingeschränkt erfolgen, da mögliche OCR-Ungenauigkeiten zu berücksichtigen sind."

FORMULIERUNGSSTIL FÜR RANDBEMERKUNGEN:
Nutze bevorzugt Formulierungen dieser Art:
- "Der Aufgabenbezug ist im Wesentlichen erkennbar, bleibt jedoch stellenweise zu allgemein."
- "Der zentrale Aspekt wird aufgegriffen, aber nicht konsequent ausgeführt."
- "Die Darstellung bleibt an dieser Stelle ungenau."
- "Der Materialbezug ist vorhanden, wird aber nicht ausreichend präzise genutzt."
-
