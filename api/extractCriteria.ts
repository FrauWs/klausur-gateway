// api/extractCriteria.ts

export const config = {
  maxDuration: 60,
};

type ExtractCriteriaRequestBody = {
  expectationHorizonText?: string;
  imageBase64?: string;
  imageMimeType?: string;
  fileName?: string;
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

export default async function handler(req: any, res: any) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(res, 500, { ok: false, error: "MISSING_API_KEY" });
    }

    const body = (req.body ?? {}) as ExtractCriteriaRequestBody;

    const expectationHorizonText = String(body.expectationHorizonText ?? "").trim();
    const fileBase64 = String(body.imageBase64 ?? "").trim();
    const fileMimeType = String(body.imageMimeType ?? "").trim() || "image/png";
    const fileName = String(body.fileName ?? "").trim() || "Erwartungshorizont";

    if (!expectationHorizonText && !fileBase64) {
      return sendJson(res, 400, {
        ok: false,
        error: "EMPTY_INPUT",
        message: "Es wurde weder Text noch Datei übergeben.",
      });
    }

    const openAiPayload = buildOpenAiPayload({
      expectationHorizonText,
      fileBase64,
      fileMimeType,
      fileName,
    });

    const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(openAiPayload),
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
      summary: clean(modelJson?.summary ?? ""),
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
      ok: false,
      error: "SERVER_ERROR",
      message: error?.message ?? String(error),
    });
  }
}

function buildOpenAiPayload(params: {
  expectationHorizonText: string;
  fileBase64: string;
  fileMimeType: string;
  fileName: string;
}) {
  const { expectationHorizonText, fileBase64, fileMimeType, fileName } = params;

  const content: any[] = [
    {
      type: "input_text",
      text: buildPrompt(
        expectationHorizonText ||
          `Das Bewertungsraster liegt als Datei vor. Dateiname: ${fileName}. Lies den Inhalt vollständig aus und extrahiere daraus ein Bewertungsraster.`,
      ),
    },
  ];

  if (fileBase64) {
    if (fileMimeType === "application/pdf") {
      content.push({
        type: "input_file",
        filename: fileName.toLowerCase().endsWith(".pdf") ? fileName : `${fileName}.pdf`,
        file_data: `data:application/pdf;base64,${stripDataUrl(fileBase64)}`,
      });
    } else if (fileMimeType.startsWith("image/")) {
      content.push({
        type: "input_image",
        image_url: `data:${fileMimeType};base64,${stripDataUrl(fileBase64)}`,
      });
    } else {
      content.push({
        type: "input_text",
        text: `Nicht direkt unterstützter Dateityp: ${fileMimeType}.`,
      });
    }
  }

  return {
    model: "gpt-4.1-mini",
    temperature: 0,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: SYSTEM_PROMPT,
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
  };
}

const SYSTEM_PROMPT = `
Du extrahierst Bewertungsraster aus Erwartungshorizonten.

Grundregel:
Ein Kriterium ist eine bewertbare Leistungseinheit.
Nicht jeder Unterpunkt ist automatisch ein eigenes Kriterium.

Du unterscheidest:
1. Kriterium = übergeordnete bewertbare Leistungseinheit
2. expectedElements = konkrete Teilanforderungen innerhalb dieses Kriteriums

Du darfst keine allgemeinen Kriterien erfinden.
Du darfst keine pädagogischen Standardformulierungen erzeugen.
Du darfst keine konkreten Inhalte weglassen.
Du darfst aber sinnvoll bündeln, wenn mehrere Unterpunkte gemeinsam eine einzige bewertbare Leistungseinheit bilden.

Gib ausschließlich gültiges JSON zurück.
`.trim();

function buildPrompt(text: string): string {
  return `
Extrahiere aus dem folgenden Erwartungshorizont ein Bewertungsraster.

Zusätzlich:
Erstelle eine kurze summary in 2 bis 4 Sätzen. Diese summary beschreibt knapp, worum es im Erwartungshorizont geht und welche Leistungsschwerpunkte er setzt.

TEXT ODER DATEI:
${text}

Gib ausschließlich JSON in exakt dieser Struktur zurück:

{
  "summary": "string",
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

Regeln:
- Kein Markdown.
- Kein Text außerhalb des JSON.
- Maximal 30 Kriterien.
- Lieber wenige intelligente Kriterien mit expectedElements als viele atomisierte Einzelpunkte.
- Keine konkreten Inhalte auslassen.
`.trim();
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
  const raw = Array.isArray(input) ? input : [];

  return raw
    .map((criterion, index) => {
      const expectedElements = normalizeExpectedElements(criterion?.expectedElements ?? []);
      const erwartung =
        clean(criterion?.erwartung ?? "") || expectedElementsToText(expectedElements);
      const kriterium =
        clean(criterion?.kriterium ?? "") || clean(criterion?.title ?? "") || `Kriterium ${index + 1}`;
      const beschreibung =
        clean(criterion?.beschreibung ?? "") ||
        buildDescription(kriterium, erwartung, expectedElements);

      return {
        id: `crit-${index}`,
        bereich: clean(criterion?.bereich ?? "") || "Allgemein",
        kriterium,
        beschreibung,
        erwartung,
        expectedElements,
        gewichtung: clean(criterion?.gewichtung ?? ""),
        aktiv: criterion?.aktiv !== false,
      };
    })
    .filter((criterion) => criterion.kriterium || criterion.beschreibung || criterion.erwartung);
}

function normalizeExpectedElements(input: any): { label: string; erwartung: string }[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((item) => ({
      label: clean(item?.label ?? ""),
      erwartung: clean(item?.erwartung ?? ""),
    }))
    .filter((item) => item.label || item.erwartung);
}

function expectedElementsToText(input: { label: string; erwartung: string }[]): string {
  return input.map((item) => `${item.label}: ${item.erwartung}`).join("; ");
}

function buildDescription(
  kriterium: string,
  erwartung: string,
  expectedElements: { label: string; erwartung: string }[],
): string {
  if (expectedElements.length > 0) {
    return `${kriterium}: ${expectedElements
      .map((item) => `${item.label}: ${item.erwartung}`)
      .join("; ")}`;
  }

  return erwartung || kriterium;
}

function cleanJsonText(text: string): string {
  return String(text ?? "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
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
