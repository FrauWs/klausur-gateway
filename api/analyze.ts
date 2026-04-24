// api/analyze.ts

import { SYSTEM_PROMPT } from "../analyzePrompt";
import { AnalyzeResponseSchema } from "../analyzeSchema";
import { sanitizeOutput } from "../sanitizeOutput";

export default async function handler(req: Request) {
  const body = await req.json();

  const { sanitizedText, rubricText } = body;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.3",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
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
    }),
  });

  const data = await response.json();

  let output = data.choices[0].message.content;

  output = sanitizeOutput(output);

  const parsed = AnalyzeResponseSchema.parse(JSON.parse(output));

  return new Response(JSON.stringify(parsed), {
    headers: { "Content-Type": "application/json" },
  });
}
