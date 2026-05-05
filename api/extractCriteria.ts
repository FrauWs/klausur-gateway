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
      .map((criterion, index) => ({
        id: `crit-${index}`,
        bereich: clean(criterion.bereich) || "Allgemein",
        kriterium: clean(criterion.kriterium) || `Kriterium ${index + 1}`,
        beschreibung: clean(criterion.beschreibung) || clean(criterion.erwartung) || clean(criterion.kriterium),
        erwartung: clean(criterion.erwartung ?? criterion.beschreibung ?? criterion.kriterium),
        gewichtung: clean(criterion.gewichtung ?? ""),
        aktiv: criterion.aktiv !== false,
      }))
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
            }. Lies den sichtbaren Text im Bild vollständig aus und extrahiere daraus die Kriterien. Erfinde keine Inhalte, die nicht sichtbar sind.`,
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

Du darfst nicht allgemein pädagogisch formulieren.
Du darfst keine Standardkriterien erfinden.
Du darfst keine Kriterien ergänzen, die nicht im Text oder Bild stehen.
Du darfst nicht zusammenfassen.
Du darfst nicht bündeln.

Du übernimmst konkrete Inhalte aus dem Erwartungshorizont.

Falsch:
- "Thema erkennen"
- "Wesentliche Informationen wiedergeben"
- "Leserlichkeit"
- "Sprachliche Richtigkeit"
- "Der Text ist logisch aufgebaut"
- "Prüft, ob ..."

Richtig:
- "Textsorte"
- "Gedicht"
- "Titel: Der Pflaumenbaum"
- "Autor: Bertolt Brecht"
- "Entstehungsjahr: 1933"
- "Strophe 1: Pflaumenbaum als unglaublich klein beschrieben"
- "Strophe 1: Gitter schützt vor Tritten"
- "Strophe 2: zu wenig Sonne im Hof"
- "verkürzte Wortformen: 'wer'n', 's ist'"
- "Wiederholung: 'größer wer'n'"
- "Wiederholung: 'Pflaumenbaum'"

Gib ausschließlich gültiges JSON zurück.
`;

function buildPrompt(text: string): string {
  return `
Extrahiere aus dem folgenden Erwartungshorizont ein konkretes, kleinteiliges Bewertungsraster.

ZENTRALE REGEL:
Der konkrete Inhalt des Erwartungshorizonts muss übernommen werden.
Keine allgemeinen Ersatzkriterien.
Keine pädagogischen Standardformulierungen.
Keine Vereinfachung.

ATOMISIERUNG:
- Jede einzelne Angabe wird ein eigenes Kriterium.
- Jeder Spiegelstrich wird ein eigenes Kriterium.
- Jede genannte Textstelle, jedes Beispiel und jede sprachliche Besonderheit wird ein eigenes Kriterium.
- Aufzählungen nach Doppelpunkt werden aufgeteilt.
- Mehrteilige Sätze werden in einzelne prüfbare Kriterien zerlegt.

BEISPIEL:
Aus:
"Einleitung enthält: Textsorte Gedicht, Titel Der Pflaumenbaum, Autor Bertolt Brecht, Entstehungsjahr 1933"

wird:
{
  "bereich": "Verstehensleistung",
  "kriterium": "Textsorte",
  "beschreibung": "Die Textsorte wird als Gedicht benannt.",
  "erwartung": "Gedicht"
}
{
  "bereich": "Verstehensleistung",
  "kriterium": "Titel",
  "beschreibung": "Der Titel wird korrekt genannt.",
  "erwartung": "Der Pflaumenbaum"
}
{
  "bereich": "Verstehensleistung",
  "kriterium": "Autor",
  "beschreibung": "Der Autor wird korrekt genannt.",
  "erwartung": "Bertolt Brecht"
}

STROPHEN:
Aus Strophenangaben werden konkrete Inhaltskriterien.
Nicht: "Beschreibung Strophe 1"
Sondern:
- "Strophe 1: Pflaumenbaum als unglaublich klein beschrieben"
- "Strophe 1: Gitter"
- "Strophe 1: Schutz vor Tritten"
- "Strophe 1: einfache Umgangssprache"

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
- "kriterium" ist kurz.
- "beschreibung" erklärt konkret, was geprüft wird.
- "erwartung" enthält den konkreten Inhalt möglichst nah am Original.
`;
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
