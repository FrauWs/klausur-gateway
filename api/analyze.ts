// api/analyze.ts

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED",
      method: req.method,
    });
  }

  const { sanitizedText, rubricText } = req.body ?? {};

  if (!sanitizedText || !rubricText) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_FIELDS",
    });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "MISSING_API_KEY",
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const prompt = `
Du bist ein präziser Korrekturassistent für deutsche Schülertexte.

Analysiere den folgenden Text anhand der Kriterien.

TEXT:
${sanitizedText}

KRITERIEN:
${rubricText}

Gib deine Antwort ausschließlich als JSON im folgenden Format zurück:

{
  "summary": "Kurze Gesamteinschätzung",
  "strengths": ["..."],
  "issues": ["..."],
  "nextSteps": ["..."]
}
`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "Antworte nur mit gültigem JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(500).json({
        ok: false,
        error: "OPENAI_ERROR",
        details: errorText,
      });
    }

    const data = await response.json();

    const content =
      data?.choices?.[0]?.message?.content ?? "";

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "INVALID_JSON_FROM_MODEL",
        raw: content,
      });
    }

    return res.status(200).json({
      ok: true,
      analysis: parsed,
    });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      error: err.name === "AbortError" ? "TIMEOUT" : "UNKNOWN_ERROR",
      message: err.message,
    });
  }
}
