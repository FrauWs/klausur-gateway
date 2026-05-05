// api/extractCriteria.ts

import { z } from "zod";
import crypto from "crypto";

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

const ExpectedElementSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  erwartung: z.string(),
  erfüllt: z.boolean().optional(),
  kommentar: z.string().optional(),
});

const CriterionSchema = z.object({
  bereich: z.string(),
  kriterium: z.string(),
  beschreibung: z.string(),
  erwartung: z.string(),
  expectedElements: z.array(ExpectedElementSchema).optional(),
  gewichtung: z.string().optional(),
  aktiv: z.boolean().optional(),
});

const CriteriaSchema = z.object({
  criteria: z.array(CriterionSchema),
});

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

function createId() {
  return crypto.randomUUID();
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

    const expectationHorizonText = String(
      body.expectationHorizonText ?? "",
    ).trim();
    const imageBase64 = String(body.imageBase64 ?? "").trim();
    const imageMimeType = String(body.imageMimeType ?? "").trim();
    const fileName = String(body.fileName ?? "").trim();

    if (!expectationHorizonText && !imageBase64) {
      return sendJson(res, 400, {
        ok: false,
        error: "EMPTY_INPUT",
        message: "Es wurde weder Rastertext noch Bildinhalt übergeben.",
      });
    }

    if (imageBase64 && imageMimeType === "application/pdf") {
      return sendJson(res, 400, {
        ok: false,
        error: "PDF_NOT_SUPPORTED",
        message:
          "PDF-Dateien können in dieser Gateway-Version nicht direkt ausgelesen werden. Bitte das Raster als PNG/JPG-Screenshot hochladen oder als Text/Excel/CSV verwenden.",
      });
    }

    if (imageBase64 && !imageMimeType.startsWith("image/")) {
      return sendJson(res, 400, {
        ok: false,
        error: "UNSUPPORTED_FILE_TYPE",
        message:
          "Für die Rastererkennung werden aktuell nur Bilder, Text, Excel oder CSV unterstützt.",
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(res, 500, {
        ok: false,
        error: "MISSING_API_KEY",
      });
    }

    const messages = imageBase64
      ? buildImageMessages(imageBase64, imageMimeType, fileName)
      : buildTextMessages(expectationHorizonText);

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
        messages,
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

    let modelJson: unknown;

    try {
      modelJson = JSON.parse(content);
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "MODEL_NOT_JSON",
        content,
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
        const kriterium =
          clean(criterion.kriterium) || `Kriterium ${index + 1}`;
        const erwartung = clean(criterion.erwartung);
        const beschreibung = clean(criterion.beschreibung);

        const expectedElements =
          criterion.expectedElements && criterion.expectedElements.length > 0
            ? criterion.expectedElements.map((element, elementIndex) => ({
                id: createId(),
                label:
                  clean(element.label) ||
                  `Teilerwartung ${elementIndex + 1}`,
                erwartung: clean(element.erwartung),
                erfüllt: element.erfüllt ?? false,
                kommentar: clean(element.kommentar ?? ""),
              }))
            : [
                {
                  id: createId(),
                  label: kriterium,
                  erwartung: erwartung || beschreibung || kriterium,
                  erfüllt: false,
                  kommentar: "",
                },
              ];

        return {
          id: createId(),
          bereich,
          kriterium,
          beschreibung: buildConcreteDescription(
            beschreibung,
            erwartung,
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
          criterion.kriterium ||
          criterion.beschreibung ||
          criterion.erwartung ||
          criterion.expectedElements.length > 0,
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
      criteria,
      debug: {
        count: criteria.length,
        inputType: imageBase64 ? imageMimeType : "text",
        fileName,
      },
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

function buildTextMessages(expectationHorizonText: string) {
  return [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: buildPrompt(expectationHorizonText),
    },
  ];
}

function buildImageMessages(
  imageBase64: string,
  imageMimeType: string,
  fileName: string,
) {
  return [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: buildPrompt(
            `Das Bewertungsraster liegt als Bild vor. Dateiname: ${
              fileName || "unbekannt"
            }. Lies den sichtbaren Text vollständig aus. Extrahiere ausschließlich die dort sichtbaren konkreten Erwartungen.`,
          ),
        },
        {
          type: "image_url",
          image_url: {
            url: `data:${imageMimeType};base64,${imageBase64}`,
          },
        },
      ],
    },
  ];
}

const SYSTEM_PROMPT = `
Du extrahierst Bewertungsraster aus Erwartungshorizonten.

Du darfst keine allgemeinen Kriterien erfinden.
Du darfst keine pädagogischen Standardformulierungen erzeugen.
Du darfst nicht zusammenfassen.
Du darfst nicht bündeln.
Du darfst keine konkreten Inhalte weglassen.

Wichtig:
Jedes Kriterium braucht zusätzlich "expectedElements".
"expectedElements" enthält kleinteilige Teilerwartungen.
Jede Teilerwartung muss später einzeln für Randkommentare nutzbar sein.

Gib ausschließlich gültiges JSON zurück.
`;

function buildPrompt(text: string): string {
  return `
Extrahiere aus dem folgenden Erwartungshorizont ein konkretes, kleinteiliges Bewertungsraster.

ATOMISIERUNG:
- Jede einzelne Angabe wird ein eigenes Kriterium oder eine eigene Teilerwartung.
- Jeder Spiegelstrich wird erhalten.
- Aufzählungen nach Doppelpunkt werden aufgeteilt.
- Beispiele, Zitate, Versangaben und sprachliche Auffälligkeiten werden nicht ausgelassen.
- Strukturangaben wie Einleitung, Interpretationshypothese, Hauptteil, Fazit bleiben erhalten.

TEXT ODER BILDINHALT:
${text}

Gib ausschließlich JSON in exakt dieser Struktur zurück:

{
  "criteria": [
    {
      "bereich": "string",
      "kriterium": "string",
      "beschreibung": "string",
      "erwartung": "string",
      "expectedElements": [
        {
          "label": "string",
          "erwartung": "string",
          "erfüllt": false,
          "kommentar": ""
        }
      ],
      "gewichtung": "string",
      "aktiv": true
    }
  ]
}

REGELN:
- Kein Markdown.
- Kein Text außerhalb des JSON.
- Maximal 80 Kriterien.
- "kriterium" ist kurz, aber konkret.
- "beschreibung" enthält den konkreten erwarteten Inhalt.
- "erwartung" enthält den konkreten Inhalt möglichst nah am Original.
- "expectedElements" darf niemals leer sein.
- Jede Teilerwartung in "expectedElements" muss kommentierbar sein.
`;
}

function buildConcreteDescription(
  description: string,
  expectation: string,
  criterion: string,
): string {
  const d = clean(description);
  const e = clean(expectation);

  if (!d && e) return e;
  if (!e) return d || criterion;

  const lowerDescription = d.toLowerCase();
  const lowerExpectation = e.toLowerCase();

  if (lowerDescription.includes(lowerExpectation)) {
    return d;
  }

  return `${d} Erwartet: ${e}`.trim();
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
