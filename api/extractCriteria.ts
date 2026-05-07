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
    .replace(/Konkrete Anforderungen:?/gi, "")
    .replace(/Erwartet:?/gi, "")
    .replace(/^Du hast\s+/i, "")
    .replace(/^Du schreibst\s+/i, "")
    .replace(/^Du belegst\s+/i, "")
    .replace(/^Du beachtest\s+/i, "")
    .replace(/^Du formulierst\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
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

function dedupeElements(input: ExpectedElement[]): ExpectedElement[] {
  const seen = new Set<string>();
  const output: ExpectedElement[] = [];

  for (const item of input) {
    const label = cleanOneLine(item.label);
    const erwartung = cleanOneLine(item.erwartung);

    if (!label && !erwartung) continue;

    const key = `${label}|${erwartung}`.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);

    output.push({
      label,
      erwartung,
    });
  }

  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeExpectedElementsFromDescription(
  description: string,
  expectedElements: ExpectedElement[],
): string {
  let result = cleanOneLine(description);

  for (const element of expectedElements) {
    const label = cleanOneLine(element.label);
    const erwartung = cleanOneLine(element.erwartung);

    if (label) {
      result = result.replace(
        new RegExp(escapeRegExp(label), "gi"),
        "",
      );
    }

    if (erwartung && erwartung.length > 12) {
      result = result.replace(
        new RegExp(escapeRegExp(erwartung), "gi"),
        "",
      );
    }
  }

  return cleanOneLine(result)
    .replace(/[:;,.]\s*$/g, "")
    .trim();
}

function normalizeCriteria(rawCriteria: any[]): Criterion[] {
  return rawCriteria
    .map((criterion, index) => {
      const rawExpectedElements = Array.isArray(
        criterion?.expectedElements,
      )
        ? criterion.expectedElements
        : [];

      const expectedElements = dedupeElements(
        rawExpectedElements.map((item: any) => ({
          label: cleanOneLine(item?.label ?? ""),
          erwartung: cleanOneLine(
            item?.erwartung ??
              item?.expected ??
              item?.text ??
              item?.beschreibung ??
              "",
          ),
        })),
      );

      const kriterium = cleanOneLine(
        criterion?.kriterium ??
          criterion?.criterion ??
          criterion?.title ??
          criterion?.name ??
          `Kriterium ${index + 1}`,
      );

      const rawDescription = cleanOneLine(
        criterion?.beschreibung ??
          criterion?.description ??
          "",
      );

      const beschreibung =
        removeExpectedElementsFromDescription(
          rawDescription,
          expectedElements,
        ) || kriterium;

      const erwartung =
        cleanOneLine(
          criterion?.erwartung ??
            criterion?.expected ??
            "",
        ) ||
        expectedElements
          .map((item) =>
            [item.label, item.erwartung]
              .filter(Boolean)
              .join(": "),
          )
          .join("; ");

      return {
        id: `crit-${index}`,
        bereich: cleanOneLine(
          criterion?.bereich ??
            criterion?.area ??
            criterion?.category ??
            "Allgemein",
        ),
        kriterium,
        beschreibung,
        erwartung: cleanOneLine(erwartung),
        expectedElements,
        gewichtung: cleanOneLine(
          criterion?.gewichtung ?? "mittel",
        ),
        aktiv: criterion?.aktiv !== false,
      };
    })
    .filter(
      (criterion) =>
        criterion.kriterium &&
        criterion.beschreibung,
    );
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
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(res, 500, {
        ok: false,
        error: "MISSING_OPENAI_API_KEY",
      });
    }

    const body = req.body ?? {};

    const expectationHorizonText = clean(
      body.expectationHorizonText ?? "",
    );

    const imageBase64 = clean(
      body.imageBase64 ?? "",
    );

    const imageMimeType = clean(
      body.imageMimeType ?? "image/png",
    );

    if (!expectationHorizonText && !imageBase64) {
      return sendJson(res, 400, {
        ok: false,
        error: "NO_INPUT",
      });
    }

    const prompt = `
Du extrahierst ein deutsches Bewertungsraster aus einem Erwartungshorizont.

Ziel:
Ein sauberes Raster für Lehrpersonen.

Wichtig:
- Nutze ausschließlich den gegebenen Inhalt.
- Keine Wiederholungen.
- Keine langen Fließtexte.
- Keine Formulierungen wie:
  "Konkrete Anforderungen"
  "Erwartet"
  "Du hast"
- Beschreibungen kurz halten.
- Konkrete Inhalte nur in expectedElements.
- expectedElements nur als kurze Stichpunkte.
- Maximal 16 Kriterien.
- JSON ONLY.

Beispiel:
{
  "criteria": [
    {
      "bereich": "Verstehensleistung",
      "kriterium": "Lyrische Form",
      "beschreibung": "Die formale Gestaltung wird beschrieben.",
      "erwartung": "Strophenanzahl und Reimschema werden korrekt benannt.",
      "expectedElements": [
        {
          "label": "Strophen",
          "erwartung": "drei Strophen"
        },
        {
          "label": "Reimschema",
          "erwartung": "Paarreim und Kreuzreim"
        }
      ],
      "gewichtung": "mittel",
      "aktiv": true
    }
  ]
}

TEXT:
${expectationHorizonText.slice(0, 12000)}
`.trim();

    const userMessage = imageBase64
      ? {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${imageMimeType};base64,${imageBase64}`,
              },
            },
          ],
        }
      : {
          role: "user",
          content: prompt,
        };

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "Du extrahierst Bewertungsraster quellentreu und antwortest ausschließlich mit validem JSON.",
            },
            userMessage,
          ],
        }),
      },
    );

    const raw = await response.text();

    if (!response.ok) {
      return sendJson(res, 500, {
        ok: false,
        error: "OPENAI_ERROR",
        status: response.status,
        raw,
      });
    }

    const completion = JSON.parse(raw);

    const content =
      completion?.choices?.[0]?.message?.content ?? "{}";

    const parsed = extractJsonObject(content);

    const criteria = normalizeCriteria(
      Array.isArray(parsed.criteria)
        ? parsed.criteria
        : [],
    );

    if (criteria.length === 0) {
      return sendJson(res, 500, {
        ok: false,
        error: "NO_CRITERIA_EXTRACTED",
        rawContent: content,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      summary: "Bewertungsraster erkannt",
      criteria,
      debug: {
        count: criteria.length,
        sourceTextLength:
          expectationHorizonText.length,
        imageMode: Boolean(imageBase64),
      },
      usage: completion?.usage ?? null,
    });
  } catch (error: any) {
    return sendJson(res, 500, {
      ok: false,
      error: "EXTRACT_CRITERIA_FAILED",
      message: error?.message ?? String(error),
    });
  }
}
