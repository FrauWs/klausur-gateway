import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";

const ALLOWED_MODES = [
  "klausur",
  "sprachfeedback",
  "rasterabgleich",
  "randkommentare"
] as const;

const requestSchema = z.object({
  sanitizedText: z.string().min(1).max(50000),
  rubricText: z.string().max(30000).optional().default(""),
  analysisMode: z.enum(ALLOWED_MODES),
  analysisContext: z.object({
    jahrgang: z.string().max(100).optional().default(""),
    fach: z.string().max(100).optional().default(""),
    aufgabentyp: z.string().max(100).optional().default(""),
    strenge: z.number().min(1).max(5).optional().default(3)
  })
});

type AnalysisRequest = z.infer<typeof requestSchema>;

type AnalysisResponse = {
  success: true;
  analysis: {
    summary: string;
    strengths: string[];
    issues: string[];
    rubricAlignment: string[];
    suggestedFeedback: string[];
  };
} | {
  success: false;
  error: string;
};

function setCors(res: VercelResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function buildSystemPrompt(): string {
  return [
    "Du bist ein fachlich präziser Korrekturassistent für schulische Texte.",
    "Wichtige Regeln:",
    "1. Arbeite ausschließlich mit dem bereitgestellten anonymisierten Text.",
    "2. Triff keine Aussagen über Identität, Motivation oder Persönlichkeit der schreibenden Person.",
    "3. Gib keine endgültige Note als Tatsache aus.",
    "4. Formuliere sachlich, knapp und nachvollziehbar.",
    "5. Orientiere dich am Bewertungsraster, wenn eines vorliegt.",
    "6. Gib das Ergebnis ausschließlich als valides JSON zurück.",
    "7. Verwende Deutsch."
  ].join("\n");
}

function buildUserPrompt(data: AnalysisRequest): string {
  const { sanitizedText, rubricText, analysisMode, analysisContext } = data;

  return [
    "Analysiere den folgenden anonymisierten Schülertext.",
    "",
    `Modus: ${analysisMode}`,
    `Jahrgang: ${analysisContext.jahrgang || "nicht angegeben"}`,
    `Fach: ${analysisContext.fach || "nicht angegeben"}`,
    `Aufgabentyp: ${analysisContext.aufgabentyp || "nicht angegeben"}`,
    `Strenge: ${analysisContext.strenge}`,
    "",
    "Bewertungsraster:",
    rubricText || "Kein Bewertungsraster angegeben.",
    "",
    "Anonymisierter Text:",
    sanitizedText,
    "",
    "Gib ausschließlich JSON in genau diesem Format zurück:",
    `{
  "summary": "kurze Gesamteinschätzung",
  "strengths": ["...", "..."],
  "issues": ["...", "..."],
  "rubricAlignment": ["...", "..."],
  "suggestedFeedback": ["...", "..."]
}`
  ].join("\n");
}

function extractJson(text: string): {
  summary: string;
  strengths: string[];
  issues: string[];
  rubricAlignment: string[];
  suggestedFeedback: string[];
} {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Kein JSON in der Modellantwort gefunden.");
    }
    return JSON.parse(match[0]);
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse<AnalysisResponse>
): Promise<void> {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({
      success: false,
      error: "Nur POST ist erlaubt."
    });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;

  if (!apiKey) {
    res.status(500).json({
      success: false,
      error: "OPENAI_API_KEY fehlt."
    });
    return;
  }

  if (!model) {
    res.status(500).json({
      success: false,
      error: "OPENAI_MODEL fehlt."
    });
    return;
  }

  let parsed: AnalysisRequest;

  try {
    parsed = requestSchema.parse(req.body);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | ")
        : "Ungültiger Request.";

    res.status(400).json({
      success: false,
      error: `Request ungültig: ${message}`
    });
    return;
  }

  try {
    const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: buildSystemPrompt()
          },
          {
            role: "user",
            content: buildUserPrompt(parsed)
          }
        ]
      })
    });

    if (!openAiResponse.ok) {
      const errorText = await openAiResponse.text();
      res.status(502).json({
        success: false,
        error: `OpenAI-Fehler: ${errorText}`
      });
      return;
    }

    const data = await openAiResponse.json();
    const content = data?.choices?.[0]?.message?.content;

    if (typeof content !== "string" || !content.trim()) {
      res.status(502).json({
        success: false,
        error: "Leere oder ungültige Modellantwort."
      });
      return;
    }

    const analysis = extractJson(content);

    res.status(200).json({
      success: true,
      analysis: {
        summary: String(analysis.summary || ""),
        strengths: Array.isArray(analysis.strengths) ? analysis.strengths.map(String) : [],
        issues: Array.isArray(analysis.issues) ? analysis.issues.map(String) : [],
        rubricAlignment: Array.isArray(analysis.rubricAlignment)
          ? analysis.rubricAlignment.map(String)
          : [],
        suggestedFeedback: Array.isArray(analysis.suggestedFeedback)
          ? analysis.suggestedFeedback.map(String)
          : []
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unbekannter Serverfehler.";
    res.status(500).json({
      success: false,
      error: message
    });
  }
}
