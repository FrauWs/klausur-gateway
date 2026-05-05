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
      erwartung: z.string(),
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
        erwartung: clean(criterion.erwartung || criterion.beschreibung),
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
        "Du extrahierst Bewertungsraster extrem genau und atomar. Du fasst nicht zusammen. Du bündelst keine Unterpunkte. Jeder Teilaspekt wird ein eigenes Kriterium. Du gibst ausschließlich gültiges JSON zurück.",
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
        "Du liest Bewertungsraster aus Bildern extrem genau aus. Du extrahierst atomar. Du fasst nicht zusammen. Du bündelst keine Unterpunkte. Jeder Teilaspekt wird ein eigenes Kriterium. Du gibst ausschließlich gültiges JSON zurück.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: buildPrompt(
            `Das Bewertungsraster liegt als Bilddatei vor. Dateiname: ${fileName || "unbekannt"}. Lies das Bild vollständig aus und extrahiere daraus ein atomar gegliedertes Bewertungsraster.`,
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
Extrahiere aus dem folgenden Erwartungshorizont ein vollständiges, kleinteiliges Bewertungsraster.

ZENTRALE REGEL:
Du darfst NICHT zusammenfassen.
Du darfst NICHT bündeln.
Du darfst NICHT aus mehreren Anforderungen ein einziges Kriterium machen.

ATOMISIERUNG:
- Jeder Spiegelstrich wird ein eigenes Kriterium.
- Jede einzelne geforderte Angabe wird ein eigenes Kriterium.
- Jede Strophe, jeder Analyseaspekt, jede sprachliche Beobachtung wird ein eigenes Kriterium.
- Beispiele mit "etwa", "z. B.", Doppelpunkten oder Aufzählungen werden in einzelne Kriterien aufgeteilt.
- Wenn ein Satz mehrere Anforderungen enthält, wird er in mehrere Kriterien zerlegt.
- Aus "vollständige Einleitung mit Textsorte, Titel, Autor, Entstehungsjahr, Thema, Inhalt" werden mindestens sechs Kriterien.
- Aus "lyrische Form: Strophen, Verse, Reimschema" werden mindestens drei Kriterien.
- Aus "Beschreibung und Deutung der Einzelstrophen" werden einzelne Kriterien pro Strophe und Teilaspekt.
- Aus "sprachliche Besonderheiten" werden eigene Kriterien, wenn Beispiele genannt sind.

BEREICHE:
- Übernimm vorhandene Bereiche wie "Verstehensleistung", "Darstellungsleistung", "Inhalt", "Sprache", "Aufbau".
- Wenn kein Bereich erkennbar ist, nutze "Allgemein".

FORMULIERUNG:
- "kriterium" ist kurz und konkret.
- "beschreibung" beschreibt prüfbar, was im Schülertext vorhanden sein muss.
- "erwartung" enthält den erwarteten Inhalt möglichst nah am Original.
- Verwende keine generischen Formulierungen wie "Prüft, ob ...", wenn der Originalinhalt genauer ist.
- Keine Bewertung.
- Keine Note.
- Keine Punkte.

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

QUALITÄTSKONTROLLE VOR DER AUSGABE:
- Prüfe, ob du Unterpunkte versehentlich gebündelt hast.
- Wenn ja, teile sie vor der Ausgabe weiter auf.
- Bei Aufzählungen müssen mehrere Kriterien entstehen.
- Lieber mehr kleinteilige Kriterien als wenige grobe Kriterien.

AUSGABEREGELN:
- Kein Markdown.
- Kein Text außerhalb des JSON.
- Maximal 60 Kriterien.
`;
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
