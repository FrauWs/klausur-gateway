import { AnalyzeResponseSchema } from "../analyzeSchema.js";
import { SYSTEM_PROMPT } from "../analyzePrompt.js";
import { sanitizeOutput } from "../sanitizeOutput.js";

declare const process: {
  env: {
    OPENAI_API_KEY?: string;
  };
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
    return sendJson(res, 405, { ok: false });
  }

  try {
    const { sanitizedText, expectationHorizonText, assignmentText, subject, gradeLevel, taskType } = req.body || {};

    if (!sanitizedText || !expectationHorizonText) {
      return sendJson(res, 400, { ok: false, error: "MISSING_INPUT" });
    }

    const prompt = `
KONTEXT:
Fach: ${subject || ""}
Klasse: ${gradeLevel || ""}
Aufgabe: ${taskType || ""}

AUFGABENSTELLUNG:
${assignmentText || ""}

ERWARTUNGSHORIZONT:
${expectationHorizonText}

SCHÜLERTEXT:
${sanitizedText}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      }),
    });

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    const parsed = JSON.parse(content);

    const validated = AnalyzeResponseSchema.safeParse(parsed);

    if (!validated.success) {
      return sendJson(res, 500, {
        ok: false,
        error: "INVALID_SCHEMA",
      });
    }

    const cleaned = validated.data;

    const withEvidence = cleaned.rasterabgleich.filter(
      (r) => r.textEvidence && r.textEvidence.length > 0
    );

    if (withEvidence.length === 0) {
      return sendJson(res, 500, {
        ok: false,
        error: "NO_TEXT_EVIDENCE",
      });
    }

    cleaned.rasterabgleich = cleaned.rasterabgleich.map((r) => ({
      ...r,
      hinweis: sanitizeOutput(r.hinweis),
    }));

    return sendJson(res, 200, {
      ok: true,
      analysis: cleaned,
      usage: data?.usage ?? null,
    });
  } catch (e: any) {
    return sendJson(res, 500, {
      ok: false,
      error: "SERVER_ERROR",
      message: e.message,
    });
  }
}
