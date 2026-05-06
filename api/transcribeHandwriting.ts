// api/transcribeHandwriting.ts

export const config = {
  maxDuration: 60,
};

type TranscribeRequestBody = {
  imageBase64?: string;
  imageMimeType?: string;
  fileName?: string;
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

    const body = (req.body ?? {}) as TranscribeRequestBody;

    const fileBase64 = String(body.imageBase64 ?? "").trim();
    const fileMimeType = String(body.imageMimeType ?? "").trim() || "image/png";
    const fileName = String(body.fileName ?? "").trim() || "Schülertext";

    if (!fileBase64) {
      return sendJson(res, 400, {
        ok: false,
        error: "EMPTY_INPUT",
        message: "Es wurde keine Datei übergeben.",
      });
    }

    const isPdf = fileMimeType === "application/pdf";
    const isImage = fileMimeType.startsWith("image/");

    if (!isPdf && !isImage) {
      return sendJson(res, 400, {
        ok: false,
        error: "UNSUPPORTED_FILE_TYPE",
        message: "Unterstützt werden PDF, PNG und JPG.",
      });
    }

    const payload = buildOpenAiPayload({
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

    const text = extractOutputText(parsedOpenAi).trim();

    if (!text) {
      return sendJson(res, 500, {
        ok: false,
        error: "EMPTY_TRANSCRIPTION",
        parsedOpenAi,
      });
    }

    return sendJson(res, 200, {
      ok: true,
      text,
      transcription: text,
      debug: {
        inputType: fileMimeType,
        fileName,
        textLength: text.length,
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
  fileBase64: string;
  fileMimeType: string;
  fileName: string;
}) {
  const { fileBase64, fileMimeType, fileName } = params;

  const content: any[] = [
    {
      type: "input_text",
      text: `
Transkribiere den gesamten sichtbaren Text aus der Datei.

Regeln:
- Schreibe nur den Text ab.
- Keine Bewertung.
- Keine Analyse.
- Keine Verbesserung.
- Keine Zusammenfassung.
- Behalte Absätze möglichst bei.
- Wenn etwas unleserlich ist, schreibe [unleserlich].
- Bei mehrseitigen PDFs: transkribiere alle Seiten in Reihenfolge.
`.trim(),
    },
  ];

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

  return {
    model: "gpt-4.1-mini",
    temperature: 0,
    input: [
      {
        role: "user",
        content,
      },
    ],
  };
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

function stripDataUrl(value: string): string {
  const cleaned = String(value ?? "").trim();
  const commaIndex = cleaned.indexOf(",");

  if (cleaned.startsWith("data:") && commaIndex >= 0) {
    return cleaned.slice(commaIndex + 1);
  }

  return cleaned;
}
