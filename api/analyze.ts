// api/analyze.ts

export const config = {
  maxDuration: 60,
};

function setCors(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res: any, status: number, payload: unknown) {
  setCors(res);
  res.setHeader("Content-Type", "application/json");
  return res.status(status).json(payload);
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractOutputText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;

  const output = Array.isArray(response?.output) ? response.output : [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") return part.text;
    }
  }

  return "";
}

function normalizeCriteria(input: any): any[] {
  const raw = Array.isArray(input)
    ? input
    : Array.isArray(input?.criteria)
      ? input.criteria
      : [];

  return raw.map((criterion: any, index: number) => {
    const expectedElements = Array.isArray(criterion?.expectedElements)
      ? criterion.expectedElements.slice(0, 10)
      : [];

    return {
      id: clean(criterion?.id) || `crit-${index}`,
      bereich: clean(criterion?.bereich) || "Allgemein",
      kriterium: clean(criterion?.kriterium) || `Kriterium ${index + 1}`,
      beschreibung: clean(criterion?.beschreibung),
      erwartung: clean(criterion?.erwartung),
      expectedElements,
    };
  });
}

function buildCompactRaster(criteria: any[]) {
  return criteria.slice(0, 18).map((criterion) => ({
    id: criterion.id,
    bereich: criterion.bereich,
    kriterium: criterion.kriterium,
    beschreibung: criterion.beschreibung.slice(0, 500),
    erwartung: criterion.erwartung.slice(0, 700),
    expectedElements: criterion.expectedElements,
  }));
}

export default async function handler(req: any, res: any) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, {
      error: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(res, 500, {
        error: "MISSING_API_KEY",
      });
    }

    const body = req.body ?? {};

    const studentText =
      clean(body.studentText) ||
      clean(body.cleanedStudentText) ||
      clean(body.analysisText) ||
      clean(body.text) ||
      clean(body.transcription) ||
      clean(body.klausurText);

    const criteria =
      normalizeCriteria(body.criteria).length > 0
        ? normalizeCriteria(body.criteria)
        : normalizeCriteria(body.raster);

    if (!studentText || criteria.length === 0) {
      return sendJson(res, 400, {
        error: "MISSING_INPUT",
        debug: {
          receivedKeys: Object.keys(body),
          hasStudentText: Boolean(studentText),
          studentTextLength: studentText.length,
          criteriaCount: criteria.length,
        },
      });
    }

    const compactRaster = buildCompactRaster(criteria);
    const shortenedStudentText = studentText.slice(0, 14000);

    const prompt = `
Analysiere den Schülertext anhand des Bewertungsrasters.

WICHTIG ZU TEXTBELEGEN:
- Für jedes Kriterium musst du im Schülertext nach passenden Stellen suchen.
- Wenn eine Stelle vorhanden ist, zitiere sie wörtlich oder nahezu wörtlich.
- Der Textbeleg darf NICHT leer sein, wenn der Kommentar sich auf eine konkrete Leistung bezieht.
- Schreibe NICHT "Kein eindeutiger Textbeleg gefunden", wenn im Schülertext ein passender Satz oder Teilsatz vorhanden ist.
- Wenn mehrere Stellen passen, nenne 1 bis 2 kurze Textbelege.
- Nur wenn wirklich keine passende Stelle existiert, schreibe: "Kein belegbarer Textbezug im Schülertext."

REGELN:
- Bewerte nur auf Basis des Schülertexts.
- Erfinde keine Leistung.
- Prüfe jedes Kriterium einzeln.
- Nutze erwartung und expectedElements.
- Formuliere knapp, aber konkret.
- Gib ausschließlich JSON zurück.

RASTER:
${JSON.stringify(compactRaster)}

SCHÜLERTEXT:
${shortenedStudentText}

Gib exakt diese JSON-Struktur zurück:

{
  "results": [
    {
      "criterionId": "string",
      "criterion": "string",
      "status": "erfüllt | teilweise | nicht erfüllt | nicht beurteilbar",
      "comment": "string",
      "textbezug": "kurzer konkreter Textbeleg aus dem Schülertext",
      "textbeleg": "kurzer konkreter Textbeleg aus dem Schülertext",
      "evidence": "kurzer konkreter Textbeleg aus dem Schülertext",
      "quote": "kurzer konkreter Textbeleg aus dem Schülertext",
      "confidence": "hoch | mittel | niedrig"
    }
  ],
  "summary": "string"
}
`.trim();

    const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        input: prompt,
        text: {
          format: {
            type: "json_object",
          },
        },
      }),
    });

    const raw = await openAiResponse.text();

    if (!openAiResponse.ok) {
      return sendJson(res, 500, {
        error: "OPENAI_ERROR",
        status: openAiResponse.status,
        raw,
      });
    }

    let parsedOpenAi: any;

    try {
      parsedOpenAi = JSON.parse(raw);
    } catch {
      return sendJson(res, 500, {
        error: "OPENAI_RESPONSE_NOT_JSON",
        raw,
      });
    }

    const outputText = extractOutputText(parsedOpenAi);

    if (!outputText) {
      return sendJson(res, 500, {
        error: "EMPTY_MODEL_RESPONSE",
      });
    }

    let modelJson: any;

    try {
      modelJson = JSON.parse(outputText);
    } catch {
      return sendJson(res, 500, {
        error: "MODEL_NOT_JSON",
        outputText,
      });
    }

    const results = Array.isArray(modelJson?.results)
      ? modelJson.results.map((item: any) => {
          const evidence =
            clean(item?.textbezug) ||
            clean(item?.textbeleg) ||
            clean(item?.evidence) ||
            clean(item?.quote) ||
            "Kein belegbarer Textbezug im Schülertext.";

          return {
            criterionId: clean(item?.criterionId),
            criterion: clean(item?.criterion),
            status: clean(item?.status),
            comment: clean(item?.comment),
            textbezug: evidence,
            textbeleg: evidence,
            evidence,
            quote: evidence,
            confidence: clean(item?.confidence) || "mittel",
          };
        })
      : [];

    return sendJson(res, 200, {
      results,
      summary: clean(modelJson?.summary),
      usage: parsedOpenAi?.usage ?? null,
      debug: {
        criteriaCount: compactRaster.length,
        studentTextLength: shortenedStudentText.length,
      },
    });
  } catch (error: any) {
    return sendJson(res, 500, {
      error: "SERVER_ERROR",
      message: error?.message ?? String(error),
    });
  }
}
