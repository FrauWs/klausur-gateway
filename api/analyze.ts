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
  evidence: string;
  textEvidence: string;
  confidence: "hoch" | "mittel" | "niedrig";
};

type AnalysisResult = {
  criteriaResults?: CriteriaResult[];
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function applyCors(res: any) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
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
      method: req.method,
    });
  }

  try {
    const body = (req.body ?? {}) as AnalyzeRequestBody;

    const sanitizedText = String(body.sanitizedText ?? "").trim();
    const expectationHorizonText = String(body.expectationHorizonText ?? "").trim();
    const assignmentText = String(body.assignmentText ?? "").trim();
    const subject = String(body.subject ?? "").trim();
    const gradeLevel = String(body.gradeLevel ?? "").trim();
    const taskType = String(body.taskType ?? "").trim();

    if (!sanitizedText) {
      return sendJson(res, 400, {
        ok: false,
        error: "MISSING_SANITIZED_TEXT",
        message: "sanitizedText fehlt.",
      });
    }

    if (!expectationHorizonText) {
      return sendJson(res, 400, {
        ok: false,
        error: "MISSING_EXPECTATION_HORIZON",
        message: "expectationHorizonText fehlt.",
      });
    }

    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!openaiApiKey) {
      return sendJson(res, 500, {
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Du bist ein sachlicher Korrekturassistent für schulische Leistungsüberprüfungen. Alle Kommentare und Einschätzungen werden auf Deutsch formuliert. Textbelege bleiben unverändert in der Originalsprache des Schülertexts. Du gibst ausschließlich gültiges JSON zurück.",
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

      return sendJson(res, 500, {
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
      return sendJson(res, 500, {
        ok: false,
        error: "INVALID_JSON_FROM_MODEL",
        raw: content,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      analysis: {
        criteriaResults: normalizeCriteriaResults(parsed.criteriaResults),
      },
      usage: data?.usage ?? null,
    });
  } catch (err: any) {
    return sendJson(res, 500, {
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
  const subjectLower = input.subject.toLowerCase();

  const isForeignLanguage =
    subjectLower.includes("englisch") ||
    subjectLower.includes("französisch") ||
    subjectLower.includes("spanisch") ||
    subjectLower.includes("russisch") ||
    subjectLower.includes("latein") ||
    subjectLower.includes("fremdsprache");

  return `
Analysiere den Schülertext strikt anhand eines Bewertungsrasters.

KONTEXT:
Fach: ${input.subject || "nicht angegeben"}
Jahrgang/Klasse: ${input.gradeLevel || "nicht angegeben"}
Aufgabenart: ${input.taskType || "nicht angegeben"}

AUFGABENSTELLUNG:
${input.assignmentText || "Keine separate Aufgabenstellung übergeben."}

ERWARTUNGSHORIZONT:
${input.expectationHorizonText}

SCHÜLERTEXT:
${input.sanitizedText}

SPRACHE DER AUSGABE:
- Alle Kommentare, Einschätzungen und Befunde werden auf Deutsch formuliert.
- Textbelege werden unverändert in der Originalsprache des Schülertexts übernommen.
- Textbelege dürfen nicht übersetzt werden.
- Russische, englische, französische oder andere fremdsprachige Textstellen bleiben exakt in der Originalsprache.
- Keine Übersetzung des gesamten Schülertexts.

${
  isForeignLanguage
    ? `
ZUSATZREGELN FÜR FREMDSPRACHEN:
- Kommentare bleiben auf Deutsch.
- Textbelege bleiben in der Originalsprache.
- Bewerte Aufgabenbezug, Inhalt, Kohärenz, Ausdruck und sprachliche Angemessenheit nur anhand des Rasters.
- Bei sprachlicher Bewertung vorsichtig formulieren, wenn OCR/Texterkennung beteiligt sein könnte.
- Keine vollständige Fehlerkorrektur.
- Keine Übersetzung der Schülerlösung.
- Keine Korrektur einzelner fremdsprachiger Fehler, wenn diese nicht durch das Raster verlangt wird.
`
    : ""
}

AUFGABE:
1. Extrahiere Bewertungskriterien aus dem Erwartungshorizont.
2. Vergleiche den Schülertext mit jedem Kriterium.
3. Bewerte jedes Kriterium einzeln.
4. Belege jede Bewertung mit einer konkreten Fundstelle aus dem Schülertext.

REGELN:
- Erfinde keine neuen Kriterien.
- Vergib keine Note.
- Vergib keine Punkte.
- Keine personenbezogenen Daten.
- Jede Bewertung muss an ein konkretes Kriterium gebunden sein.
- Jede Bewertung muss ein evidence-Feld enthalten.
- evidence enthält eine kurze wörtliche Textstelle oder eine knappe sinngemäße Fundstelle aus dem Schülertext.
- textEvidence enthält denselben Wert wie evidence.
- Wenn wirklich keine passende Fundstelle erkennbar ist, sind evidence und textEvidence leere Strings.
- Keine erfundenen Textbelege.
- Wenn ein Kriterium nicht sicher prüfbar ist, schreibe "teilweise" oder "nicht erfüllt" nur bei klarer Grundlage.
- Keine allgemeinen Floskeln.
- Kein Coaching-Ton.
- Keine Fragen an Schüler*innen.
- Maximal 15 Kriterien.

Gib ausschließlich gültiges JSON in exakt dieser Struktur zurück:

{
  "criteriaResults": [
    {
      "criterion": "string",
      "status": "erfüllt | teilweise | nicht erfüllt",
      "comment": "deutscher Kommentar",
      "evidence": "Textbeleg in Originalsprache",
      "textEvidence": "Textbeleg in Originalsprache",
      "confidence": "hoch | mittel | niedrig"
    }
  ]
}

AUSGABEREGELN:
- Kein Markdown.
- Kein Text außerhalb des JSON.
- comment ist immer auf Deutsch.
- comment ist maximal ein kurzer Satz.
- evidence ist maximal eine kurze Textstelle oder eine kurze sinngemäße Fundstelle.
- evidence darf nur leer sein, wenn im Schülertext keine passende Fundstelle vorhanden ist.
- textEvidence muss denselben Inhalt wie evidence haben.
`;
}

function normalizeCriteriaResults(input: unknown): CriteriaResult[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      const raw = item as Partial<CriteriaResult>;
      const evidence = String(
        raw.evidence ??
          raw.textEvidence ??
          ""
      ).trim();

      return {
        criterion: String(raw.criterion ?? "").trim(),
        status: normalizeStatus(raw.status),
        comment: String(raw.comment ?? "").trim(),
        evidence,
        textEvidence: evidence,
        confidence: normalizeConfidence(raw.confidence),
      };
    })
    .filter((item) => item.criterion || item.comment || item.evidence)
    .slice(0, 15);
}

function normalizeStatus(value: unknown): CriteriaResult["status"] {
  const normalized = String(value ?? "").trim();

  if (
    normalized === "erfüllt" ||
    normalized === "teilweise" ||
    normalized === "nicht erfüllt"
  ) {
    return normalized;
  }

  return "teilweise";
}

function normalizeConfidence(value: unknown): CriteriaResult["confidence"] {
  const normalized = String(value ?? "").trim();

  if (normalized === "hoch" || normalized === "mittel" || normalized === "niedrig") {
    return normalized;
  }

  return "niedrig";
}
