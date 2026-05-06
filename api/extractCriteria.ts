// api/extractCriteria.ts

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
    .map((item) => ({
      label: clean(item?.label),
      erwartung: clean(item?.erwartung),
    }))
    .filter((item) => item.label || item.erwartung);
}

function expectedElementsToText(input: any[]): string {
  return input.map((item) => `${item.label}: ${item.erwartung}`).join("; ");
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
        `Kriterium ${index + 1}`;

      const erwartung = clean(criterion?.erwartung) || expectedText;

      const beschreibung =
        clean(criterion?.beschreibung) ||
        (expectedText ? `Konkrete Anforderungen: ${expectedText}` : erwartung);

      return {
        id: clean(criterion?.id) || `crit-${index}`,
        bereich: clean(criterion?.bereich) || "Allgemein",
        kriterium,
        beschreibung,
        erwartung,
        expectedElements,
        gewichtung: clean(criterion?.gewichtung),
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

    const expectationHorizonText = clean(body.expectationHorizonText);
    const fileBase64 = clean(body.imageBase64);
    const fileMimeType = clean(body.imageMimeType) || "image/png";
    const fileName = clean(body.fileName) || "Erwartungshorizont";

    if (!expectationHorizonText && !fileBase64) {
      return sendJson(res, 400, {
        error: "EMPTY_INPUT",
        message: "Es wurde weder Text noch Datei übergeben.",
      });
    }

    const content: any[] = [
      {
        type: "input_text",
        text: `
Extrahiere das Bewertungsraster quellentreu.

Wichtig:
- Nicht zusammenfassen.
- Keine Kriterien erfinden.
- Konkrete Angaben aus dem Raster übernehmen.
- expectedElements müssen konkrete Unterpunkte enthalten.
- Keine allgemeinen Platzhalter wie "alle relevanten Angaben".
- Wenn das Raster Textsorte, Titel, Autor, Jahr, Thema, Inhalt, Strophen, Reimschema oder sprachliche Mittel nennt, müssen diese konkret erscheinen.
- Ein zweiseitiges Raster darf nicht auf wenige Sammelkriterien reduziert werden.
- Gib ausschließlich JSON zurück.

JSON-Format:
{
  "summary": "kurze Zusammenfassung",
  "criteria": [
    {
      "bereich": "string",
      "kriterium": "string",
      "beschreibung": "string",
      "erwartung": "string",
      "expectedElements": [
        {
          "label": "string",
          "erwartung": "string"
        }
      ],
      "gewichtung": "string",
      "aktiv": true
    }
  ]
}

Raster/Text:
${expectationHorizonText || `Die Datei ${fileName} enthält das Bewertungsraster.`}
        `.trim(),
      },
    ];

    if (fileBase64 && fileMimeType === "application/pdf") {
      content.push({
        type: "input_file",
        filename: fileName.toLowerCase().endsWith(".pdf") ? fileName : `${fileName}.pdf`,
        file_data: `data:application/pdf;base64,${stripDataUrl(fileBase64)}`,
      });
    }

    if (fileBase64 && fileMimeType.startsWith("image/")) {
      content.push({
        type: "input_image",
        image_url: `data:${fileMimeType};base64,${stripDataUrl(fileBase64)}`,
      });
    }

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
        parsedOpenAi,
      });
    }

    let modelJson: any;

    try {
      modelJson = JSON.parse(cleanJsonText(outputText));
    } catch {
      return sendJson(res, 500, {
        error: "MODEL_NOT_JSON",
        outputText,
      });
    }

    const criteria = normalizeCriteria(modelJson?.criteria);

    if (criteria.length === 0) {
      return sendJson(res, 500, {
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
        inputType: fileBase64 ? fileMimeType : "text",
        fileName,
      },
      usage: parsedOpenAi?.usage ?? null,
    });
  } catch (error: any) {
    return sendJson(res, 500, {
      error: "SERVER_ERROR",
      message: error?.message ?? String(error),
    });
  }
}
