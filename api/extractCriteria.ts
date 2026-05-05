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
          `Das Bewertungsraster liegt als Datei vor. Dateiname: ${fileName}. Lies den Inhalt vollständig und seitenübergreifend aus. Verwende ausschließlich Angaben aus dieser Datei.`,
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
Du bist kein Bewertungsassistent, sondern ein Extraktionssystem.

Deine Aufgabe:
Du liest einen Erwartungshorizont oder ein Bewertungsraster aus einer Datei und überträgst die dort vorhandenen Angaben möglichst textnah in eine JSON-Struktur.

Strikte Regeln:
- Du darfst keine Kriterien erfinden.
- Du darfst keine allgemeinen Ersatzformulierungen bilden.
- Du darfst keine konkreten Angaben durch Oberbegriffe ersetzen.
- Du darfst nicht schreiben: "alle relevanten Angaben", "sprachliche Besonderheiten", "korrekt beschrieben", "plausibel", "angemessen", wenn im Raster konkrete Angaben stehen.
- Du musst konkrete Angaben aus dem Raster übernehmen.
- Wenn ein Detail im Raster steht, muss es in erwartung oder expectedElements erscheinen.
- Wenn ein Detail nicht im Raster steht oder nicht lesbar ist, darfst du es nicht ergänzen.
- Wenn der Text nicht lesbar ist, schreibe "im Raster nicht lesbar".
- Nutze möglichst die Formulierungen des Rasters.
- expectedElements müssen konkret sein.
- Die Verstehensleistung darf nicht zu wenigen Sammelkriterien reduziert werden.
- Darstellungsleistung darf knapper gebündelt werden.

Wichtig:
Das Ergebnis soll nicht schön formuliert sein, sondern quellentreu.
`.trim();

function buildPrompt(text: string): string {
  return `
Extrahiere aus dem folgenden Erwartungshorizont ein quellentreues Bewertungsraster.

ARBEITSWEISE:
1. Lies zuerst die Angaben aus dem Raster.
2. Übernimm konkrete Details textnah.
3. Strukturiere erst danach in Kriterien.
4. Erfinde nichts.
5. Verallgemeinere nichts.

ZENTRALE REGEL:
Jede konkrete Angabe aus dem Erwartungshorizont muss erhalten bleiben.

FALSCH:
"Die Einleitung enthält die geforderten Angaben zum Gedicht."

RICHTIG:
"Textsorte: Gedicht; Titel: Der Pflaumenbaum; Autor: Bertolt Brecht; Entstehungsjahr: 1933; Thema: ...; Inhalt: ..."

FALSCH:
"Die erste Strophe wird inhaltlich und sprachlich analysiert."

RICHTIG:
Die erwarteten Einzelaspekte der ersten Strophe müssen konkret genannt werden, zum Beispiel:
- Pflaumenbaum ist sehr klein
- steht im Hof
- ist von einem Gitter umgeben
- Gitter schützt vor Tritten
- zugleich Begrenzung / Einschränkung
- sprachliche Beobachtungen genau so übernehmen, wie sie im Raster stehen

FALSCH:
"sprachliche Auffälligkeiten"

RICHTIG:
Konkrete sprachliche Auffälligkeiten aus dem Raster nennen, z. B. Wiederholung, Personifikation, Umgangssprache, Kontrast, Metapher usw. Nur nennen, wenn sie im Raster stehen.

AUSGABELOGIK:
- Einleitung = eigenes Kriterium
- Interpretationshypothese = eigenes Kriterium
- Form = eigenes Kriterium
- Jede Strophe / jeder Analyseabschnitt = eigenes Kriterium, wenn im Raster getrennt
- Sprache = eigenes Kriterium oder expectedElements bei der jeweiligen Strophe, abhängig vom Raster
- Aussageabsicht = eigenes Kriterium
- Fazit = eigenes Kriterium
- Darstellungsleistung = ein bis drei Kriterien

MINDESTDETAIL:
Bei jedem fachlichen Kriterium müssen expectedElements gefüllt werden.
Wenn expectedElements leer wären, ist das Kriterium wahrscheinlich zu allgemein.

ERWARTUNG:
- Bei einem zweiseitigen Raster sind 10 bis 25 Kriterien normal.
- 4 bis 8 Kriterien sind nur akzeptabel, wenn das Raster selbst sehr kurz ist.
- Konkrete Unterpunkte müssen in expectedElements stehen.

SUMMARY:
Erstelle eine kurze summary in 2 bis 4 Sätzen. Die summary ersetzt nicht die Kriterien.

ERWARTUNGSHORIZONT / RASTER:
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
- Keine abstrakten Platzhalter.
- Keine erfundenen Inhalte.
- Keine pädagogischen Standardformulierungen.
- expectedElements niemals weglassen, wenn konkrete Unterpunkte vorhanden sind.
- Formuliere textnah zum Raster.
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

      const expectedElementsText = expectedElementsToText(expectedElements);

      const rawErwartung = clean(criterion?.erwartung ?? "");
      const rawBeschreibung = clean(criterion?.beschreibung ?? "");

      const kriterium =
        clean(criterion?.kriterium ?? "") ||
        clean(criterion?.title ?? "") ||
        `Kriterium ${index + 1}`;

      const erwartung = rawErwartung || expectedElementsText;

      const beschreibungParts = [
        rawBeschreibung,
        expectedElements.length > 0 ? `Konkrete Anforderungen: ${expectedElementsText}` : "",
      ].filter(Boolean);

      const beschreibung =
        beschreibungParts.join(" ") ||
        erwartung ||
        kriterium;

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
