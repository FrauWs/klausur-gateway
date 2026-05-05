// api/analyze.ts

export const config = {
  maxDuration: 60,
};

type Body = {
  studentText?: string;
  raster?: any;
};

function setCors(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res: any, status: number, data: any) {
  setCors(res);
  res.status(status).json(data);
}

export default async function handler(req: any, res: any) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return send(res, 405, { error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return send(res, 500, { error: "NO_API_KEY" });

    const { studentText, raster } = req.body || {};

    if (!studentText || !raster) {
      return send(res, 400, { error: "MISSING_INPUT" });
    }

    // 🔥 EXTREM WICHTIG: Raster massiv kürzen
    const compactRaster = raster.criteria.map((c: any) => ({
      kriterium: c.kriterium,
      erwartung: c.erwartung.slice(0, 300), // hart kürzen
    }));

    const prompt = `
Bewerte den Schülertext anhand des Rasters.

REGELN:
- Nur auf Basis des Textes bewerten
- Keine Halluzination
- Kurz und konkret bleiben

RASTER:
${JSON.stringify(compactRaster)}

SCHÜLERTEXT:
${studentText}

Gib JSON zurück:

{
  "bewertungen": [
    {
      "kriterium": "string",
      "erfüllt": true/false,
      "begründung": "string"
    }
  ]
}
`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini", // 🔥 wichtig für Speed
        temperature: 0,
        input: prompt,
        text: { format: { type: "json_object" } },
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      return send(res, 500, { error: "OPENAI_ERROR", raw });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return send(res, 500, { error: "PARSE_ERROR", raw });
    }

    return send(res, 200, parsed);
  } catch (err: any) {
    return send(res, 500, { error: err.message });
  }
}
