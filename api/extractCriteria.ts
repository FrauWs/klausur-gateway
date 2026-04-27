// api/extractCriteria.ts

export const config = {
  runtime: "edge",
};

type Body = {
  expectationHorizonText?: string;
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: corsHeaders(),
    });
  }

  if (req.method !== "POST") {
    return json(
      { ok: false, error: "METHOD_NOT_ALLOWED" },
      405
    );
  }

  try {
    const body = (await req.json()) as Body;

    const text = String(body.expectationHorizonText ?? "").trim();

    if (!text) {
      return json(
        { ok: false, error: "MISSING_EXPECTATION_HORIZON" },
        400
      );
    }

    const apiKey = (globalThis as any)?.process?.env?.OPENAI_API_KEY;

    if (!apiKey) {
      return json(
        { ok: false, error: "MISSING_API_KEY" },
        500
      );
    }

    const prompt = `
Extrahiere ein klares Bewertungsraster.

TEXT:
${text}

Gib nur JSON zurück:

{
  "criteria": [
    {
      "area": "string",
      "name": "string",
      "expectedElements": ["string"],
      "weighting": "string"
    }
  ]
}
`;

    const openai = await fetch("https://api.openai.com/v1/chat/completions", {
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
            content: "Extrahiere nur Kriterien. Kein Zusatztext.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!openai.ok) {
      const err = await openai.text();
      return json({ ok: false, error: err }, 500);
    }

    const data = await openai.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";

    return json({
      ok: true,
      criteria: JSON.parse(content).criteria ?? [],
    });
  } catch (e: any) {
    return json(
      { ok: false, error: e?.message ?? "UNKNOWN_ERROR" },
      500
    );
  }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
