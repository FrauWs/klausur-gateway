// api/extractCriteria.ts

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  const { expectationHorizonText } = req.body ?? {};

  if (!expectationHorizonText) {
    return res.status(400).json({
      error: "MISSING_EXPECTATION_HORIZON",
    });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Extrahiere ausschließlich Bewertungskriterien aus einem Erwartungshorizont. Kein Zusatztext.",
        },
        {
          role: "user",
          content: `
Extrahiere klare Bewertungskriterien.

TEXT:
${expectationHorizonText}

FORMAT:

{
  "criteria": [
    {
      "name": "string",
      "expectedElements": ["string"],
      "weighting": "string"
    }
  ]
}
`,
        },
      ],
    }),
  });

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "{}";

  return res.status(200).json(JSON.parse(content));
}
