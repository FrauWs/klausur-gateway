// api/analyze.ts

export default function handler(req: any, res: any) {
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
      received: req.body ?? null,
    });
  }

  return res.status(200).json({
    ok: true,
    message: "Input valid",
  });
}
