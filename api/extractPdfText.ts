// api/extractCriteria.ts

export const config = {
  maxDuration: 30,
};

type ExtractCriteriaRequestBody = {
  expectationHorizonText?: string;
  imageBase64?: string;
  imageMimeType?: string;
  fileName?: string;
  instructions?: string;
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
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripDataUrl(value: string): string {
  const cleaned = String(value ?? "").trim();
  const commaIndex = cleaned.indexOf(",");

  if (cleaned.startsWith("data:") && commaIndex >= 0) {
    return cleaned.slice(commaIndex + 1);
  }

  return cleaned;
}

function cleanJsonText(text: string): string {
  return String(text ?? "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
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

function normalizeExpectedElements(input: any): any[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((item) => {
      if (typeof item === "string") {
        return {
          label: "",
          erwartung: clean(item),
        };
      }

      return {
        label: clean(item?.label ?? item?.name ?? item?.title ?? ""),
        erwartung: clean(
          item?.erwartung ??
            item?.expected ??
            item?.text ??
            item?.description ??
            item?.beschreibung ??
            "",
        ),
      };
    })
    .filter((item) => item.label || item.erwartung);
}

function expectedElementsToText(input: any[]): string {
  return input
    .map((item) => [item.label, item.erwartung].filter(Boolean).join(": "))
    .filter(Boolean)
    .join("; ");
}

function normalizeCriteria(input: any): any[] {
  const raw = Array.isArray(input) ? input : [];

  return raw
    .map((criterion: any, index: number) => {
      const expectedElements = normalizeExpectedElements(criterion?.expectedElements);
      const expectedText = expectedElementsToText(expectedElements);

      const kriterium =
        clean(criterion?.kriterium) ||
        clean(criterion?.criterion) ||
        clean(criterion?.title) ||
        clean(criterion?.name) ||
        `Kriterium ${index + 1}`;

      const bereich =
        clean(criterion?.bereich) ||
        clean(criterion?.area) ||
        clean(criterion?.category) ||
        "Allgemein";

      const erwartung =
        clean(criterion?.erwartung) ||
        clean(criterion?.expected) ||
        expectedText;

      const beschreibung =
        clean(criterion?.beschreibung) ||
        clean(criterion?.description) ||
        erwartung ||
        kriterium;

      return {
        id: clean(criterion?.id) || `crit-${index}`,
        bereich,
        kriterium,
        beschreibung,
        erwartung,
        expectedElements,
        gewichtung: clean(criterion?.gewichtung ?? criterion?.weighting ?? ""),
        aktiv: criterion?.aktiv !== false,
      };
    })
    .filter(
      (criterion) =>
        criterion.kriterium ||
        criterion.beschreibung ||
        criterion.erwartung ||
        criterion.expectedElements.length > 0,
    );
}

async function callOpenAI(apiKey: string, content: any[]) {
  const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "Du extrahierst Bewertungsraster quellentreu als JSON. Keine Inhalte erfinden. Keine Inhalte weglassen.",
            },
          ],
        },
        {
          role: "user",
          content,
        },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
    }),
  });

  const raw = await openAiResponse.text();

  if (!openAiResponse.ok) {
    return {
      ok: false,
      status: openAiResponse.status,
      raw,
    };
  }

  return {
    ok: true,
    raw,
  };
}

export default async function handler(req: any, res: any) {
  const startedAt = Date.now();

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

    const body = (req.body ?? {}) as ExtractCriteriaRequestBody;

    const expectationHorizonText = clean(body.expectationHorizonText);
    const imageBase64 = clean(body.imageBase64);
    const imageMimeType = clean(body.imageMimeType) || "image/png";
    const fileName = clean(body.fileName) || "Erwartungshorizont";

    if (!expectationHorizonText && !imageBase64) {
      return sendJson(res, 400, {
        ok: false,
        error: "EMPTY_INPUT",
      });
    }

    const text = expectationHorizonText.slice(0, 12000);

    const prompt = `
Extrahiere aus diesem Bewertungsraster eine JSON-Struktur.

Regeln:
- Nutze nur den Rastertext.
- Bereiche aus Überschriften übernehmen.
- Kriterien aus Bewertungssätzen/Zeilen übernehmen.
- Konkrete Unterpunkte als expectedElements erhalten.
- Keine allgemeinen Ersatzformulierungen.
- Keine Inhalte erfinden.
- Keine Inhalte weglassen.
- Kurz bleiben.

JSON:
{
  "summary": "kurz",
  "criteria": [
    {
      "bereich": "string",
      "kriterium": "string",
      "beschreibung": "string",
      "erwartung": "string",
      "expectedElements": [
        { "label": "string", "erwartung": "string" }
      ],
      "gewichtung": "string",
      "aktiv": true
    }
  ]
}

Rastertext:
${text}
`.trim();

    const content: any[] = [
      {
        type: "input_text",
        text: prompt,
      },
    ];

    if (!expectationHorizonText && imageBase64 && imageMimeType.startsWith("image/")) {
      content.push({
        type: "input_image",
        image_url: `data:${imageMimeType};base64,${stripDataUrl(imageBase64)}`,
      });
    }

    const openAiResult = await callOpenAI(apiKey, content);

    if (!openAiResult.ok) {
      return sendJson(res, 500, {
        ok: false,
        error: "OPENAI_ERROR",
        status: openAiResult.status,
        raw: openAiResult.raw,
      });
    }

    let parsedOpenAi: any;

    try {
      parsedOpenAi = JSON.parse(openAiResult.raw);
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "OPENAI_RESPONSE_NOT_JSON",
        raw: openAiResult.raw,
      });
    }

    const outputText = extractOutputText(parsedOpenAi);

    if (!outputText) {
      return sendJson(res, 500, {
        ok: false,
        error: "EMPTY_MODEL_RESPONSE",
        parsedOpenAi,
      });
    }

    let modelJson: any;

    try {
      modelJson = JSON.parse(cleanJsonText(outputText));
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "MODEL_NOT_JSON",
        outputText,
      });
    }

    const criteria = normalizeCriteria(modelJson?.criteria);

    if (criteria.length === 0) {
      return sendJson(res, 500, {
        ok: false,
        error: "NO_CRITERIA_EXTRACTED",
        modelJson,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      summary: clean(modelJson?.summary),
      criteria,
      debug: {
        count: criteria.length,
        inputType: expectationHorizonText ? "text" : imageMimeType,
        fileName,
        sourceTextLength: expectationHorizonText.length,
        usedTextLength: text.length,
        durationMs: Date.now() - startedAt,
      },
      usage: parsedOpenAi?.usage ?? null,
    });
  } catch (error: any) {
    return sendJson(res, 500, {
      ok: false,
      error: "SERVER_ERROR",
      message: error?.message ?? String(error),
    });
  }
}
