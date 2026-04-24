// api/analyze.ts

type AnalyzeRequestBody = {
  sanitizedText?: string;
  expectationHorizonText?: string;
  assignmentText?: string;
  subject?: string;
  gradeLevel?: string;
  taskType?: string;
};

type MarginComments = {
  aufgabenbezug: string[];
  inhalt: string[];
  fachlichkeit: string[];
  materialbezug: string[];
  argumentation: string[];
  struktur: string[];
  spracheVorsichtig: string[];
};

type AnalysisResult = {
  context?: {
    subject?: string;
    gradeLevel?: string;
    taskType?: string;
  };
  extractedExpectation?: {
    taskType?: string;
    operators?: string[];
    criteria?: Array<{
      name?: string;
      expectedElements?: string[];
      weighting?: string;
    }>;
  };
  marginComments?: Partial<MarginComments>;
  finalComment?: string;
  limitations?: {
    spellingAssessment?: string;
    note?: string;
  };
};

const FORBIDDEN_MARGIN_PHRASES = [
  "aber",
  "jedoch",
  "insgesamt",
  "grundsätzlich",
  "zeigt",
  "wirkt",
  "könnte",
  "teilweise",
  "nachvollziehbar",
  "weitgehend",
  "argumentation wird analysiert",
  "bewertung erfolgt",
  "text wird dargestellt",
  "es wird beschrieben",
];

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
  const subject = String(body.subject ?? "").trim();
  const gradeLevel = String(body.gradeLevel ?? "").trim();
  const taskType = String(body.taskType ?? "").trim();

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
        temperature: 0,
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

    let parsed: AnalysisResult;

    try {
      parsed = JSON.parse(content) as AnalysisResult;
    } catch {
      return res.status(500).json({
        ok: false,
        error: "INVALID_JSON_FROM_MODEL",
        raw: content,
      });
    }

    const cleanedAnalysis = normalizeAnalysis(parsed, {
      subject,
      gradeLevel,
      taskType,
    });

    return res.status(200).json({
      ok: true,
      analysis: cleanedAnalysis,
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

PRIORITÄT:
Wenn eine Regel verletzt wird, ist die Antwort ungültig.
Lieber weniger Kommentare als falsche Kommentare.

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
Extrahiere zuerst die Kriterien aus dem Erwartungshorizont.
Spiegele den Schülertext anschließend ausschließlich an diesen Kriterien.
Die Bewertung muss fach- und jahrgangsangemessen erfolgen.
Wenn Fach, Klassenstufe oder Aufgabenart fehlen, formuliere neutral.

WICHTIGE REGELN:
- Erfinde keine zusätzlichen Bewertungskriterien.
- Vergib keine Note.
- Vergib keine Punkte.
- Nenne keine personenbezogenen Daten.
- Verwende keine Ich-Form.
- Stelle keine Fragen an Schüler*innen.
- Verwende keinen Coaching-Ton.
- Formuliere wie Randbemerkungen und ein kurzes Gutachten zu einer schulischen Leistungsüberprüfung.
- Passe Anspruchsniveau und Wortwahl an Fach und Klassenstufe an.
- Jede Randbemerkung muss sich auf den Schülertext oder auf den Erwartungshorizont beziehen.
- Keine erfundenen Textstellen.
- Keine freien pädagogischen Ratschläge ohne Bezug zur Leistung.

SPRACHLICHE EINSCHRÄNKUNG:
Der Schülertext kann aus OCR/Texterkennung stammen.
Rechtschreibung, Zeichensetzung und einzelne Grammatikfehler dürfen NICHT abschließend bewertet werden.

Verbotene Formulierungen zur Sprache:
- "häufige Rechtschreibfehler"
- "fehlerhafte Zeichensetzung"
- "sprachlich mangelhaft"
- "viele Grammatikfehler"

Erlaubte vorsichtige Formulierungen zur Sprache:
- "Formulierungsebene stellenweise unklar."
- "Sprachliche Auffälligkeiten am Originaltext prüfen."
- "Rechtschreibung auf OCR-Grundlage nicht zuverlässig bewertbar."
- "Zeichensetzung auf OCR-Grundlage nicht zuverlässig bewertbar."

FORMULIERUNGSSTIL FÜR RANDBEMERKUNGEN (STRIKT):
Jede Randbemerkung MUSS exakt diesem Muster folgen:

- direkt mit dem Befund beginnen
- maximal ein kurzer Hauptsatz
- keine Nebensätze
- keine Konjunktionen
- keine Einleitungen
- keine Aufgabenbeschreibung
- keine neutralen Aussagen ohne Bewertung
- maximal 8 bis 10 Wörter
- Punkt am Ende

STRIKT VERBOTEN IN RANDBEMERKUNGEN:
- "aber"
- "jedoch"
- "insgesamt"
- "grundsätzlich"
- "zeigt"
- "wirkt"
- "könnte"
- "teilweise"
- "nachvollziehbar"
- "weitgehend"
- "Argumentation wird analysiert"
- "Bewertung erfolgt"
- "Text wird dargestellt"
- "Es wird beschrieben"

Randbemerkungen dürfen KEINE Aufgabenbeschreibung enthalten.
Randbemerkungen müssen IMMER einen Mangel oder eine Qualität benennen.

Jede Bemerkung beantwortet implizit:
- Was fehlt?
- Was ist unklar?
- Was ist zu schwach?
- Was ist gelungen?

ERLAUBTE STRUKTUREN:
- "Argumentation bleibt oberflächlich."
- "Beispiel wird nicht erläutert."
- "Materialbezug fehlt."
- "Struktur nicht klar erkennbar."
- "These nicht präzise formuliert."
- "Argument wird nicht weiterentwickelt."
- "Gedankengang bricht ab."
- "Bezug zum Text bleibt unklar."
- "Bewertung nicht ausreichend begründet."
- "Zentrale These treffend erfasst."
- "Beleg funktional eingebunden."
- "Fachbegriff sicher verwendet."

NICHT ERLAUBT:
- reine Beschreibung ohne Bewertung
- neutrale Aussagen ohne Defizit oder Qualität
- zusammenfassende Meta-Beschreibungen
- Coaching-Formulierungen

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
- Der finalComment darf länger sein als Randbemerkungen.
`;
}

function normalizeAnalysis(
  parsed: AnalysisResult,
  fallbackContext: {
    subject: string;
    gradeLevel: string;
    taskType: string;
  }
): AnalysisResult {
  const marginComments = normalizeMarginComments(parsed.marginComments);

  return {
    context: {
      subject: parsed.context?.subject || fallbackContext.subject || "",
      gradeLevel: parsed.context?.gradeLevel || fallbackContext.gradeLevel || "",
      taskType: parsed.context?.taskType || fallbackContext.taskType || "",
    },
    extractedExpectation: {
      taskType: parsed.extractedExpectation?.taskType || fallbackContext.taskType || "",
      operators: Array.isArray(parsed.extractedExpectation?.operators)
        ? parsed.extractedExpectation?.operators ?? []
        : [],
      criteria: Array.isArray(parsed.extractedExpectation?.criteria)
        ? parsed.extractedExpectation?.criteria?.map((criterion) => ({
            name: String(criterion?.name ?? "").trim(),
            expectedElements: Array.isArray(criterion?.expectedElements)
              ? criterion.expectedElements.map((item) => String(item).trim()).filter(Boolean)
              : [],
            weighting: String(criterion?.weighting ?? "").trim(),
          })) ?? []
        : [],
    },
    marginComments,
    finalComment: String(parsed.finalComment ?? "").trim(),
    limitations: {
      spellingAssessment: "not_reliable_due_to_ocr",
      note:
        String(parsed.limitations?.note ?? "").trim() ||
        "Rechtschreibung und Zeichensetzung sind auf Grundlage möglicher OCR-Ungenauigkeiten nicht zuverlässig bewertbar.",
    },
  };
}

function normalizeMarginComments(
  input: AnalysisResult["marginComments"]
): MarginComments {
  const empty: MarginComments = {
    aufgabenbezug: [],
    inhalt: [],
    fachlichkeit: [],
    materialbezug: [],
    argumentation: [],
    struktur: [],
    spracheVorsichtig: [],
  };

  if (!input || typeof input !== "object") {
    return empty;
  }

  return {
    aufgabenbezug: cleanCommentArray(input.aufgabenbezug),
    inhalt: cleanCommentArray(input.inhalt),
    fachlichkeit: cleanCommentArray(input.fachlichkeit),
    materialbezug: cleanCommentArray(input.materialbezug),
    argumentation: cleanCommentArray(input.argumentation),
    struktur: cleanCommentArray(input.struktur),
    spracheVorsichtig: cleanCommentArray(input.spracheVorsichtig),
  };
}

function cleanCommentArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeSingleComment(String(item ?? "")))
    .filter(Boolean)
    .filter((item) => !containsForbiddenMarginPhrase(item))
    .slice(0, 4);
}

function normalizeSingleComment(value: string): string {
  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(/[!?]+$/g, "")
    .trim();

  if (!cleaned) {
    return "";
  }

  const firstSentence = cleaned.split(/[.;:]/)[0]?.trim() ?? "";

  if (!firstSentence) {
    return "";
  }

  const words = firstSentence.split(/\s+/).slice(0, 10);
  const shortened = words.join(" ").trim();

  if (!shortened) {
    return "";
  }

  return shortened.endsWith(".") ? shortened : `${shortened}.`;
}

function containsForbiddenMarginPhrase(value: string): boolean {
  const lower = value.toLowerCase();

  return FORBIDDEN_MARGIN_PHRASES.some((phrase) =>
    lower.includes(phrase.toLowerCase())
  );
}
