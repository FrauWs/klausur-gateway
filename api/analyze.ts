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

type CriterionResult = {
  area: string;
  criterion: string;
  expectedElements: string[];
  status: "erfuellt" | "teilweise" | "nicht_erfuellt" | "nicht_beurteilbar";
  evidence: string;
  comment: string;
  confidence: "hoch" | "mittel" | "niedrig";
};

type AnalysisResult = {
  context?: {
    subject?: string;
    gradeLevel?: string;
    taskType?: string;
  };
  criteriaResults?: CriterionResult[];
  marginComments?: {
    staerken?: string[];
    entwicklungsbedarf?: string[];
    textbezug?: string[];
    struktur?: string[];
    spracheVorsichtig?: string[];
  };
  finalComment?: string;
  limitations?: {
    spellingAssessment?: string;
    note?: string;
  };
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

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!OPENAI_API_KEY) {
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
              "Du bist ein sachlicher Korrekturassistent für schulische Leistungsüberprüfungen. Du prüfst ausschließlich anhand des übergebenen Bewertungsrasters. Du gibst ausschließlich gültiges JSON zurück.",
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

    const cleanedAnalysis = normalizeAnalysis(parsed, {
      subject,
      gradeLevel,
      taskType,
    });

    return sendJson(res, 200, {
      ok: true,
      analysis: cleanedAnalysis,
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
  const {
    sanitizedText,
    expectationHorizonText,
    assignmentText,
    subject,
    gradeLevel,
    taskType,
  } = input;

  return `
Analysiere einen anonymisierten Schülertext streng anhand eines Bewertungsrasters.

KONTEXT:
Fach: ${subject || "nicht angegeben"}
Jahrgang/Klasse: ${gradeLevel || "nicht angegeben"}
Aufgabenart: ${taskType || "nicht angegeben"}

AUFGABENSTELLUNG:
${assignmentText || "Keine separate Aufgabenstellung übergeben."}

BEWERTUNGSRASTER / ERWARTUNGSHORIZONT:
${expectationHorizonText}

ANONYMISIERTER SCHÜLERTEXT:
${sanitizedText}

AUFGABE:
Führe einen echten Rasterabgleich durch.

WICHTIG:
- Prüfe jedes erkennbare Kriterium aus dem Bewertungsraster einzeln.
- Erfinde keine neuen Kriterien.
- Wenn ein Kriterium im Schülertext nicht sicher prüfbar ist, markiere es als "nicht_beurteilbar".
- Nenne keine Note.
- Nenne keine Punkte.
- Verwende keine personenbezogenen Daten.
- Bewerte Rechtschreibung, Zeichensetzung und Grammatik nur vorsichtig, da der Text durch OCR/Texterkennung verfälscht sein kann.
- Jede Rückmeldung muss auf Raster oder Schülertext bezogen sein.
- Keine allgemeinen Floskeln.
- Kein Coaching-Ton.
- Keine Fragen an Schüler*innen.

STATUS-LOGIK:
- "erfuellt": Das Kriterium ist im Schülertext klar erfüllt.
- "teilweise": Das Kriterium ist teilweise erkennbar, aber nicht vollständig umgesetzt.
- "nicht_erfuellt": Das Kriterium fehlt oder ist fachlich nicht eingelöst.
- "nicht_beurteilbar": Der Schülertext oder das Raster erlaubt keine sichere Aussage.

EVIDENCE-LOGIK:
- Wenn möglich, gib eine kurze Textstelle oder sinngemäße Fundstelle an.
- Wenn keine Textstelle vorhanden ist, schreibe: "".
- Erfinde keine Belege.

COMMENT-LOGIK:
- Formuliere kurz, sachlich und korrekturpraktisch.
- Kein Lob ohne Bezug.
- Kein Defizit ohne Bezug.
- Maximal 1 Satz pro Kriterium.

Gib ausschließlich gültiges JSON in exakt dieser Struktur zurück:

{
  "context": {
    "subject": "string",
    "gradeLevel": "string",
    "taskType": "string"
  },
  "criteriaResults": [
    {
      "area": "string",
      "criterion": "string",
      "expectedElements": ["string"],
      "status": "erfuellt | teilweise | nicht_erfuellt | nicht_beurteilbar",
      "evidence": "string",
      "comment": "string",
      "confidence": "hoch | mittel | niedrig"
    }
  ],
  "marginComments": {
    "staerken": ["string"],
    "entwicklungsbedarf": ["string"],
    "textbezug": ["string"],
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
- criteriaResults muss mindestens 5 Kriterien enthalten, wenn das Raster genug Material enthält.
- Wenn das Raster weniger Kriterien enthält, prüfe nur diese.
- finalComment umfasst 3 bis 5 sachliche Sätze.
- finalComment fasst den Rasterabgleich zusammen.
- Keine Markdown-Formatierung.
- Kein Text außerhalb des JSON.
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
  return {
    context: {
      subject: String(parsed.context?.subject || fallbackContext.subject || "").trim(),
      gradeLevel: String(parsed.context?.gradeLevel || fallbackContext.gradeLevel || "").trim(),
      taskType: String(parsed.context?.taskType || fallbackContext.taskType || "").trim(),
    },
    criteriaResults: normalizeCriteriaResults(parsed.criteriaResults),
    marginComments: normalizeMarginComments(parsed.marginComments),
    finalComment: String(parsed.finalComment ?? "").trim(),
    limitations: {
      spellingAssessment: "not_reliable_due_to_ocr",
      note:
        String(parsed.limitations?.note ?? "").trim() ||
        "Rechtschreibung, Zeichensetzung und einzelne sprachliche Auffälligkeiten sind auf OCR-Grundlage nicht zuverlässig abschließend bewertbar.",
    },
  };
}

function normalizeCriteriaResults(input: unknown): CriterionResult[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      const raw = item as Partial<CriterionResult>;

      return {
        area: String(raw.area ?? "").trim(),
        criterion: String(raw.criterion ?? "").trim(),
        expectedElements: Array.isArray(raw.expectedElements)
          ? raw.expectedElements.map((entry) => String(entry).trim()).filter(Boolean)
          : [],
        status: normalizeStatus(raw.status),
        evidence: String(raw.evidence ?? "").trim(),
        comment: String(raw.comment ?? "").trim(),
        confidence: normalizeConfidence(raw.confidence),
      };
    })
    .filter((item) => item.criterion || item.comment);
}

function normalizeStatus(value: unknown): CriterionResult["status"] {
  const normalized = String(value ?? "").trim();

  if (
    normalized === "erfuellt" ||
    normalized === "teilweise" ||
    normalized === "nicht_erfuellt" ||
    normalized === "nicht_beurteilbar"
  ) {
    return normalized;
  }

  return "nicht_beurteilbar";
}

function normalizeConfidence(value: unknown): CriterionResult["confidence"] {
  const normalized = String(value ?? "").trim();

  if (normalized === "hoch" || normalized === "mittel" || normalized === "niedrig") {
    return normalized;
  }

  return "niedrig";
}

function normalizeMarginComments(
  input: AnalysisResult["marginComments"]
): NonNullable<AnalysisResult["marginComments"]> {
  return {
    staerken: cleanStringArray(input?.staerken, 5),
    entwicklungsbedarf: cleanStringArray(input?.entwicklungsbedarf, 5),
    textbezug: cleanStringArray(input?.textbezug, 5),
    struktur: cleanStringArray(input?.struktur, 5),
    spracheVorsichtig: cleanStringArray(input?.spracheVorsichtig, 5),
  };
}

function cleanStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, limit);
}
