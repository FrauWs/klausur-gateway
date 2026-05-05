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

const ExpectedElementSchema = z.object({
  label: z.string(),
  erwartung: z.string(),
});

const CriteriaSchema = z.object({
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
        const expectedElements = normalizeExpectedElements(criterion.expectedElements ?? []);
        const erwartung = clean(criterion.erwartung) || expectedElementsToText(expectedElements);
        const beschreibung = clean(criterion.beschreibung);

        return {
          id: `crit-${index}`,
          bereich,
          kriterium,
          beschreibung: buildDescription(beschreibung, erwartung, expectedElements, kriterium),
          erwartung,
          expectedElements,
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
            }. Lies den sichtbaren Text vollständig aus. Extrahiere daraus bewertbare Leistungseinheiten mit konkreten Untererwartungen.`,
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

Bündeln ist richtig bei:
- vollständige Einleitung mit Textsorte, Titel, Autor, Entstehungsjahr, Thema, Inhalt
- lyrische Form mit Strophenzahl, Verszahl, Reimschema
- Beschreibung und Deutung einer einzelnen Strophe mit mehreren Unteraspekten
- sprachliche Analyse einer Strophe mit mehreren genannten Beobachtungen
- formale Analyse mit mehreren zusammengehörigen Formaspekten

Zerlegen ist richtig bei:
- eigenständigen Analyseleistungen
- getrennten Strophen
- getrennten Aufgabenbereichen
- getrennten großen Kompetenzbereichen
- deutlich getrennten inhaltlichen Arbeitsschritten

Verboten:
- aus "vollständige Einleitung" sechs Einzelkriterien machen
- aus "lyrische Form" drei Einzelkriterien machen
- generische Beschreibungen ohne konkrete Untererwartungen
- konkrete Inhalte auslassen
- Kriterien erfinden, die nicht im Raster stehen

Gib ausschließlich gültiges JSON zurück.
`;

function buildPrompt(text: string): string {
  return `
Extrahiere aus dem folgenden Erwartungshorizont ein Bewertungsraster.

ZENTRALE ENTSCHEIDUNG:
Nicht jeder Spiegelstrich ist automatisch ein eigenes Kriterium.
Ein Kriterium ist eine bewertbare Leistungseinheit.
Konkrete Unterpunkte werden als expectedElements innerhalb dieses Kriteriums gespeichert.

BEISPIEL 1 — EINLEITUNG:

Aus:
"Du hast eine vollständige Einleitung verfasst, die folgende Angaben enthält:
- Textsorte: Gedicht
- Titel: Der Pflaumenbaum
- Autor: Bertolt Brecht
- Entstehungsjahr: 1933
- Thema: Beschreibung eines kleinen Pflaumenbaums
- Inhalt: Ein kleiner Pflaumenbaum steht in einem Hof und kann nicht weiterwachsen ..."

wird EIN Kriterium:

{
  "bereich": "Verstehensleistung",
  "kriterium": "Vollständige Einleitung",
  "beschreibung": "Die Einleitung enthält die geforderten Angaben zu Textsorte, Titel, Autor, Entstehungsjahr, Thema und Inhalt.",
  "erwartung": "Textsorte: Gedicht; Titel: Der Pflaumenbaum; Autor: Bertolt Brecht; Entstehungsjahr: 1933; Thema: Beschreibung eines kleinen Pflaumenbaums; Inhalt: Ein kleiner Pflaumenbaum steht in einem Hof und kann nicht weiterwachsen.",
  "expectedElements": [
    { "label": "Textsorte", "erwartung": "Gedicht" },
    { "label": "Titel", "erwartung": "Der Pflaumenbaum" },
    { "label": "Autor", "erwartung": "Bertolt Brecht" },
    { "label": "Entstehungsjahr", "erwartung": "1933" },
    { "label": "Thema", "erwartung": "Beschreibung eines kleinen Pflaumenbaums" },
    { "label": "Inhalt", "erwartung": "Ein kleiner Pflaumenbaum steht in einem Hof und kann nicht weiterwachsen." }
  ],
  "gewichtung": "",
  "aktiv": true
}

BEISPIEL 2 — INTERPRETATIONSHYPOTHESE:

Aus:
"Du hast eine Interpretationshypothese verfasst, etwa: Möglicherweise soll der Pflaumenbaum stellvertretend für einen Menschen stehen ..."

wird EIN Kriterium:

{
  "bereich": "Verstehensleistung",
  "kriterium": "Interpretationshypothese",
  "beschreibung": "Eine Interpretationshypothese zum Symbolcharakter des Pflaumenbaums wird vor der Analyse formuliert.",
  "erwartung": "Der Pflaumenbaum steht möglicherweise stellvertretend für einen Menschen, der aufgrund äußerer Beschränkungen seine Fähigkeiten nicht entfalten kann, aber dennoch respektiert werden muss.",
  "expectedElements": [
    { "label": "Symbolcharakter", "erwartung": "Pflaumenbaum steht stellvertretend für einen Menschen" },
    { "label": "äußere Beschränkungen", "erwartung": "äußere Beschränkungen verhindern die Entfaltung" },
    { "label": "Respekt", "erwartung": "der Mensch muss dennoch respektiert werden" }
  ],
  "gewichtung": "",
  "aktiv": true
}

BEISPIEL 3 — LYRISCHE FORM:

Aus:
"Du hast die lyrische Form beschrieben und erklärt:
- drei Strophen mit jeweils vier Versen
- Reimschema: je zwei Paarreime in den ersten beiden Strophen, Kreuzreim in der dritten Strophe"

wird EIN Kriterium:

{
  "bereich": "Verstehensleistung",
  "kriterium": "Lyrische Form",
  "beschreibung": "Die lyrische Form wird anhand von Strophen, Versen und Reimschema beschrieben und erklärt.",
  "erwartung": "drei Strophen mit jeweils vier Versen; je zwei Paarreime in den ersten beiden Strophen; Kreuzreim in der dritten Strophe",
  "expectedElements": [
    { "label": "Strophen und Verse", "erwartung": "drei Strophen mit jeweils vier Versen" },
    { "label": "Paarreime", "erwartung": "je zwei Paarreime in den ersten beiden Strophen" },
    { "label": "Kreuzreim", "erwartung": "Kreuzreim in der dritten Strophe" }
  ],
  "gewichtung": "",
  "aktiv": true
}

BEISPIEL 4 — EINZELSTROPHEN:

Aus:
"Strophe 1: Beschreibung des Pflaumenbaums als unglaublich klein, eingefasst von einem Gitter, das aber auch Schutz vor Tritten bietet; sprachliche Auffälligkeiten: einfache Umgangssprache"

wird EIN Kriterium:

{
  "bereich": "Verstehensleistung",
  "kriterium": "Strophe 1: Beschreibung und Deutung",
  "beschreibung": "Die erste Strophe wird inhaltlich beschrieben und gedeutet; sprachliche Auffälligkeiten werden berücksichtigt.",
  "erwartung": "Pflaumenbaum als unglaublich klein; Gitter um den Baum; Gitter bietet Schutz vor Tritten; einfache Umgangssprache",
  "expectedElements": [
    { "label": "Kleinheit", "erwartung": "Pflaumenbaum als unglaublich klein" },
    { "label": "Gitter", "erwartung": "eingefasst von einem Gitter" },
    { "label": "Schutzfunktion", "erwartung": "Gitter bietet Schutz vor Tritten" },
    { "label": "Sprache", "erwartung": "einfache Umgangssprache" }
  ],
  "gewichtung": "",
  "aktiv": true
}

REGELN:
- Bündele Unterpunkte, wenn sie zusammen eine bewertbare Teilleistung bilden.
- Zerlege nur dann, wenn eigenständige Analyseleistungen entstehen.
- Der konkrete Inhalt darf niemals verloren gehen.
- expectedElements ist wichtig und muss konkrete Untererwartungen enthalten.
- "beschreibung" beschreibt die Leistungseinheit.
- "erwartung" sammelt die konkreten Inhalte.
- Keine Noten.
- Keine Punkte vergeben.
- Keine erfundenen Kriterien.

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

function expectedElementsToText(input: { label: string; erwartung: string }[]): string {
  return input.map((item) => `${item.label}: ${item.erwartung}`).join("; ");
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
