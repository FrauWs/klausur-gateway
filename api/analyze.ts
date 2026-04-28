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
  evidence: string; // <-- NEU: verpflichtender Textbeleg
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
      });
    }

    if (!expectationHorizonText) {
      return sendJson(res, 400, {
        ok: false,
        error: "MISSING_EXPECTATION_HORIZON",
      });
    }

    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!openaiApiKey) {
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
              "Du bist ein strenger Korrekturassistent. Jede Aussage muss durch eine konkrete Textstelle belegt sein. Ohne Beleg ist die Bewertung ungültig.",
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
  return `
Analysiere den Schülertext strikt anhand eines Bewertungsrasters.

ERWARTUNGSHORIZONT:
${input.expectationHorizonText}

SCHÜLERTEXT:
${input.sanitizedText}

AUFGABE:
- Extrahiere Kriterien.
- Prüfe jedes Kriterium einzeln.
- BELEGE JEDE BEWERTUNG mit einer konkreten Textstelle.

REGELN:
- Jede Bewertung MUSS ein direktes Zitat enthalten.
- Zitate dürfen maximal 12 Wörter lang sein.
- Zitate müssen exakt aus dem Schülertext stammen.
- Wenn kein Beleg vorhanden ist:
  → status = "nicht erfüllt"
  → evidence = ""
- Keine erfundenen Belege.
- Kein allgemeines Urteil ohne Textstelle.

FORMAT:

{
  "criteriaResults": [
    {
      "criterion": "string",
      "status": "erfüllt | teilweise | nicht erfüllt",
      "comment": "kurzer fachlicher Befund",
      "evidence": "konkrete Textstelle aus dem Schülertext",
      "confidence": "hoch | mittel | niedrig"
    }
  ]
}
`;
}

function normalizeCriteriaResults(input: unknown): CriteriaResult[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      const raw = item as Partial<CriteriaResult>;

      return {
        criterion: String(raw.criterion ?? "").trim(),
        status: normalizeStatus(raw.status),
        comment: String(raw.comment ?? "").trim(),
        evidence: String(raw.evidence ?? "").trim(),
        confidence: normalizeConfidence(raw.confidence),
      };
    })
    .filter((item) => item.criterion)
    .slice(0, 15);
}

function normalizeStatus(value: unknown): CriteriaResult["status"] {
  const v = String(value ?? "").trim();
  if (v === "erfüllt" || v === "teilweise" || v === "nicht erfüllt") return v;
  return "teilweise";
}

function normalizeConfidence(value: unknown): CriteriaResult["confidence"] {
  const v = String(value ?? "").trim();
  if (v === "hoch" || v === "mittel" || v === "niedrig") return v;
  return "niedrig";
}
