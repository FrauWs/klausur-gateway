// api/extractCriteria.ts

declare const process: {
  env: {
    OPENAI_API_KEY?: string;
  };
};

export const config = {
  runtime: "nodejs",
  maxDuration: 30,
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

type ExpectedElement = {
  label: string;
  erwartung: string;
};

type Criterion = {
  id: string;
  bereich: string;
  kriterium: string;
  beschreibung: string;
  erwartung: string;
  expectedElements: ExpectedElement[];
  gewichtung: string;
  aktiv: boolean;
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

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanOneLine(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function extractJsonObject(raw: string): any {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("NO_JSON_FOUND");
  }

  return JSON.parse(raw.slice(start, end + 1));
}

function normalizeCriteria(rawCriteria: any[]): Criterion[] {
  return rawCriteria
    .map((criterion, index) => {
      const rawExpectedElements = Array.isArray(criterion?.expectedElements)
        ? criterion.expectedElements
        : [];

      const expectedElements: ExpectedElement[] = rawExpectedElements
        .map((item: any) => ({
          label: cleanOneLine(item?.label ?? ""),
          erwartung: cleanOneLine(
            item?.erwartung ??
              item?.expected ??
              item?.text ??
              item?.beschreibung ??
              "",
          ),
        }))
        .filter((item) => item.label || item.erwartung);

      return {
        id: cleanOneLine(criterion?.id) || `crit-${index}`,
        bereich:
          cleanOneLine(
            criterion?.bereich ??
              criterion?.area ??
              criterion?.category ??
              "",
          ) || "Allgemein",
        kriterium:
          cleanOneLine(
            criterion?.kriterium ??
              criterion?.criterion ??
              criterion?.title ??
              criterion?.name ??
              "",
          ) || `Kriterium ${index + 1}`,
        beschreibung: cleanOneLine(
          criterion?.beschreibung ?? criterion?.description ?? "",
        ),
        erwartung: cleanOneLine(
          criterion?.erwartung ?? criterion?.expected ?? "",
        ),
        expectedElements,
        gewichtung: cleanOneLine(criterion?.gewichtung ?? criterion?.weighting ?? ""),
        aktiv: criterion?.aktiv !== false,
      };
    })
    .filter((criterion) => criterion.kriterium && criterion.beschreibung);
}

export default async function handler(req: any, res: any) {
  const startedAt = Date.now();
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
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(res, 500, {
        ok: false,
        error: "MISSING_OPENAI_API_KEY",
      });
    }

    const body = req.body ?? {};

    const expectationHorizonText = clean(body.expectationHorizonText ?? "");
    const imageBase64 = clean(body.imageBase64 ?? "");
    const imageMimeType = clean(body.imageMimeType ?? "image/png");
    const fileName = clean(body.fileName ?? "Erwartungshorizont");

    if (!expectationHorizonText && !imageBase64) {
      return sendJson(res, 400, {
        ok: false,
        error: "NO_INPUT",
      });
    }

    const sourceText =
      expectationHorizonText.length > 18000
        ? expectationHorizonText.slice(0, 18000)
        : expectationHorizonText;

    const prompt = `
Du extrahierst ein Bewertungsraster aus einem Erwartungshorizont.

Arbeite allgemein und quellentreu.
Der Erwartungshorizont kann sehr gut, schlecht strukturiert, lang, kurz, tabellarisch, stichpunktartig, unsauber oder unvollständig sein.

Aufgabe:
Erzeuge daraus ein verwendbares Bewertungsraster für eine Lehrperson.

Regeln:
- Nutze ausschließlich Inhalte aus dem gelieferten Erwartungshorizont.
- Erfinde keine fachlichen Inhalte.
- Übernimm keine personenbezogenen Daten.
- Fasse Redundanzen zusammen.
- Erhalte fachlich konkrete Anforderungen.
- Trenne erkennbare Bereiche, Kriterien und Unteranforderungen.
- Wenn der Erwartungshorizont klare Teilbereiche enthält, übernimm diese als "bereich".
- Wenn keine klaren Bereiche vorhanden sind, bilde sinnvolle allgemeine Bereiche.
- Beschreibung: kurz, verständlich, funktional.
- erwartung: knappe Zusammenfassung der erwarteten Leistung.
- expectedElements: konkrete Einzelanforderungen.
- Keine langen Fließtextblöcke.
- Keine doppelten Kriterien.
- Keine doppelten expectedElements.
- Gib ausschließlich valides JSON zurück.

JSON-Schema:
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

Erwartungshorizont:
${sourceText}
`.trim();

    const content: any[] = [
      {
        type: "text",
        text: prompt,
      },
    ];

    if (imageBase64) {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${imageMimeType};base64,${imageBase64}`,
        },
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 26000);

    let response: Response;

    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          temperature: 0,
          max_tokens: 3500,
          messages: [
            {
              role: "system",
              content:
                "Du extrahierst Bewertungsraster zuverlässig, allgemein, quellentreu und gibst ausschließlich valides JSON zurück.",
            },
            {
              role: "user",
              content: imageBase64 ? content : prompt,
            },
          ],
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();

    if (!response.ok) {
      return sendJson(res, 500, {
        ok: false,
        error: "OPENAI_ERROR",
        status: response.status,
        raw,
        debug: {
          durationMs: Date.now() - startedAt,
          textLength: expectationHorizonText.length,
          usedTextLength: sourceText.length,
          imageMode: Boolean(imageBase64),
          fileName,
        },
      });
    }

    const completion = JSON.parse(raw);
    const contentText = completion?.choices?.[0]?.message?.content ?? "{}";
    const parsed = extractJsonObject(contentText);

    const criteria = normalizeCriteria(
      Array.isArray(parsed.criteria) ? parsed.criteria : [],
    );

    if (criteria.length === 0) {
      return sendJson(res, 500, {
        ok: false,
        error: "NO_CRITERIA_EXTRACTED",
        rawContent: contentText,
        debug: {
          durationMs: Date.now() - startedAt,
          textLength: expectationHorizonText.length,
          usedTextLength: sourceText.length,
          imageMode: Boolean(imageBase64),
          fileName,
        },
      });
    }

    return sendJson(res, 200, {
      ok: true,
      summary: cleanOneLine(parsed.summary) || "Bewertungsraster erkannt",
      criteria,
      debug: {
        durationMs: Date.now() - startedAt,
        count: criteria.length,
        textLength: expectationHorizonText.length,
        usedTextLength: sourceText.length,
        imageMode: Boolean(imageBase64),
        fileName,
      },
      usage: completion?.usage ?? null,
    });
  } catch (error: any) {
    const isAbort = error?.name === "AbortError";

    return sendJson(res, 500, {
      ok: false,
      error: isAbort ? "OPENAI_TIMEOUT" : "EXTRACT_CRITERIA_FAILED",
      message: isAbort
        ? "Die Rasterextraktion hat zu lange gedauert."
        : error?.message ?? String(error),
      debug: {
        durationMs: Date.now() - startedAt,
      },
    });
  }
}
