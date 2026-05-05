// api/analyze.ts

import { SYSTEM_PROMPT } from "../analyzePrompt";
import { AnalyzeResponseSchema } from "../analyzeSchema";

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
    const timeout = setTimeout(() => controller.abort(), 30000);

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
            content: SYSTEM_PROMPT,
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

    let parsed: unknown;

    try {
      parsed = JSON.parse(content);
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "INVALID_JSON_FROM_MODEL",
        raw: content,
      });
    }

    const validated = AnalyzeResponseSchema.safeParse(parsed);

    if (!validated.success) {
      return sendJson(res, 500, {
        ok: false,
        error: "INVALID_ANALYSIS_SCHEMA",
        details: validated.error.flatten(),
        raw: parsed,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      analysis: validated.data,
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
Analysiere den folgenden Schülertext anhand des Erwartungshorizonts.

KONTEXT:
Fach: ${input.subject || "nicht angegeben"}
Jahrgang/Klasse: ${input.gradeLevel || "nicht angegeben"}
Aufgabenart: ${input.taskType || "nicht angegeben"}

AUFGABENSTELLUNG:
${input.assignmentText || "Keine separate Aufgabenstellung übergeben."}

ERWARTUNGSHORIZONT / BEWERTUNGSRASTER:
${input.expectationHorizonText}

SCHÜLERTEXT:
${input.sanitizedText}

AUFGABE:
1. Extrahiere die tatsächlichen Bewertungskriterien ausschließlich aus dem Erwartungshorizont.
2. Prüfe den Schülertext systematisch gegen jedes Kriterium.
3. Gib zu jedem Kriterium einen Status, einen knappen Hinweis, einen Textbeleg und eine Sicherheit zurück.
4. Prüfe zusätzlich die Textstruktur:
   - Einleitung
   - Interpretationshypothese
   - Hauptteil
   - Analyseform
   - Schluss/Fazit

WICHTIG:
- Kommentare und Hinweise immer auf Deutsch.
- Textbelege exakt aus dem Schülertext übernehmen.
- Fremdsprachige Textbelege nicht übersetzen.
- Keine Noten.
- Keine Punkte.
- Keine Prozentwerte.
- Keine Gesamtbewertung.
- Keine erfundenen Kriterien.
- Keine erfundenen Textbelege.

STATUSWERTE:
Verwende ausschließlich:
- klar vorhanden
- weitgehend vorhanden
- teilweise vorhanden
- kaum erkennbar
- nicht erkennbar

STRUKTUR- UND REIHENFOLGENPRÜFUNG:
- Prüfe, ob die Interpretationshypothese vor der eigentlichen Analyse steht.
- Eine Deutung am Ende zählt nicht als Interpretationshypothese.
- Ein Fazit ersetzt keine Interpretationshypothese.
- Eine Interpretationshypothese ersetzt kein Fazit.
- Prüfe, ob die Analyse linear, aspektorientiert oder unklar aufgebaut ist.
- Wenn ein Aspekt zwar vorkommt, aber an der falschen Stelle steht, darf er höchstens als "teilweise vorhanden" gewertet werden.

TEXTBELEGE:
- Wenn ein Kriterium klar, weitgehend oder teilweise vorhanden ist, muss möglichst ein kurzer exakter Textbeleg angegeben werden.
- Wenn kein eindeutiger Beleg vorhanden ist, bleibt textEvidence leer.
- Textbelege dürfen nicht paraphrasiert, geglättet oder übersetzt werden.

Gib ausschließlich gültiges JSON in exakt dieser Struktur zurück:

{
  "struktur": {
    "einleitung": {
      "status": "klar vorhanden | weitgehend vorhanden | teilweise vorhanden | kaum erkennbar | nicht erkennbar",
      "hinweis": "string",
      "textEvidence": "string"
    },
    "interpretationshypothese": {
      "status": "klar vorhanden | weitgehend vorhanden | teilweise vorhanden | kaum erkennbar | nicht erkennbar",
      "hinweis": "string",
      "textEvidence": "string",
      "position_ok": true
    },
    "hauptteil": {
      "status": "klar vorhanden | weitgehend vorhanden | teilweise vorhanden | kaum erkennbar | nicht erkennbar",
      "hinweis": "string"
    },
    "analyseform": {
      "typ": "linear | aspektorientiert | unklar",
      "konsistent": true,
      "hinweis": "string"
    },
    "schluss": {
      "status": "klar vorhanden | weitgehend vorhanden | teilweise vorhanden | kaum erkennbar | nicht erkennbar",
      "hinweis": "string",
      "textEvidence": "string",
      "unterscheidung_zur_hypothese": "string"
    }
  },
  "rasterabgleich": [
    {
      "kriterium": "string",
      "status": "klar vorhanden | weitgehend vorhanden | teilweise vorhanden | kaum erkennbar | nicht erkennbar",
      "hinweis": "string",
      "textEvidence": "string",
      "confidence": "hoch | mittel | niedrig"
    }
  ],
  "sprachliche_auffaelligkeiten": [
    {
      "bereich": "string",
      "beschreibung": "string",
      "beispiel": "string"
    }
  ],
  "meta": {
    "textbelege_verwendet": true,
    "struktur_erkannt": true,
    "analyseform_erkannt": true
  },
  "hinweise": ["string"]
}

AUSGABEREGELN:
- Kein Markdown.
- Kein Text außerhalb des JSON.
- Maximal 20 Rasterkriterien.
- Hinweise knapp, sachlich und überprüfbar.
`;
}
