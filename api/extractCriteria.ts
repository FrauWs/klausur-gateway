// api/extractCriteria.ts

import { z } from "zod";

export const config = {
  maxDuration: 30,
};

const BodySchema = z.object({
  expectationHorizonText: z.string().optional(),
  imageBase64: z.string().optional(),
  imageMimeType: z.string().optional(),
  fileName: z.string().optional(),
  instructions: z.string().optional(),
});

function setCors(req: any, res: any) {
  const origin = req.headers.origin || "*";

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(req: any, res: any, status: number, payload: unknown) {
  setCors(req, res);
  res.setHeader("Content-Type", "application/json");
  return res.status(status).json(payload);
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanString(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeExpectedElements(input: unknown): { label: string; erwartung: string }[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((item: any) => {
      if (typeof item === "string") {
        return {
          label: "",
          erwartung: cleanString(item),
        };
      }

      return {
        label: cleanString(item?.label ?? item?.name ?? item?.title ?? ""),
        erwartung: cleanString(
          item?.erwartung ??
            item?.expected ??
            item?.text ??
            item?.description ??
            item?.beschreibung ??
            "",
        ),
      };
    })
    .filter((item) => item.label || item.erwartung)
    .slice(0, 8);
}

function expectedElementsToText(
  items: { label: string; erwartung: string }[],
): string {
  return items
    .map((item) => [item.label, item.erwartung].filter(Boolean).join(": "))
    .filter(Boolean)
    .join("; ");
}

function normalizeCriteria(input: unknown): any[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((criterion: any, index: number) => {
      const expectedElements = normalizeExpectedElements(criterion?.expectedElements);
      const expectedText = expectedElementsToText(expectedElements);

      const bereich =
        cleanString(criterion?.bereich) ||
        cleanString(criterion?.area) ||
        cleanString(criterion?.category) ||
        "Allgemein";

      const kriterium =
        cleanString(criterion?.kriterium) ||
        cleanString(criterion?.criterion) ||
        cleanString(criterion?.title) ||
        cleanString(criterion?.name) ||
        `Kriterium ${index + 1}`;

      const erwartung =
        cleanString(criterion?.erwartung) ||
        cleanString(criterion?.expected) ||
        expectedText;

      const beschreibung =
        cleanString(criterion?.beschreibung) ||
        cleanString(criterion?.description) ||
        erwartung ||
        kriterium;

      return {
        id: cleanString(criterion?.id) || `crit-${index}`,
        bereich,
        kriterium,
        beschreibung,
        erwartung,
        expectedElements,
        gewichtung: cleanString(criterion?.gewichtung ?? criterion?.weighting ?? ""),
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
  const startedAt = Date.now();

  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return sendJson(req, res, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const parsed = BodySchema.parse(req.body ?? {});

    const expectationHorizonText = cleanText(parsed.expectationHorizonText ?? "");
    const shortenedText = expectationHorizonText.slice(0, 6000);

    console.log("EXTRACT_CRITERIA_INPUT", {
      originalLength: expectationHorizonText.length,
      shortenedLength: shortenedText.length,
      preview: shortenedText.slice(0, 1000),
    });

    if (!shortenedText) {
      return sendJson(req, res, 400, {
        ok: false,
        error: "NO_TEXT",
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(req, res, 500, {
        ok: false,
        error: "MISSING_OPENAI_KEY",
      });
    }

    const prompt = `
Extrahiere aus diesem Bewertungsraster kompakte Bewertungskriterien.

REGELN:
- Nutze ausschließlich den Rastertext.
- Keine Kriterien erfinden.
- Keine Inhalte weglassen.
- Keine allgemeinen Ersatzraster erzeugen.
- Bereiche aus Überschriften übernehmen.
- Einzelne Strophen, Teilaufgaben oder getrennte Analysebereiche getrennt erfassen.
- Konkrete Unterpunkte als expectedElements erhalten.
- expectedElements als Objekte mit label und erwartung ausgeben.
- Maximal 18 Kriterien.
- Pro Kriterium maximal 8 expectedElements.
- Kurz, aber textnah formulieren.
- JSON ONLY.

FORMAT:
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

RASTERTEXT:
${shortenedText}
`.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        response_format: {
          type: "json_object",
        },
        messages: [
          {
            role: "system",
            content:
              "Du extrahierst Bewertungsraster quellentreu als kompaktes JSON. Du erfindest nichts und ersetzt konkrete Inhalte nicht durch allgemeine Formulierungen.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: 3000,
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      return sendJson(req, res, 500, {
        ok: false,
        error: "OPENAI_ERROR",
        status: response.status,
        raw,
        debug: {
          originalLength: expectationHorizonText.length,
          shortenedLength: shortenedText.length,
          durationMs: Date.now() - startedAt,
        },
      });
    }

    let openAiJson: any;

    try {
      openAiJson = JSON.parse(raw);
    } catch {
      return sendJson(req, res, 500, {
        ok: false,
        error: "OPENAI_RESPONSE_NOT_JSON",
        raw,
        debug: {
          durationMs: Date.now() - startedAt,
        },
      });
    }

    const rawContent = openAiJson?.choices?.[0]?.message?.content ?? "{}";

    let parsedContent: any = {};

    try {
      parsedContent = JSON.parse(rawContent);
    } catch (error) {
      console.error("OPENAI_PARSE_ERROR", error);

      return sendJson(req, res, 500, {
        ok: false,
        error: "OPENAI_JSON_PARSE_FAILED",
        rawContent,
        debug: {
          durationMs: Date.now() - startedAt,
        },
      });
    }

    const criteria = normalizeCriteria(parsedContent.criteria);

    if (criteria.length === 0) {
      return sendJson(req, res, 500, {
        ok: false,
        error: "NO_CRITERIA_EXTRACTED",
        rawContent,
        parsedContent,
        debug: {
          originalLength: expectationHorizonText.length,
          shortenedLength: shortenedText.length,
          durationMs: Date.now() - startedAt,
        },
      });
    }

    return sendJson(req, res, 200, {
      ok: true,
      summary: cleanString(parsedContent.summary) || "Bewertungsraster erkannt",
      criteria,
      debug: {
        originalLength: expectationHorizonText.length,
        shortenedLength: shortenedText.length,
        count: criteria.length,
        durationMs: Date.now() - startedAt,
      },
      usage: openAiJson?.usage ?? null,
    });
  } catch (error: any) {
    console.error("EXTRACT_CRITERIA_ERROR", error);

    return sendJson(req, res, 500, {
      ok: false,
      error: "EXTRACT_CRITERIA_FAILED",
      message: error?.message ?? String(error),
      debug: {
        durationMs: Date.now() - startedAt,
      },
    });
  }
}
