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
  if (typeof response?.output_text === "string") {
    return response.output_text;
  }

  const output = Array.isArray(response?.output) ? response.output : [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];

    for (const part of content) {
      if (typeof part?.text === "string") {
        return part.text;
      }
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

  return raw.map((criterion: any, index: number) => ({
    id: clean(criterion?.id) || `crit-${index}`,
    kriterium: clean(criterion?.kriterium) || `Kriterium ${index + 1}`,
    erwartung: clean(criterion?.erwartung),
  }));
}

function buildCompactRaster(criteria: any[]) {
  return criteria
    .slice(0, 15)
    .map((criterion) => ({
      id: criterion.id,
      kriterium: criterion.kriterium.slice(0, 120),
      erwartung: criterion.erwartung.slice(0, 300),
    }));
}

export default async function handler(req: any, res: any) {
  setCors(res);

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
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(res, 500, {
        ok: false,
        error: "MISSING_API_KEY",
      });
    }

    const body = req.body ?? {};

    const studentText =
      clean(body.studentText) ||
      clean(body.cleanedStudentText) ||
      clean(body.analysisText) ||
      clean(body.text);

    const criteria =
      normalizeCriteria(body.criteria).length > 0
        ? normalizeCriteria(body.criteria)
        : normalizeCriteria(body.raster);

    if (!studentText || criteria.length === 0) {
      return sendJson(res, 400, {
        ok: false,
        error: "MISSING_INPUT",
        debug: {
          receivedKeys: Object.keys(body),
          hasStudentText: Boolean(studentText),
          criteriaCount: criteria.length,
        },
      });
    }

    // 🔥 MASSIV REDUZIEREN
    const compactRaster = buildCompactRaster(criteria);

    // 🔥 SCHÜLERTEXT KÜRZEN
    const shortenedStudentText = studentText.slice(0, 12000);

    const prompt = `
Bewerte den Schülertext anhand des Bewertungsrasters.

REGELN:
- Nur auf Basis des Textes bewerten.
- Keine Halluzinationen.
- Kurz und konkret bleiben.
- Maximal 2 kurze Sätze pro Kriterium.

RASTER:
${JSON.stringify(compactRaster)}

SCHÜLERTEXT:
${shortenedStudentText}

Gib ausschließlich JSON zurück:

{
  "bewertungen": [
    {
      "criterionId": "string",
      "kriterium": "string",
      "einschaetzung": "erfüllt | teilweise | nicht erfüllt",
      "begründung": "string"
    }
  ],
  "gesamtKommentar": "string"
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
        ok: false,
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
        ok: false,
        error: "OPENAI_RESPONSE_NOT_JSON",
        raw,
      });
    }

    const outputText = extractOutputText(parsedOpenAi);

    if (!outputText) {
      return sendJson(res, 500, {
        ok: false,
        error: "EMPTY_MODEL_RESPONSE",
      });
    }

    let modelJson: any;

    try {
      modelJson = JSON.parse(outputText);
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "MODEL_NOT_JSON",
        outputText,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      ...modelJson,
      debug: {
        criteriaCount: compactRaster.length,
        originalCriteriaCount: criteria.length,
        studentTextLength: shortenedStudentText.length,
      },
    });
  } catch (error: any) {
    return sendJson(res, 500, {
      ok: false,
      error: "SERVER_ERROR",
      message: error?.message ?? String(error),
    });
  }
}
