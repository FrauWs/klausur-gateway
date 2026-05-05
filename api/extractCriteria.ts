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
        error: "PDF_NOT_SUPPORTED",
        message:
          "PDF-Dateien können in dieser Gateway-Version nicht direkt ausgelesen werden. Bitte das Raster als PNG/JPG-Screenshot hochladen oder als Text/Excel/CSV verwenden.",
      });
    }

    if (imageBase64 && !imageMimeType.startsWith("image/")) {
      return sendJson(res, 400, {
        ok: false,
        error: "UNSUPPORTED_FILE_TYPE",
        message: "Für die Rastererkennung werden aktuell nur Bilder, Text, Excel oder CSV unterstützt.",
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
        const kriterium = clean(criterion.kriterium) || `Kriterium ${index + 1}`;
        const erwartung = clean(criterion.erwartung);
        const beschreibung = clean(criterion.beschreibung);

        return {
          id: `crit-${index}`,
          bereich,
          kriterium,
          beschreibung: buildConcreteDescription(beschreibung, erwartung, kriterium),
          erwartung,
          gewichtung: clean(criterion.gewichtung ?? ""),
          aktiv: criterion.aktiv !== false,
        };
      })
      .filter((criterion) => criterion.kriterium || criterion.beschreibung || criterion.erwartung);

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

function buildImageMessages(imageBase64: string, imageMimeType: string, fileName: string) {
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

Entscheidend:
Das Feld "erwartung" enthält immer den konkreten erwarteten Inhalt.
Das Feld "beschreibung" enthält ebenfalls den konkreten Inhalt, nicht nur eine abstrakte Prüfformulierung.

Verbotene Beschreibungen:
- "Die Textsorte wird korrekt genannt."
- "Der Titel wird korrekt genannt."
- "Der Autor wird korrekt genannt."
- "Das Entstehungsjahr wird korrekt genannt."
- "Die Einleitung ist vollständig."
- "Die lyrische Form wird beschrieben."
- "Die Strophe wird analysiert."
- "Der Text ist logisch aufgebaut."
- "Der Text ist verständlich."

Stattdessen:
- "Die Textsorte wird als Gedicht benannt."
- "Der Titel wird als Der Pflaumenbaum benannt."
- "Bertolt Brecht wird als Autor genannt."
- "1933 wird als Entstehungsjahr genannt."
- "Das Thema wird als Beschreibung eines kleinen Pflaumenbaums benannt."
- "Der Inhalt benennt, dass ein kleiner Pflaumenbaum in einem Hof steht und nicht weiterwachsen kann."
- "Strophe 1 beschreibt den Pflaumenbaum als unglaublich klein."
- "Strophe 1 nennt das Gitter um den Baum."
- "Strophe 1 deutet das Gitter auch als Schutz vor Tritten."
- "Strophe 2 erklärt, dass der Pflaumenbaum nicht weiterwachsen kann."
- "Strophe 2 nennt zu wenig Sonne im Hof als Grund."
- "Die verkürzten Wortformen 'wer'n' und 's ist' werden als sprachliche Auffälligkeiten benannt."

Wenn im Raster konkrete Begriffe, Namen, Jahreszahlen, Textstellen, Zitate oder Inhalte stehen, müssen diese in "erwartung" erhalten bleiben.

Gib ausschließlich gültiges JSON zurück.
`;

function buildPrompt(text: string): string {
  return `
Extrahiere aus dem folgenden Erwartungshorizont ein konkretes, kleinteiliges Bewertungsraster.

ZENTRALE REGEL:
Der konkrete Inhalt muss erhalten bleiben.
Nicht nur die Kategorie, sondern der erwartete Inhalt muss ausgegeben werden.

FALSCH:
{
  "kriterium": "Titel",
  "beschreibung": "Der Titel wird korrekt genannt.",
  "erwartung": ""
}

RICHTIG:
{
  "kriterium": "Titel",
  "beschreibung": "Der Titel wird als Der Pflaumenbaum benannt.",
  "erwartung": "Der Pflaumenbaum"
}

FALSCH:
{
  "kriterium": "Autor",
  "beschreibung": "Der Autor wird korrekt genannt.",
  "erwartung": ""
}

RICHTIG:
{
  "kriterium": "Autor",
  "beschreibung": "Bertolt Brecht wird als Autor genannt.",
  "erwartung": "Bertolt Brecht"
}

FALSCH:
{
  "kriterium": "Beschreibung Strophe 1",
  "beschreibung": "Die erste Strophe wird beschrieben.",
  "erwartung": ""
}

RICHTIG:
{
  "kriterium": "Strophe 1: Pflaumenbaum als unglaublich klein",
  "beschreibung": "Die erste Strophe beschreibt den Pflaumenbaum als unglaublich klein.",
  "erwartung": "Pflaumenbaum als unglaublich klein"
}

ATOMISIERUNG:
- Jede einzelne Angabe wird ein eigenes Kriterium.
- Jede konkrete Information wird erhalten.
- Jeder Spiegelstrich wird ein eigenes Kriterium.
- Aufzählungen nach Doppelpunkt werden aufgeteilt.
- Beispiele, Zitate, Versangaben und sprachliche Auffälligkeiten werden nicht ausgelassen.
- Strukturangaben wie Einleitung, Interpretationshypothese, Hauptteil, Fazit bleiben als eigene Kriterien erhalten, wenn sie im Raster vorkommen.
- Wenn ein Strukturpunkt einen konkreten Inhalt enthält, muss dieser Inhalt in "erwartung" stehen.

BEREICHE:
Übernimm vorhandene Bereiche wie:
- Verstehensleistung
- Darstellungsleistung
- Inhalt
- Sprache
- Aufbau

Wenn kein Bereich erkennbar ist, nutze "Allgemein".

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
- Maximal 80 Kriterien.
- "kriterium" ist kurz, aber konkret.
- "beschreibung" enthält den konkreten erwarteten Inhalt.
- "erwartung" enthält den konkreten Inhalt möglichst nah am Original.
- Wenn der konkrete Inhalt nicht gelesen werden kann, schreibe in "erwartung": "nicht eindeutig lesbar".
`;
}

function buildConcreteDescription(description: string, expectation: string, criterion: string): string {
  const d = clean(description);
  const e = clean(expectation);

  if (!d && e) return e;
  if (!e) return d || criterion;

  const lowerDescription = d.toLowerCase();
  const lowerExpectation = e.toLowerCase();

  if (lowerDescription.includes(lowerExpectation)) {
    return d;
  }

  if (isGenericDescription(d)) {
    return `${d} Erwartet: ${e}`;
  }

  return `${d} Erwartet: ${e}`;
}

function isGenericDescription(value: string): boolean {
  const text = value.toLowerCase();

  return (
    text.includes("korrekt genannt") ||
    text.includes("wird genannt") ||
    text.includes("wird benannt") ||
    text.includes("wird beschrieben") ||
    text.includes("wird erklärt") ||
    text.includes("wird erkannt") ||
    text.includes("wird berücksichtigt") ||
    text.includes("prüft, ob") ||
    text.includes("soll")
  );
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
