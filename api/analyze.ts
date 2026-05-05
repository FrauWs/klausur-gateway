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

type NormalizedMarginComment = {
  criterion: string;
  category: string;
  severity: "positiv" | "neutral" | "kritisch";
  textEvidence: string;
  comment: string;
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

    const marginComments = normalizeMarginComments(modelJson?.marginComments, normalized);
    const gutachten = clean(modelJson?.gutachten ?? modelJson?.summary?.gutachten ?? "");

    return sendJson(res, 200, {
      ok: true,
      analysis: {
        criteriaResults: normalized,
        rasterabgleich: normalized,
        marginComments,
        randkommentare: marginComments,
        gutachten,
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
Du analysierst Schülertexte anhand eines konkreten Bewertungsrasters.

Du arbeitest ausschließlich kriteriumsbasiert.
Du erfindest keine Kriterien.
Du vergibst keine Note.
Du vergibst keine Punkte.
Du gibst keine Prozentwerte aus.

WICHTIG:
Randkommentare dürfen und müssen bewertend sein.
Das Gutachten wird aus den Randkommentaren und Rasterbefunden abgeleitet.
Ein Gutachten darf nicht frei erfunden werden.
Ein Gutachten darf keine neuen Aspekte enthalten, die nicht vorher in Rasterbefunden oder Randkommentaren erscheinen.

FORMULIERUNGSLOGIK FÜR OBERSTUFE / ABITUR:
Nutze für Randkommentare und Gutachten einen sachlichen, standardisierten Oberstufen-Ton.

Orientiere dich sprachlich an solchen Bewertungsachsen:
- Textverständnis: differenziert / weitgehend richtig / im Allgemeinen sachlich korrekt / noch korrekt mit Ungenauigkeiten / nur ansatzweise / nicht nachgewiesen
- Erfassen geforderter Aspekte: fokussiert / überwiegend korrekt / teilweise korrekt / nur ansatzweise / nicht erfasst
- Gedankenführung: stringent und strukturiert / weitgehend strukturiert / in Ansätzen strukturiert / nicht nachvollziehbar
- Textbezug: durchgängig treffend / fast durchgängig korrekt / teilweise ungenau / oberflächlich / häufig unzutreffend / kein zutreffender Textbezug
- Analyse: sachgemäßer Aufbau, Deutung spezifischer Gestaltungsmittel, Genauigkeit des Textbezugs
- Argumentation: nachvollziehbar, differenziert, widerspruchsfrei, belegt
- Sprachmittlung / Gestaltung: Adressatenbezug, Textaufbau, Materialbezug

Diese Formulierungen sind KEIN Raster.
Sie dienen nur als standardisierte Sprache für Randkommentare und Gutachten.

Randkommentare:
- beziehen sich auf konkrete Kriterien
- enthalten einen konkreten Textbeleg, wenn vorhanden
- benennen sachlich, ob ein Aspekt klar, weitgehend, teilweise, kaum oder nicht erkennbar ist
- dürfen bewertend formulieren
- dürfen nicht bloß beschreiben
- dürfen keine Note enthalten
- dürfen keine Punkte enthalten

Gutachten:
- entsteht ausschließlich aus den Rasterbefunden und Randkommentaren
- ist ein zusammenhängender sachlicher Text
- benennt inhaltliche Leistung und Darstellungsleistung, soweit aus den Befunden ableitbar
- verwendet keine automatische Note
- verwendet keine automatische Punktzahl
- enthält keine pädagogischen Ratschläge
- enthält keine direkte Ansprache

Textbelege:
- bleiben in der Originalsprache des Schülertexts
- werden nicht übersetzt
- werden nicht erfunden

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
3. Gib zu jedem Kriterium:
   - Status
   - kurzen deutschen Hinweis
   - Textbeleg
   - Sicherheit
4. Erzeuge anschließend bewertende Randkommentare.
5. Leite daraus ein sachliches Gutachten ab.

TEXTBELEG:
- textEvidence muss ein kurzer Ausschnitt aus dem Schülertext sein.
- Wenn kein eindeutiger Beleg vorhanden ist, bleibt textEvidence leer.
- Keine erfundenen Textbelege.
- Keine Übersetzung fremdsprachiger Textbelege.

STRUKTUR:
- Beachte bei Kriterien zur Reihenfolge, ob der Aspekt an der passenden Stelle steht.
- Eine Interpretationshypothese vor der Analyse ist nicht dasselbe wie eine Schlussdeutung am Ende.
- Wenn ein Aspekt inhaltlich vorkommt, aber strukturell falsch platziert ist, maximal "teilweise vorhanden".

RANDKOMMENTARE:
- Randkommentare müssen bewertend sein.
- Sie sollen aus dem Rasterabgleich ableitbar sein.
- Sie dürfen standardisierte Oberstufenformulierungen nutzen.
- Sie müssen knapp, konkret und fachlich sein.
- Sie dürfen keine Noten oder Punkte enthalten.
- Sie dürfen keine direkte Anrede enthalten.
- Sie dürfen nicht als bloße Beschreibung formuliert sein.

GUTACHTEN:
- Das Gutachten muss aus den Randkommentaren ableitbar sein.
- Es darf keine neuen Befunde enthalten.
- Es soll die zentralen Befunde bündeln.
- Es soll in Oberstufen-/Abitur-Ton formuliert sein.
- Keine Note.
- Keine Punkte.
- Keine Prozentwerte.

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
  "marginComments": [
    {
      "criterion": "Name des Kriteriums aus dem Raster",
      "category": "Textverständnis | Analyse | Textbezug | Gedankenführung | Sprache | Struktur | Darstellung | Sonstiges",
      "severity": "positiv | neutral | kritisch",
      "textEvidence": "kurzer Originalausschnitt aus dem Schülertext oder leer",
      "comment": "bewertender Randkommentar auf Deutsch"
    }
  ],
  "gutachten": "zusammenhängendes Gutachten auf Deutsch",
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

function normalizeMarginComments(input: any, fallbackResults: NormalizedResult[]): NormalizedMarginComment[] {
  const raw = Array.isArray(input) ? input : [];

  const normalized = raw
    .map((item: any, index: number) => {
      const criterion = clean(item?.criterion ?? item?.kriterium ?? `Kriterium ${index + 1}`);
      const category = clean(item?.category ?? item?.bereich ?? "Sonstiges") || "Sonstiges";
      const severity = normalizeSeverity(item?.severity);
      const textEvidence = clean(item?.textEvidence ?? item?.evidence ?? item?.textbeleg ?? "");
      const comment = clean(item?.comment ?? item?.hinweis ?? "");

      return {
        criterion,
        category,
        severity,
        textEvidence,
        comment,
      };
    })
    .filter((item: NormalizedMarginComment) => item.criterion && item.comment);

  if (normalized.length > 0) return normalized;

  return fallbackResults.map((result) => ({
    criterion: result.criterion,
    category: "Sonstiges",
    severity: severityFromStatus(result.status),
    textEvidence: result.textEvidence,
    comment: result.comment || result.hinweis,
  }));
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

function normalizeSeverity(value: unknown): "positiv" | "neutral" | "kritisch" {
  const raw = clean(value).toLowerCase();

  if (raw === "positiv") return "positiv";
  if (raw === "kritisch") return "kritisch";
  return "neutral";
}

function severityFromStatus(status: string): "positiv" | "neutral" | "kritisch" {
  const raw = status.toLowerCase();

  if (raw.includes("klar") || raw.includes("weitgehend")) return "positiv";
  if (raw.includes("kaum") || raw.includes("nicht")) return "kritisch";
  return "neutral";
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
