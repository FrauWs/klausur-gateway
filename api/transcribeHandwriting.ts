// api/transcribeHandwriting.ts

declare const process: {
  env: {
    OPENAI_API_KEY?: string;
  };
};

type TranscribeRequestBody = {
  imageBase64?: string;
  imageMimeType?: string;
  fileName?: string;
};

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
    const body = (req.body ?? {}) as TranscribeRequestBody;

    const imageBase64 = String(body.imageBase64 ?? "").trim();
    const imageMimeType = String(body.imageMimeType ?? "").trim();
    const fileName = String(body.fileName ?? "").trim();

    if (!imageBase64) {
      return sendJson(res, 400, {
        ok: false,
        error: "EMPTY_INPUT",
        message: "Es wurde kein Bildinhalt übergeben.",
      });
    }

    if (imageMimeType === "application/pdf") {
      return sendJson(res, 400, {
        ok: false,
        error: "PDF_NOT_SUPPORTED",
        message:
          "PDF-Dateien können in dieser Gateway-Version nicht direkt transkribiert werden. Bitte als PNG/JPG-Screenshot hochladen.",
      });
    }

    if (!imageMimeType.startsWith("image/")) {
      return sendJson(res, 400, {
        ok: false,
        error: "UNSUPPORTED_FILE_TYPE",
        message: "Für die Transkription werden aktuell nur Bilder unterstützt.",
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(res, 500, {
        ok: false,
        error: "MISSING_API_KEY",
      });
    }

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
        messages: [
          {
            role: "system",
            content:
              "Du transkribierst handschriftliche Schülertexte. Du gibst ausschließlich gültiges JSON zurück. Du bewertest nicht. Du korrigierst nicht. Du glättest nicht. Du übernimmst erkennbare Fehler, Zeilenumbrüche und Unsicherheiten möglichst genau.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildPrompt(fileName),
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${imageMimeType};base64,${imageBase64}`,
                },
              },
            ],
          },
        ],
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

    let modelJson: any;

    try {
      modelJson = JSON.parse(content);
    } catch {
      return sendJson(res, 500, {
        ok: false,
        error: "MODEL_NOT_JSON",
        content,
      });
    }

    const transcription = String(modelJson?.transcription ?? "").trim();

    if (!transcription) {
      return sendJson(res, 500, {
        ok: false,
        error: "NO_TRANSCRIPTION",
        message: "Es konnte keine Transkription erzeugt werden.",
        modelJson,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      transcription,
      warnings: Array.isArray(modelJson?.warnings) ? modelJson.warnings : [],
      debug: {
        inputType: imageMimeType,
        fileName,
        length: transcription.length,
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

function buildPrompt(fileName: string): string {
  return `
Transkribiere den handschriftlichen Schülertext im Bild.

DATEI:
${fileName || "unbekannt"}

REGELN:
- Gib den erkennbaren Schülertext möglichst wortgetreu wieder.
- Korrigiere keine Rechtschreibung.
- Korrigiere keine Grammatik.
- Ergänze keine fehlenden Wörter.
- Erfinde keine Inhalte.
- Übernimm Zeilenumbrüche sinnvoll.
- Wenn ein Wort nicht sicher lesbar ist, markiere es mit [unleserlich].
- Wenn ein Wort unsicher ist, markiere es mit [?] direkt hinter dem Wort.
- Randnotizen, Lehrpersonenkommentare, Stempel oder Scan-App-Hinweise nicht in den Schülertext übernehmen.
- Keine Bewertung.
- Keine Analyse.

Gib ausschließlich JSON in exakt dieser Struktur zurück:

{
  "transcription": "string",
  "warnings": ["string"]
}
`;
}
