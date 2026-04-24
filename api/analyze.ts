// api/analyze.ts

type AnalyzeRequestBody = {
  sanitizedText?: string;
  expectationHorizonText?: string;
  assignmentText?: string;
  subject?: string;
  gradeLevel?: string;
  taskType?: string;
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
  const subject = String(req.body?.subject ?? "").trim();
  const gradeLevel = String(req.body?.gradeLevel ?? "").trim();
  const taskType = String(req.body?.taskType ?? "").trim();

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
    subject,
    gradeLevel,
    taskType,
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
              "Du bist ein professioneller Korrekturassistent für schulische Leistungsüberprüfungen und Klausuren. Du formulierst fach- und jahrgangsbezogen, strikt sachlich, knapp und korrekturpraktisch. Du gibst ausschließlich gültiges JSON zurück.",
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
      const text = await response.text();
      return res.status(500).json({
        ok: false,
        error: "OPENAI_ERROR",
        details: text,
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

function buildPrompt(input: {
  sanitizedText: string;
  expectationHorizonText: string;
  assignmentText: string;
  subject: string;
  gradeLevel: string;
  taskType: string;
}) {
  const {
    sanitizedText,
    expectationHorizonText,
    assignmentText,
    subject,
    gradeLevel,
    taskType,
  } = input;

  return `
Analysiere einen anonymisierten Schülertext auf Grundlage eines individuell bereitgestellten Erwartungshorizonts.

KONTEXT:
Fach: ${subject || "nicht angegeben"}
Klassenstufe/Jahrgang: ${gradeLevel || "nicht angegeben"}
Aufgabenart: ${taskType || "nicht angegeben"}

AUFGABENSTELLUNG:
${assignmentText || "Keine separate Aufgabenstellung übergeben."}

ERWARTUNGSHORIZONT:
${expectationHorizonText}

ANONYMISIERTER SCHÜLERTEXT:
${sanitizedText}

GRUNDPRINZIP:
Der Erwartungshorizont ist die verbindliche Bewertungsgrundlage.
Du extrahierst zuerst die Kriterien aus dem Erwartungshorizont und spiegelst den Schülertext anschließend daran.
Die Bewertung muss fach- und jahrgangsangemessen erfolgen.
Wenn Fach, Klassenstufe oder Aufgabenart fehlen, formuliere neutral und vermeide abiturbezogene Zuspitzungen.

WICHTIGE REGELN:
- Erfinde keine zusätzlichen Bewertungskriterien.
- Vergib keine Note.
- Vergib keine Punkte.
- Nenne keine personenbezogenen Daten.
- Verwende keine Ich-Form.
- Stelle keine Fragen an Schüler*innen.
- Verwende keinen Coaching-Ton.
- Formuliere wie Randbemerkungen und ein kurzes Gutachten zu einer schulischen Leistungsüberprüfung.
- Formuliere sachlich, knapp, fachsprachlich und korrekturpraktisch.
- Passe Anspruchsniveau und Wortwahl an Fach und Klassenstufe an.
- Benenne Stärken und Defizite präzise.
- Jede Randbemerkung muss sich auf den Schülertext oder den Erwartungshorizont beziehen.
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
Nutze bevorzugt knappe schulische Formulierungen dieser Art:
- "Der Aufgabenbezug ist im Wesentlichen erkennbar, bleibt jedoch stellenweise zu allgemein."
- "Der zentrale Aspekt wird aufgegriffen, aber nicht konsequent ausgeführt."
- "Die Darstellung bleibt an dieser Stelle ungenau."
- "Der Materialbezug ist vorhanden, wird aber nicht ausreichend präzise genutzt."
- "Die Argumentation ist grundsätzlich nachvollziehbar, bleibt jedoch wenig differenziert."
- "Die Gedankenführung ist erkennbar, verliert jedoch stellenweise an Stringenz."
- "Fachbegriffe werden verwendet, aber nicht immer sicher eingebunden."
- "Zentrale Erwartungselemente werden nur teilweise eingelöst."
- "Die Bearbeitung zeigt ein tragfähiges Grundverständnis, bleibt aber in der Ausführung lückenhaft."
- "Die Leistung erfüllt die Anforderungen in wesentlichen Teilen, weist jedoch deutliche Einschränkungen in der Präzision auf."

ZIEL DER RANDBEMERKUNGEN:

Die Randbemerkungen müssen wie echte Korrekturanmerkungen in einer Schülerarbeit formuliert sein.

Das bedeutet:
- kurze, präzise, operative Sätze
- direkte Bewertung einzelner Aspekte
- keine zusammenfassenden Meta-Beschreibungen
- keine allgemeinen Einschätzungen wie "grundsätzlich" oder "insgesamt"

VERMEIDE:
- "zeigt ein grundlegendes Verständnis"
- "ist nachvollziehbar"
- "insgesamt gelungen"
- "weitgehend erfüllt"
- "könnte verbessert werden"

BEVORZUGE STATTDESSEN:
- "wird nicht konsequent ausgeführt"
- "bleibt zu allgemein"
- "nicht ausreichend belegt"
- "nicht präzise genug"
- "nur ansatzweise vorhanden"
- "nicht differenziert"
- "Argument wird nicht weiterentwickelt"
- "Beispiel wird nicht erläutert"
- "Bezug zum Material bleibt oberflächlich"

FORMAT DER RANDBEMERKUNGEN:

Jeder Eintrag in marginComments muss ein einzelner, abgeschlossener Korrektursatz sein.

Keine Mehrfachsätze.
Keine Begründungsketten.
Keine Einleitungen.
Keine Abschwächungen.

Beispiel korrekt:
"Der Materialbezug wird nicht ausreichend präzise hergestellt."

Beispiel falsch:
"Der Materialbezug ist vorhanden, aber könnte noch verbessert werden, da er nicht immer klar ist."

Wenn eine Aufgabenart fachlich nicht zu einzelnen Kategorien passt, lasse die jeweilige Kategorie leer, statt etwas zu erfinden.

Gib ausschließlich gültiges JSON in exakt dieser Struktur zurück:

{
  "context": {
    "subject": "string",
    "gradeLevel": "string",
    "taskType": "string"
  },
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
    "aufgabenbezug": ["string"],
    "inhalt": ["string"],
    "fachlichkeit": ["string"],
    "materialbezug": ["string"],
    "argumentation": ["string"],
    "struktur": ["string"],
    "spracheVorsichtig": ["string"]
  },
  "finalComment": "string",
  "limitations": {
    "spellingAssessment": "not_reliable_due_to_ocr",
    "note": "string"
  }
}

AUSGABEREGELN:
- Alle Arrays dürfen leer sein, wenn die Kategorie nicht sinnvoll beurteilbar ist.
- Schreibe keine Markdown-Formatierung.
- Schreibe keine erklärenden Sätze außerhalb des JSON.
- Der finalComment soll 3 bis 5 sachliche Sätze umfassen.
- Der finalComment darf keine Note und keine Punktzahl enthalten.
`;
}
