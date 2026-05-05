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

type NormalizedResult = {
  criterion: string;
  kriterium: string;
  status: string;
  comment: string;
  hinweis: string;
  textEvidence: string;
  confidence: "hoch" | "mittel" | "niedrig";
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

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(res, 500, {
        ok: false,
        error: "MISSING_API_KEY",
        message: "OPENAI_API_KEY ist nicht gesetzt.",
      });
    }

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
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: buildPrompt({
              sanitizedText,
              expectationHorizonText,
              assignmentText,
              subject,
              gradeLevel,
              taskType,
            }),
          },
        ],
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      return sendJson(res, 500, {
        ok: false,
        error: "OPENAI_ERROR",
        raw,
      });
    }

    let parsedOpenAI: any;

    try {
      parsedOpenAI = JSON.parse(raw);
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "INVALID_OPENAI_RESPONSE",
        raw,
      });
    }

    const content = parsedOpenAI?.choices?.[0]?.message?.content;

    if (!content || typeof content !== "string") {
      return sendJson(res, 500, {
        ok: false,
        error: "EMPTY_MODEL_RESPONSE",
        parsedOpenAI,
      });
    }

    let modelJson: any;

    try {
      modelJson = JSON.parse(content);
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "MODEL_NOT_JSON",
        content,
      });
    }

    const rawResults =
      modelJson?.criteriaResults ??
      modelJson?.rasterabgleich ??
      modelJson?.analysis?.criteriaResults ??
      modelJson?.analysis?.rasterabgleich ??
      [];

    if (!Array.isArray(rawResults) || rawResults.length === 0) {
      return sendJson(res, 500, {
        ok: false,
        error: "NO_ANALYSIS_RESULTS",
        modelJson,
      });
    }

    const normalized = normalizeResults(rawResults);

    if (normalized.length === 0) {
      return sendJson(res, 500, {
        ok: false,
        error: "EMPTY_NORMALIZED_RESULTS",
        modelJson,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      analysis: {
        criteriaResults: normalized,
        rasterabgleich: normalized,
      },
      languageHints: Array.isArray(modelJson?.languageHints)
        ? modelJson.languageHints
        : Array.isArray(modelJson?.sprachliche_auffaelligkeiten)
          ? modelJson.sprachliche_auffaelligkeiten
          : [],
      usage: parsedOpenAI?.usage ?? null,
    });
  } catch (error: any) {
    return sendJson(res, 500, {
      ok: false,
      error: "SERVER_ERROR",
      message: error?.message ?? "Unbekannter Fehler.",
    });
  }
}

const SYSTEM_PROMPT = `
Du analysierst Schülertexte anhand eines Bewertungsrasters.

Du arbeitest ausschließlich kriteriumsbasiert.
Du gibst keine Note.
Du vergibst keine Punkte.
Du triffst kein Gesamturteil.
Du formulierst Kommentare immer auf Deutsch.
Textbelege bleiben in der Originalsprache des Schülertexts.

Du darfst keine Kriterien erfinden.
Du darfst keine freien Bewertungen ergänzen.
Du darfst keine pädagogischen Ratschläge geben.

Jedes Ergebnis muss sich auf ein konkretes Kriterium aus dem Erwartungshorizont beziehen.

Erlaubte Statuswerte:
- klar vorhanden
- weitgehend vorhanden
- teilweise vorhanden
- kaum erkennbar
- nicht erkennbar

Erlaubte Sicherheitswerte:
- hoch
- mittel
- niedrig

Gib ausschließlich gültiges JSON zurück.
`;

function buildPrompt(input: {
  sanitizedText: string;
  expectationHorizonText: string;
  assignmentText: string;
  subject: string;
  gradeLevel: string;
  taskType: string;
}) {
  return `
Analysiere den Schülertext strikt anhand des Bewertungsrasters.

KONTEXT:
Fach: ${input.subject || "nicht angegeben"}
Jahrgang/Klasse: ${input.gradeLevel || "nicht angegeben"}
Aufgabenart: ${input.taskType || "nicht angegeben"}

AUFGABENSTELLUNG:
${input.assignmentText || "Keine separate Aufgabenstellung übergeben."}

BEWERTUNGSRASTER / ERWARTUNGSHORIZONT:
${input.expectationHorizonText}

SCHÜLERTEXT:
${input.sanitizedText}

AUFGABE:
1. Nutze ausschließlich die Kriterien aus dem Bewertungsraster.
2. Prüfe jedes Kriterium einzeln gegen den Schülertext.
3. Gib zu jedem Kriterium einen Status, einen kurzen deutschen Hinweis, einen Textbeleg und eine Sicherheit zurück.

TEXTBELEG:
- textEvidence muss ein kurzer Ausschnitt aus dem Schülertext sein.
- Wenn kein eindeutiger Beleg vorhanden ist, bleibt textEvidence leer.
- Keine erfundenen Textbelege.
- Keine Übersetzung fremdsprachiger Textbelege.

STRUKTUR:
- Beachte bei Kriterien zur Reihenfolge, ob der Aspekt an der passenden Stelle steht.
- Eine Interpretationshypothese vor der Analyse ist nicht dasselbe wie eine Schlussdeutung am Ende.
- Wenn ein Aspekt inhaltlich vorkommt, aber strukturell falsch platziert ist, maximal "teilweise vorhanden".

Gib ausschließlich JSON in exakt dieser Struktur zurück:

{
  "criteriaResults": [
    {
      "criterion": "Name des Kriteriums aus dem Raster",
      "status": "klar vorhanden | weitgehend vorhanden | teilweise vorhanden | kaum erkennbar | nicht erkennbar",
      "comment": "kurzer deutscher Hinweis",
      "textEvidence": "kurzer Originalausschnitt aus dem Schülertext oder leer",
      "confidence": "hoch | mittel | niedrig"
    }
  ],
  "languageHints": []
}

AUSGABEREGELN:
- Kein Markdown.
- Kein Text außerhalb des JSON.
- Keine Noten.
- Keine Punkte.
- Keine Prozentwerte.
`;
}

function normalizeResults(input: any[]): NormalizedResult[] {
  return input
    .map((item, index) => {
      const criterion = clean(
        item?.criterion ??
          item?.kriterium ??
          item?.name ??
          item?.title ??
          `Kriterium ${index + 1}`,
      );

      const comment = clean(
        item?.comment ??
          item?.hinweis ??
          item?.beschreibung ??
          "",
      );

      const textEvidence = clean(
        item?.textEvidence ??
          item?.evidence ??
          item?.textbeleg ??
          "",
      );

      const status = normalizeStatus(item?.status);
      const confidence = normalizeConfidence(item?.confidence ?? item?.sicherheit);

      return {
        criterion,
        kriterium: criterion,
        status,
        comment,
        hinweis: comment,
        textEvidence,
        confidence,
      };
    })
    .filter((item) => item.criterion || item.comment);
}

function normalizeStatus(value: unknown): string {
  const raw = clean(value).toLowerCase();

  if (raw === "klar vorhanden") return "klar vorhanden";
  if (raw === "weitgehend vorhanden") return "weitgehend vorhanden";
  if (raw === "teilweise vorhanden") return "teilweise vorhanden";
  if (raw === "kaum erkennbar") return "kaum erkennbar";
  if (raw === "nicht erkennbar") return "nicht erkennbar";

  if (raw.includes("klar")) return "klar vorhanden";
  if (raw.includes("weitgehend")) return "weitgehend vorhanden";
  if (raw.includes("teilweise")) return "teilweise vorhanden";
  if (raw.includes("kaum")) return "kaum erkennbar";
  if (raw.includes("nicht")) return "nicht erkennbar";

  if (raw.includes("erfüllt")) return "weitgehend vorhanden";

  return "teilweise vorhanden";
}

function normalizeConfidence(value: unknown): "hoch" | "mittel" | "niedrig" {
  const raw = clean(value).toLowerCase();

  if (raw === "hoch") return "hoch";
  if (raw === "mittel") return "mittel";
  if (raw === "niedrig") return "niedrig";

  return "mittel";
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
