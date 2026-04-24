// api/analyze.ts

import { SYSTEM_PROMPT } from "../analyzePrompt.js";
import { AnalyzeResponseSchema } from "../analyzeSchema.js";
import { sanitizeOutput } from "../sanitizeOutput.js";

export default async function handler(req: Request) {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const body = await req.json();

  const { sanitizedText, rubricText } = body;

  if (!sanitizedText || !rubricText) {
    return new Response(
      JSON.stringify({
        error: "Missing required fields: sanitizedText and rubricText",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.3",
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: `
TEXT:
${sanitizedText}

RASTER:
${rubricText}
          `,
        },
      ],
      response_format: {
        type: "json_object",
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();

    return new Response(
      JSON.stringify({
        error: "OpenAI request failed",
        details: errorText,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const data = await response.json();

  const rawOutput = data?.choices?.[0]?.message?.content;

  if (!rawOutput) {
    return new Response(
      JSON.stringify({
        error: "No analysis content returned",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const cleanedOutput = sanitizeOutput(rawOutput);

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(cleanedOutput);
  } catch {
    return new Response(
      JSON.stringify({
        error: "AI response was not valid JSON",
        raw: cleanedOutput,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const parsed = AnalyzeResponseSchema.parse(parsedJson);

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
