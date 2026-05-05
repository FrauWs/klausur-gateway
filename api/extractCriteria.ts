// api/extractCriteria.ts

import { z } from "zod";

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

const CriteriaSchema = z.object({
  criteria: z.array(
    z.object({
      bereich: z.string(),
      kriterium: z.string(),
      beschreibung: z.string(),
      erwartung: z.string().optional(),
      gewichtung: z.string().optional(),
      aktiv: z.boolean().optional(),
    }),
  ),
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
        error: "PDF_NOT_SUPPORTED_IN_GATEWAY_YET",
        message:
          "PDF-Raster können aktuell nicht direkt im Gateway ausgelesen werden. Bitte als Bild, Excel, CSV oder Text hochladen.",
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(res, 500, {
        ok: false,
        error: "MISSING_API_KEY",
      });
    }

    const messages =
      imageBase64 && imageMimeType.startsWith("image/")
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
      .map((criterion, index) => ({
        id: `crit-${index}`,
        bereich: clean(criterion.bereich) || "Allgemein",
        kriterium: clean(criterion.kriterium) || `Kriterium ${index + 1}`,
        beschreibung: clean(criterion.beschreibung) || clean(criterion.kriterium),
        erwartung: clean(criterion.erwartung ?? criterion.beschreibung),
        gewichtung: clean(criterion.gewichtung ?? ""),
        aktiv: criterion.aktiv !== false,
      }))
      .filter((criterion) => criterion.kriterium || criterion.beschreibung);

    if (criteria.length === 0) {
      return sendJson(res, 500, {
        ok: false,
        error: "NO_CRITERIA_EXTRACTED",
        message: "Es konnten keine Kriterien erkannt werden.",
      });
    }

    return sendJson(res, 200, {
      ok: true,
      criteria,
      debug: {
        count: criteria.length,
        inputType: imageBase64 ? imageMimeType || "image" : "text",
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
      content:
        "Du extrahierst Bewertungsraster aus Erwartungshorizonten. Du fasst nicht zusammen, bündelst keine Kriterien und gibst ausschließlich gültiges JSON zurück.",
    },
    {
      role: "user",
      content: buildPrompt(expectationHorizonText),
    },
  ];
}

function buildImageMessages(imageBase64: string, imageMimeType: string, fileName: string) {
  return [
    {
      role: "system",
      content:
        "Du extrahierst Bewertungsraster aus Bildern von Erwartungshorizonten. Du fasst nicht zusammen, bündelst keine Kriterien und gibst ausschließlich gültiges JSON zurück.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: buildPrompt(
            `Das Bewertungsraster liegt als Bilddatei vor. Dateiname: ${fileName || "unbekannt"}. Lies das Bild vollständig aus und extrahiere die Kriterien.`,
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

function buildPrompt(text: string): string {
  return `
Extrahiere ein vollständiges Bewertungsraster.

WICHTIG:
- Jeder einzelne Spiegelstrich oder klar erkennbare Erwartungsaspekt wird als eigenes Kriterium übernommen.
- Keine Zusammenfassung.
- Keine Bündelung mehrerer Kriterien.
- Keine neuen Kriterien erfinden.
- Originalbegriffe möglichst erhalten.
- Wenn Bereiche wie "Verstehensleistung", "Darstellungsleistung", "Inhalt", "Sprache", "Aufbau" erkennbar sind, ordne die Kriterien diesen Bereichen zu.
- Falls kein Bereich erkennbar ist, nutze "Allgemein".
- Gewichtungen nur übernehmen, wenn sie ausdrücklich genannt werden.
- Keine Noten.
- Keine Punkte vergeben.

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
      "gewichtung": "string",
      "aktiv": true
    }
  ]
}

AUSGABEREGELN:
- Kein Markdown.
- Kein Text außerhalb des JSON.
- Maximal 40 Kriterien.
- "kriterium" ist kurz und präzise.
- "beschreibung" beschreibt, was geprüft werden soll.
- "erwartung" enthält möglichst nah am Originaltext die erwartete Leistung.
`;
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
