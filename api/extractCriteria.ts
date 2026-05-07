// api/extractCriteria.ts

import { z } from "zod";

export const config = {
  maxDuration: 10,
};

const BodySchema = z.object({
  expectationHorizonText: z.string().optional(),
  imageBase64: z.string().optional(),
  imageMimeType: z.string().optional(),
  fileName: z.string().optional(),
});

type Criterion = {
  id: string;
  bereich: string;
  kriterium: string;
  beschreibung: string;
  erwartung: string;
  expectedElements: { label: string; erwartung: string }[];
  gewichtung: string;
  aktiv: boolean;
};

function setCors(req: any, res: any) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(req: any, res: any, status: number, payload: unknown) {
  setCors(req, res);
  res.setHeader("Content-Type", "application/json");
  return res.status(status).json(payload);
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanLine(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[-–•]\s*/, "")
    .trim();
}

function toTitle(text: string): string {
  const cleaned = cleanLine(text)
    .replace(/^Du hast\s+/i, "")
    .replace(/^Du schreibst\s+/i, "")
    .replace(/^Du belegst\s+/i, "")
    .replace(/^Du beachtest\s+/i, "")
    .replace(/^Du formulierst\s+/i, "")
    .replace(/\.$/, "");

  if (/Einleitung/i.test(cleaned)) return "Vollständige Einleitung";
  if (/Interpretationshypothese/i.test(cleaned)) return "Interpretationshypothese";
  if (/lyrische Form/i.test(cleaned)) return "Lyrische Form";
  if (/Strophe 1/i.test(cleaned)) return "Strophe 1: Beschreibung und Deutung";
  if (/Strophe 2/i.test(cleaned)) return "Strophe 2: Beschreibung und Deutung";
  if (/Strophe 3/i.test(cleaned)) return "Strophe 3: Beschreibung und Deutung";
  if (/Aussageabsicht/i.test(cleaned)) return "Aussageabsicht des Autors";
  if (/Fazit/i.test(cleaned)) return "Fazit";
  if (/sachlich.*Präsens/i.test(cleaned)) return "Sachlichkeit und Präsens";
  if (/Textstelle/i.test(cleaned)) return "Textbelege";
  if (/Wortwiederholungen|Satzanfänge/i.test(cleaned)) return "Abwechslungsreicher Ausdruck";
  if (/Rechtschreibung|Zeichensetzung/i.test(cleaned)) return "Rechtschreibung und Zeichensetzung";
  if (/leserlich|Absätze/i.test(cleaned)) return "Leserlichkeit und Gliederung";

  return cleaned.length > 70 ? `${cleaned.slice(0, 67)}…` : cleaned;
}

function isHeading(line: string): boolean {
  return /^(Verstehensleistung|Darstellungsleistung|Inhalt|Sprache|Aufbau|Struktur|Form|Kurzkommentar)\b/i.test(
    line,
  );
}

function isCriterionStart(line: string): boolean {
  return /^(Du hast|Du schreibst|Du belegst|Du beachtest|Du formulierst)\b/i.test(line);
}

function isBullet(line: string): boolean {
  return /^[-–•]\s+/.test(line);
}

function splitIntoLogicalLines(text: string): string[] {
  const normalized = clean(text)
    .replace(/\r/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/\s+–\s+/g, "\n– ")
    .replace(/\s+•\s+/g, "\n• ")
    .replace(/\s+(Verstehensleistung)\s+/g, "\n$1\n")
    .replace(/\s+(Darstellungsleistung)\s+/g, "\n$1\n")
    .replace(/\s+(Kurzkommentar)\s+/g, "\n$1\n")
    .replace(/\s+(Du hast\s+)/g, "\n$1")
    .replace(/\s+(Du schreibst\s+)/g, "\n$1")
    .replace(/\s+(Du belegst\s+)/g, "\n$1")
    .replace(/\s+(Du beachtest\s+)/g, "\n$1")
    .replace(/\s+(Du formulierst\s+)/g, "\n$1")
    .replace(/\s+([-–•]\s*Strophe\s+\d+:)/gi, "\n$1")
    .replace(/\s+(Strophe\s+\d+:)/gi, "\n$1")
    .replace(/\s+(Konkrete Anforderungen:)/gi, "\n$1\n");

  const rawLines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const uniqueLines: string[] = [];
  const seen = new Set<string>();

  for (const line of rawLines) {
    const normalizedLine = cleanLine(line)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    if (!normalizedLine) continue;
    if (seen.has(normalizedLine)) continue;

    seen.add(normalizedLine);
    uniqueLines.push(line);
  }

  return uniqueLines;
}

function parseBullet(line: string): { label: string; erwartung: string } {
  const cleaned = cleanLine(line);
  const colonIndex = cleaned.indexOf(":");

  if (colonIndex > 0 && colonIndex < 80) {
    return {
      label: cleaned.slice(0, colonIndex).trim(),
      erwartung: cleaned.slice(colonIndex + 1).trim(),
    };
  }

  return {
    label: "",
    erwartung: cleaned,
  };
}

function elementsToExpectation(items: { label: string; erwartung: string }[]): string {
  return items
    .map((item) => [item.label, item.erwartung].filter(Boolean).join(": "))
    .filter(Boolean)
    .join("; ");
}

function parseRaster(text: string): Criterion[] {
  const lines = splitIntoLogicalLines(text);
  const criteria: Criterion[] = [];

  let bereich = "Allgemein";
  let currentTitle = "";
  let currentDescription = "";
  let currentElements: { label: string; erwartung: string }[] = [];

  function flush() {
    if (!currentTitle.trim()) return;

    const seen = new Set<string>();
    const dedupedElements: { label: string; erwartung: string }[] = [];

    for (const item of currentElements) {
      const normalized = {
        label: cleanLine(item.label),
        erwartung: cleanLine(item.erwartung),
      };

      const key = `${normalized.label}|${normalized.erwartung}`.toLowerCase();

      if (!normalized.label && !normalized.erwartung) continue;
      if (seen.has(key)) continue;

      seen.add(key);
      dedupedElements.push(normalized);
    }

    const kriterium = toTitle(currentTitle);
    const beschreibung = cleanLine(currentDescription || currentTitle);
    const erwartung = elementsToExpectation(dedupedElements);

    criteria.push({
      id: `crit-${criteria.length}`,
      bereich,
      kriterium,
      beschreibung,
      erwartung,
      expectedElements: dedupedElements,
      gewichtung: "",
      aktiv: true,
    });

    currentTitle = "";
    currentDescription = "";
    currentElements = [];
  }

  for (const rawLine of lines) {
    const line = cleanLine(rawLine);

    if (!line) continue;

    if (/^Kurzkommentar/i.test(line)) {
      flush();
      break;
    }

    if (isHeading(line)) {
      flush();

      if (/Darstellungsleistung/i.test(line)) {
        bereich = "Darstellungsleistung";
      } else if (/Verstehensleistung/i.test(line)) {
        bereich = "Verstehensleistung";
      } else {
        bereich = line;
      }

      continue;
    }

    if (/^Konkrete Anforderungen/i.test(line)) {
      continue;
    }

    if (/^Strophe\s+\d/i.test(line)) {
      flush();

      currentTitle = line;
      currentDescription = line;
      currentElements = [parseBullet(line)];

      continue;
    }

    if (isCriterionStart(line)) {
      flush();

      currentTitle = line;
      currentDescription = line;
      currentElements = [];

      continue;
    }

    if (isBullet(rawLine)) {
      const bullet = parseBullet(rawLine);

      if (/^Strophe\s+\d/i.test(bullet.label || bullet.erwartung)) {
        flush();

        currentTitle = bullet.label || bullet.erwartung;
        currentDescription = bullet.erwartung || bullet.label;
        currentElements = [bullet];

        continue;
      }

      if (!currentTitle) {
        currentTitle = bullet.label || bullet.erwartung;
        currentDescription = bullet.erwartung || bullet.label;
      }

      currentElements.push(bullet);
      continue;
    }

    if (currentTitle) {
      const cleanedDescription = cleanLine(currentDescription);

      if (!cleanedDescription.includes(line)) {
        currentDescription = cleanLine(`${currentDescription} ${line}`);
      }
    }
  }

  flush();

  return criteria.filter((criterion) => {
    const combined = `${criterion.kriterium} ${criterion.beschreibung}`.toLowerCase();

    return (
      criterion.kriterium.length > 2 &&
      !combined.includes("debug") &&
      !combined.includes("konkrete anforderungen")
    );
  });
}

export default async function handler(req: any, res: any) {
  const startedAt = Date.now();

  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return sendJson(req, res, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const parsed = BodySchema.parse(req.body ?? {});
    const text = clean(parsed.expectationHorizonText ?? "");

    if (!text) {
      return sendJson(req, res, 400, {
        ok: false,
        error: "NO_TEXT",
      });
    }

    const criteria = parseRaster(text);

    if (criteria.length === 0) {
      return sendJson(req, res, 500, {
        ok: false,
        error: "NO_CRITERIA_EXTRACTED",
        debug: {
          textLength: text.length,
          preview: text.slice(0, 1000),
          durationMs: Date.now() - startedAt,
        },
      });
    }

    return sendJson(req, res, 200, {
      ok: true,
      summary: "Bewertungsraster regelbasiert erkannt",
      criteria,
      debug: {
        parser: "rule-based",
        count: criteria.length,
        textLength: text.length,
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (error: any) {
    return sendJson(req, res, 500, {
      ok: false,
      error: "EXTRACT_CRITERIA_FAILED",
      message: error?.message ?? String(error),
      debug: {
        durationMs: Date.now() - startedAt,
      },
    });
  }
}
