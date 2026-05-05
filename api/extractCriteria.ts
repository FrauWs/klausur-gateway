// api/extractCriteria.ts

export const config = {
  maxDuration: 60,
};

type ExtractCriteriaRequestBody = {
  expectationHorizonText?: string;
  imageBase64?: string;
  imageMimeType?: string;
  fileName?: string;
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

function setCors(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res: any, status: number, payload: unknown) {
  setCors(res);
  res.setHeader("Content-Type", "application/json");
  return res.status(status).json(payload);
}

export default async function handler(req: any, res: any) {
  setCors(res);

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
        error: "MISSING_API_KEY",
      });
    }

    const body = (req.body ?? {}) as ExtractCriteriaRequestBody;

    const expectationHorizonText = String(body.expectationHorizonText ?? "").trim();
    const fileBase64 = String(body.imageBase64 ?? "").trim();
    const fileMimeType = String(body.imageMimeType ?? "").trim() || "image/png";
    const fileName = String(body.fileName ?? "").trim() || "Erwartungshorizont";

    if (!expectationHorizonText && !fileBase64) {
      return sendJson(res, 400, {
        ok: false,
        error: "EMPTY_INPUT",
        message: "Es wurde weder Text noch Datei übergeben.",
      });
    }

    const payload = buildOpenAiPayload({
      expectationHorizonText,
      fileBase64,
      fileMimeType,
      fileName,
    });

    const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const raw = await openAiResponse.text();

    if (!openAiResponse.ok) {
      return sendJson(res, 500, {
        ok: false,
        error: "OPENAI_ERROR",
        status: openAiResponse.status,
        raw,
      });
    }

    let parsedOpenAi: any;

    try {
      parsedOpenAi = JSON.parse(raw);
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "OPENAI_RESPONSE_NOT_JSON",
        raw,
      });
    }

    const outputText = extractOutputText(parsedOpenAi);

    if (!outputText) {
      return sendJson(res, 500, {
        ok: false,
        error: "EMPTY_MODEL_RESPONSE",
        parsedOpenAi,
      });
    }

    let modelJson: any;

    try {
      modelJson = JSON.parse(cleanJsonText(outputText));
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "MODEL_NOT_JSON",
        outputText,
      });
    }

    const criteria = normalizeCriteria(modelJson?.criteria);

    if (criteria.length === 0) {
      return sendJson(res, 500, {
        ok: false,
        error: "NO_CRITERIA_EXTRACTED",
        modelJson,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      summary: clean(modelJson?.summary ?? ""),
      criteria,
      debug: {
        count: criteria.length,
        inputType: fileBase64 ? fileMimeType : "text",
        fileName,
      },
      usage: parsedOpenAi?.usage ?? null,
    });
  } catch (error: any) {
    return sendJson(res, 500, {
      ok: false,
      error: "SERVER_ERROR",
      message: error?.message ?? String(error),
    });
  }
}

function buildOpenAiPayload(params: {
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
          `Das Bewertungsraster liegt als Datei vor. Dateiname: ${fileName}. Lies den Inhalt vollständig und seitenübergreifend aus.`,
      ),
    },
  ];

  if (fileBase64) {
    if (fileMimeType === "application/pdf") {
      content.push({
        type: "input_file",
        filename: fileName.toLowerCase().endsWith(".pdf") ? fileName : `${fileName}.pdf`,
        file_data: `data:application/pdf;base64,${stripDataUrl(fileBase64)}`,
      });
    } else if (fileMimeType.startsWith("image/")) {
      content.push({
        type: "input_image",
        image_url: `data:${fileMimeType};base64,${stripDataUrl(fileBase64)}`,
      });
    }
  }

  return {
    model: "gpt-4.1",
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
        content,
      },
    ],
    text: {
      format: {
        type: "json_object",
      },
    },
  };
}

const SYSTEM_PROMPT = `
Du extrahierst Bewertungsraster aus Erwartungshorizonten.

Deine Aufgabe ist NICHT, ein neues kompaktes Raster zu entwerfen.
Deine Aufgabe ist, das vorhandene Raster möglichst detailgetreu in eine strukturierte Form zu übertragen.

Grundregeln:
- Übernimm konkrete Angaben aus dem Erwartungshorizont.
- Kürze keine Inhalte weg.
- Verallgemeinere nicht.
- Ersetze konkrete Angaben niemals durch Formulierungen wie "alle wesentlichen Angaben", "sprachliche Besonderheiten" oder "angemessene Analyse".
- Ein zwei Seiten langes Raster darf nicht auf wenige Sammelkriterien reduziert werden.
- Wenn der Erwartungshorizont viele Unterpunkte enthält, müssen diese als expectedElements erhalten bleiben.
- expectedElements sind zentral und sollen konkrete Textdetails, Fachbegriffe, Teilanforderungen, Beispiele und Beobachtungen enthalten.
- Kriterien dürfen bündeln, aber nur, wenn alle konkreten Unterpunkte innerhalb von expectedElements erhalten bleiben.
- Wenn einzelne Strophen, Abschnitte, Aufgabenbereiche oder Analyseaspekte getrennt aufgeführt sind, sollen sie als eigene Kriterien erhalten bleiben.
- Darstellungsleistung darf gebündelt werden, Verstehensleistung soll differenziert bleiben.

Gib ausschließlich gültiges JSON zurück.
`.trim();

function buildPrompt(text: string): string {
  return `
Extrahiere aus dem folgenden Erwartungshorizont ein detailreiches Bewertungsraster.

ENTSCHEIDENDE REGEL:
Das Ergebnis muss den Inhalt des Erwartungshorizonts möglichst vollständig abbilden.
Wenn der Erwartungshorizont zwei Seiten lang ist, sind 4 Kriterien fast sicher zu wenig.

ZIELUMFANG:
- Bei kurzen Rastern: 6 bis 12 Kriterien.
- Bei zweiseitigen Rastern: 12 bis 25 Kriterien.
- Maximal 35 Kriterien.
- Lieber mehrere fachlich saubere Kriterien als zu grobe Sammelpunkte.

NICHT ERLAUBT:
- "Die Einleitung enthält alle relevanten Angaben."
- "Die Form wird korrekt beschrieben."
- "Die Strophen werden analysiert."
- "Sprachliche Auffälligkeiten werden berücksichtigt."
- "Ein sinnvolles Fazit wird formuliert."

ERLAUBT / ERWÜNSCHT:
- Textsorte: Gedicht
- Titel: Der Pflaumenbaum
- Autor: Bertolt Brecht
- Entstehungsjahr: 1933
- Thema: Beschreibung eines kleinen Pflaumenbaums
- Inhalt: kleiner Pflaumenbaum im Hof, kann nicht weiterwachsen
- drei Strophen mit jeweils vier Versen
- Paarreime / Kreuzreim
- Gitter als Schutz und Begrenzung
- Pflaumenbaum als Symbol für einen Menschen
- äußere Beschränkungen
- Anerkennung trotz eingeschränkter Entfaltungsmöglichkeiten
- einfache Umgangssprache
- Wiederholungen
- Personifikation
- konkrete Deutung einzelner Strophen

REGEL FÜR KRITERIEN:
Ein Kriterium ist eine bewertbare Teilleistung.
Ein erwarteter Einzelaspekt innerhalb dieser Teilleistung kommt in expectedElements.

BEISPIEL:
Wenn im Erwartungshorizont steht:
"vollständige Einleitung mit Textsorte, Titel, Autor, Entstehungsjahr, Thema und Inhalt"

Dann darf das NICHT nur werden:
"Die Einleitung enthält alle relevanten Angaben."

Sondern es muss werden:
{
  "bereich": "Verstehensleistung",
  "kriterium": "Vollständige Einleitung",
  "beschreibung": "Die Einleitung enthält die geforderten Angaben zum Gedicht.",
  "erwartung": "Textsorte, Titel, Autor, Entstehungsjahr, Thema und Inhalt werden konkret benannt.",
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

AUFTEILUNG:
- Einleitung: eigenes Kriterium
- Interpretationshypothese: eigenes Kriterium
- lyrische Form: eigenes Kriterium
- jede einzeln erkennbare Strophe / jeder Analyseabschnitt: eigenes Kriterium
- sprachliche Analyse nur dann bündeln, wenn alle Mittel konkret in expectedElements stehen
- Aussageabsicht / Deutung: eigenes Kriterium
- Fazit: eigenes Kriterium
- Darstellungsleistung: ein bis drei Kriterien, je nach Vorlage

SUMMARY:
Erstelle eine kurze summary in 2 bis 4 Sätzen. Sie soll nur zusammenfassen, nicht die Kriterien ersetzen.

ERWARTUNGSHORIZONT:
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
- Keine allgemeinen Ersatzformulierungen.
- Konkrete Angaben aus dem Erwartungshorizont vollständig übernehmen.
- expectedElements bei jedem fachlichen Kriterium möglichst konkret füllen.
- Wenn du unsicher bist, ob etwas ein eigenes Kriterium oder expectedElement ist: lieber eigenes Kriterium.
`.trim();
}

function extractOutputText(response: any): string {
  if (typeof response?.output_text === "string") {
    return response.output_text;
  }

  const output = Array.isArray(response?.output) ? response.output : [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") {
        return part.text;
      }
    }
  }

  return "";
}

function normalizeCriteria(input: any): Criterion[] {
  const raw = Array.isArray(input) ? input : [];

  return raw
    .map((criterion, index) => {
      const expectedElements = normalizeExpectedElements(criterion?.expectedElements ?? []);
      const erwartung =
        clean(criterion?.erwartung ?? "") || expectedElementsToText(expectedElements);
      const kriterium =
        clean(criterion?.kriterium ?? "") ||
        clean(criterion?.title ?? "") ||
        `Kriterium ${index + 1}`;

      const beschreibung =
        clean(criterion?.beschreibung ?? "") ||
        buildDescription(kriterium, erwartung, expectedElements);

      return {
        id: `crit-${index}`,
        bereich: clean(criterion?.bereich ?? "") || "Allgemein",
        kriterium,
        beschreibung,
        erwartung,
        expectedElements,
        gewichtung: clean(criterion?.gewichtung ?? ""),
        aktiv: criterion?.aktiv !== false,
      };
    })
    .filter((criterion) => {
      return (
        criterion.kriterium.trim().length > 0 ||
        criterion.beschreibung.trim().length > 0 ||
        criterion.erwartung.trim().length > 0 ||
        criterion.expectedElements.length > 0
      );
    });
}

function normalizeExpectedElements(input: any): ExpectedElement[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((item) => ({
      label: clean(item?.label ?? ""),
      erwartung: clean(item?.erwartung ?? ""),
    }))
    .filter((item) => item.label || item.erwartung);
}

function expectedElementsToText(input: ExpectedElement[]): string {
  return input.map((item) => `${item.label}: ${item.erwartung}`).join("; ");
}

function buildDescription(
  kriterium: string,
  erwartung: string,
  expectedElements: ExpectedElement[],
): string {
  if (expectedElements.length > 0) {
    return `${kriterium}: ${expectedElements
      .map((item) => `${item.label}: ${item.erwartung}`)
      .join("; ")}`;
  }

  return erwartung || kriterium;
}

function cleanJsonText(text: string): string {
  return String(text ?? "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripDataUrl(value: string): string {
  const cleaned = String(value ?? "").trim();
  const commaIndex = cleaned.indexOf(",");
  if (cleaned.startsWith("data:") && commaIndex >= 0) {
    return cleaned.slice(commaIndex + 1);
  }

  return cleaned;
}
