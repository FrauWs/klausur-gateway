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
  return /^(Verstehensleistung|Darstellungsleistung|Inhalt|Sprache|Aufbau|Struktur|Form|Kurzkommentar)/i.test(
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
  return clean(text)
    .replace(/\s+–\s+/g, "\n– ")
    .replace(/\s+•\s+/g, "\n• ")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseBullet(line: string): { label: string; erwartung: string } {
  const cleaned = cleanLine(line);
  const colonIndex = cleaned.indexOf(":");

  if (colonIndex > 0 && colonIndex < 60) {
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

function pushCriterion(
  criteria: Criterion[],
  bereich: string,
  titleSource: string,
  descriptionSource: string,
  elements: { label: string; erwartung: string }[],
) {
  const kriterium = toTitle(titleSource);
  const erwartung = elements.map((item) => [item.label, item.erwartung].filter(Boolean).join(": ")).join("; ");

  criteria.push({
    id: `crit-${criteria.length}`,
    bereich,
    kriterium,
    beschreibung: cleanLine(descriptionSource || titleSource),
    erwartung,
    expectedElements: elements,
    gewichtung: "",
    aktiv: true,
  });
}

function parseRaster(text: string): Criterion[] {
  const lines = splitIntoLogicalLines(text);
  const criteria: Criterion[] = [];

  let bereich = "Allgemein";
  let currentTitle = "";
  let currentDescription = "";
  let currentElements: { label: string; erwartung: string }[] = [];

  function flush() {
    if (!currentTitle) return;
    pushCriterion(criteria, bereich, currentTitle, currentDescription, currentElements);
    currentTitle = "";
    currentDescription = "";
    currentElements = [];
  }

  for (const line of lines) {
    const cleaned = cleanLine(line);
    if (!cleaned) continue;

    if (/^Kurzkommentar/i.test(cleaned)) {
      flush();
      break;
    }

    if (isHeading(cleaned)) {
      flush();
      if (/Darstellungsleistung/i.test(cleaned)) bereich = "Darstellungsleistung";
      else if (/Verstehensleistung/i.test(cleaned)) bereich = "Verstehensleistung";
      else bereich = cleaned;
      continue;
    }

    if (/^Strophe\s+\d/i.test(cleaned)) {
      flush();
      currentTitle = cleaned;
      currentDescription = cleaned;
      currentElements = [parseBullet(cleaned)];
      continue;
    }

    if (isCriterionStart(cleaned)) {
      flush();
      currentTitle = cleaned;
      currentDescription = cleaned;
      currentElements = [];
      continue;
    }

    if (isBullet(line)) {
      const element = parseBullet(line);

      if (/^Strophe\s+\d/i.test(element.label || element.erwartung)) {
        flush();
        currentTitle = element.label || element.erwartung;
        currentDescription = element.erwartung;
        currentElements = [element];
        continue;
      }

      if (!currentTitle) {
        currentTitle = element.label || element.erwartung;
        currentDescription = element.erwartung;
      }

      currentElements.push(element);
      continue;
    }

    if (currentTitle) {
      currentDescription = `${currentDescription} ${cleaned}`.trim();
    }
  }

  flush();

  return criteria.filter((criterion) => criterion.kriterium && criterion.beschreibung);
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
