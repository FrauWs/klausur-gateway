// api/analyze.ts

export default function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      route: "/api/analyze.ts",
      error: "METHOD_NOT_ALLOWED",
      method: req.method,
    });
  }

  return res.status(200).json({
    ok: true,
    route: "/api/analyze.ts",
    message: "Analyze endpoint is reachable.",
    body: req.body ?? null,
  });
}
