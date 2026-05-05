// api/extractCriteria.ts

import OpenAI from "openai";
import { z } from "zod";

export const config = {
  maxDuration: 60,
};

declare const process: {
  env: {
    OPENAI_API_KEY?: string;
  };
};

type ExtractCriteriaRequestBody = {
  expectationHorizonText?: string;
  imageBase64?: string;
  imageMimeType?: string;
  fileName?: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ExpectedElementSchema = z.object({
  label: z.string(),
  erwartung: z.string(),
});

const CriteriaSchema = z.object({
  summary: z.string().optional(),
  criteria: z.array(
    z.object({
      bereich: z.string(),
      kriterium: z.string(),
      beschreibung: z.string(),
      erwartung: z.string(),
      expectedElements: z.array(ExpectedElementSchema).optional(),
      gewichtung: z.string().optional(),
      aktiv: z.boolean().optional(),
    }),
  ),
});

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

function cleanJsonText(text: string): string {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
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
    const body = (req.body ?? {}) as ExtractCriteriaRequestBody;

    const expectationHorizonText = String(body.expectationHorizonText ?? "").trim();
    const fileBase64 = String(body.imageBase64 ?? "").trim();
    const fileMimeType = String(body.imageMimeType ?? "").trim() || "image/png";
    const fileName = String(body.fileName ?? "").trim() || "Erwartungshorizont";

    if (!expectationHorizonText && !fileBase64) {
      return sendJson(res, 400, {
        ok: false,
        error: "EMPTY_INPUT",
        message: "Es wurde weder Rastertext noch Dateiinhalt übergeben.",
      });
    }

    const isPdf = fileBase64 && fileMimeType === "application/pdf";
    const isImage = fileBase64 && fileMimeType.startsWith("image/");

    if (fileBase64 && !isPdf && !isImage) {
      return sendJson(res, 400, {
        ok: false,
        error: "UNSUPPORTED_FILE_TYPE",
        message: "Unterstützt werden aktuell Text, PDF, PNG und JPG.",
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(res, 500, {
        ok: false,
        error: "MISSING_API_KEY",
      });
    }

    const openai = new OpenAI({ apiKey });

    const response = await openai.responses.create({
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
          content: buildInputContent({
            expectationHorizonText,
            fileBase64,
            fileMimeType,
            fileName,
          }),
        },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
    });

    const raw = response.output_text;

    if (!raw || typeof raw !== "string") {
      return sendJson(res, 500, {
        ok: false,
        error: "EMPTY_MODEL_RESPONSE",
      });
    }

    let modelJson: unknown;

    try {
      modelJson = JSON.parse(cleanJsonText(raw));
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "MODEL_NOT_JSON",
        content: raw,
      });
    }

    const result = CriteriaSchema.safeParse(modelJson);

    if (!result.success) {
      return sendJson(res, 500, {
        ok: false,
        error: "INVALID_SCHEMA",
        issues: result.error.issues,
        modelJson,
      });
    }

    const criteria = result.data.criteria
      .map((criterion, index) => {
        const bereich = clean(criterion.bereich) || "Allgemein";
        const kriterium = clean(criterion.kriterium) || `Kriterium ${index + 1}`;
        const expectedElements = normalizeExpectedElements(
          criterion.expectedElements ?? [],
        );
        const erwartung =
          clean(criterion.erwartung) || expectedElementsToText(expectedElements);
        const beschreibung = clean(criterion.beschreibung);

        return {
          id: `crit-${index}`,
          bereich,
          kriterium,
          beschreibung: buildDescription(
            beschreibung,
            erwartung,
            expectedElements,
            kriterium,
          ),
          erwartung,
          expectedElements,
          gewichtung: clean(criterion.gewichtung ?? ""),
          aktiv: criterion.aktiv !== false,
        };
      })
      .filter(
        (criterion) =>
          criterion.kriterium || criterion.beschreibung || criterion.erwartung,
      );

    if (criteria.length === 0) {
      return sendJson(res, 500, {
        ok: false,
        error: "NO_CRITERIA_EXTRACTED",
        message: "Es konnten keine Kriterien erkannt werden.",
        modelJson,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      summary: clean(result.data.summary ?? ""),
      criteria,
      debug: {
        count: criteria.length,
        inputType: fileBase64 ? fileMimeType : "text",
        fileName,
      },
      usage: response.usage ?? null,
    });
  } catch (error: any) {
    return sendJson(res, 500, {
      ok: false,
      error: "SERVER_ERROR",
      message: error?.message ?? "Unbekannter Fehler.",
    });
  }
}

function buildInputContent(params: {
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
          `Das Bewertungsraster liegt als Datei vor. Dateiname: ${fileName}. Lies den Inhalt vollständig aus und extrahiere daraus bewertbare Leistungseinheiten mit konkreten Untererwartungen.`,
      ),
    },
  ];

  if (fileBase64 && fileMimeType === "application/pdf") {
    content.push({
      type: "input_file",
      filename: fileName.endsWith(".pdf") ? fileName : `${fileName}.pdf`,
      file_data: `data:application/pdf;base64,${fileBase64}`,
    });
  }

  if (fileBase64 && fileMimeType.startsWith("image/")) {
    content.push({
      type: "input_image",
      image_url: `data:${fileMimeType};base64,${fileBase64}`,
    });
  }

  return content;
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
`;

function buildPrompt(text: string): string {
  return `
Extrahiere aus dem folgenden Erwartungshorizont ein Bewertungsraster.

ZENTRALE ENTSCHEIDUNG:
Nicht jeder Spiegelstrich ist automatisch ein eigenes Kriterium.
Ein Kriterium ist eine bewertbare Leistungseinheit.
Konkrete Unterpunkte werden als expectedElements innerhalb dieses Kriteriums gespeichert.

Zusätzlich:
Erstelle eine kurze summary in 2 bis 4 Sätzen. Diese summary soll knapp beschreiben, worum es im Erwartungshorizont geht und welche Leistungsschwerpunkte er setzt.

TEXT ODER DATEIINHALT:
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

AUSGABEREGELN:
- Kein Markdown.
- Kein Text außerhalb des JSON.
- Maximal 30 Kriterien.
- Lieber wenige intelligente Kriterien mit expectedElements als viele atomisierte Einzelpunkte.
- Keine konkreten Inhalte auslassen.
`;
}

function buildDescription(
  description: string,
  expectation: string,
  expectedElements: { label: string; erwartung: string }[],
  criterion: string,
): string {
  const d = clean(description);
  const e = clean(expectation);

  if (d) return d;

  if (expectedElements.length > 0) {
    return `${criterion}: ${expectedElements
      .map((item) => `${item.label}: ${item.erwartung}`)
      .join("; ")}`;
  }

  return e || criterion;
}

function normalizeExpectedElements(
  input: { label: string; erwartung: string }[],
): { label: string; erwartung: string }[] {
  return input
    .map((item) => ({
      label: clean(item.label),
      erwartung: clean(item.erwartung),
    }))
    .filter((item) => item.label || item.erwartung);
}

function expectedElementsToText(input: { label: string; erwartung: string }[]) {
  return input.map((item) => `${item.label}: ${item.erwartung}`).join("; ");
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
