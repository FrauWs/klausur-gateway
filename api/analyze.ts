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
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s safety

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5-3",
        messages: [
          {
            role: "system",
            content: "Du bist ein Korrekturassistent für Schultexte.",
          },
          {
            role: "user",
            content: sanitizedText,
          },
        ],
        temperature: 0.2,
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

    return res.status(200).json({
      ok: true,
      result: data,
    });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      error: err.name === "AbortError" ? "TIMEOUT" : "UNKNOWN_ERROR",
      message: err.message,
    });
  }
}
