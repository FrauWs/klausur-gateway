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
      clean(body.text);

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
          criteriaCount: criteria.length,
        },
      });
    }

    const compactRaster = criteria.slice(0, 15);

    const prompt = `
Bewerte den Schülertext anhand des Bewertungsrasters.

REGELN:
- Kurz bleiben
- Keine Halluzination
- Nur auf Basis des Textes bewerten

RASTER:
${JSON.stringify(compactRaster)}

SCHÜLERTEXT:
${studentText.slice(0, 12000)}

Gib ausschließlich JSON zurück:

{
  "results": [
    {
      "criterionId": "string",
      "criterion": "string",
      "status": "erfüllt | teilweise | nicht erfüllt",
      "comment": "string"
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
      ? modelJson.results
      : [];

    return sendJson(res, 200, {
      results,
      summary: clean(modelJson?.summary),
      usage: parsedOpenAi?.usage ?? null,
    });
  } catch (error: any) {
    return sendJson(res, 500, {
      error: "SERVER_ERROR",
      message: error?.message ?? String(error),
    });
  }
}
