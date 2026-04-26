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
      });
    }

    if (!expectationHorizonText) {
      return sendJson(res, 400, {
        ok: false,
        error: "MISSING_EXPECTATION_HORIZON",
      });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!OPENAI_API_KEY) {
      return sendJson(res, 500, {
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
              "Du bist ein professioneller Korrekturassistent. Gib ausschließlich gültiges JSON zurück.",
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
      parsed = JSON.parse(content);
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
    });
  } catch (err: any) {
    return sendJson(res, 500, {
      ok: false,
      error: err?.name === "AbortError" ? "TIMEOUT" : "UNKNOWN_ERROR",
      message: err?.message ?? "Unknown error",
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
  return `
Analysiere den Schülertext anhand des Erwartungshorizonts.

TEXT:
${input.sanitizedText}

ERWARTUNG:
${input.expectationHorizonText}

Gib nur JSON zurück.
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
      subject: parsed.context?.subject || fallbackContext.subject,
      gradeLevel: parsed.context?.gradeLevel || fallbackContext.gradeLevel,
      taskType: parsed.context?.taskType || fallbackContext.taskType,
    },
    extractedExpectation: parsed.extractedExpectation || {
      taskType: "",
      operators: [],
      criteria: [],
    },
    marginComments: normalizeMarginComments(parsed.marginComments),
    finalComment: parsed.finalComment || "",
    limitations: parsed.limitations || {
      spellingAssessment: "not_reliable_due_to_ocr",
      note: "",
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

  if (!input) return empty;

  return {
    aufgabenbezug: clean(input.aufgabenbezug),
    inhalt: clean(input.inhalt),
    fachlichkeit: clean(input.fachlichkeit),
    materialbezug: clean(input.materialbezug),
    argumentation: clean(input.argumentation),
    struktur: clean(input.struktur),
    spracheVorsichtig: clean(input.spracheVorsichtig),
  };
}

function clean(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 4);
}
