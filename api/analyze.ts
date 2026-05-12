// api/analyze.ts

export const config = {
  maxDuration: 60,
};

type EvalStatus = "erfüllt" | "teilweise erfüllt" | "nicht erfüllt" | "manuell prüfen";

type LinearComment = {
  id: string;
  paragraphStart: number;
  paragraphEnd: number;
  studentThought: string;
  marginComment: string;
  linkedCriterionId: string;
  linkedCriterion: string;
  linkedArea: string;
  expectedElement?: string;
  expectedElementStatus?: EvalStatus;
  status: EvalStatus;
  confidence: "hoch" | "mittel" | "niedrig";
  evidence: string;
  reviewStatus: "ungeprüft";
  analysisStatus: "success" | "partial" | "failed" | "not_processed";
  needsManualReview?: boolean;
};

function setCors(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res: any, status: number, payload: unknown) {
  setCors(res);
  res.setHeader("Content-Type", "application/json");
  return res.status(status).json(payload);
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ ]+\n/g, "\n")
    .replace(/\n[ ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanOneLine(value: unknown): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function normalizeKey(value: unknown): string {
  return cleanOneLine(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractOutputText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;

  const output = Array.isArray(response?.output) ? response.output : [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];

    for (const part of content) {
      if (typeof part?.text === "string") return part.text;
    }
  }

  return "";
}

function extractJsonObject(raw: string): any {
  const text = String(raw ?? "").trim();

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("NO_JSON_FOUND");
    }

    return JSON.parse(text.slice(start, end + 1));
  }
}

function normalizeCriteria(input: any): any[] {
  const raw = Array.isArray(input)
    ? input
    : Array.isArray(input?.criteria)
      ? input.criteria
      : [];

  const seen = new Set<string>();

  return raw
    .map((criterion: any, index: number) => {
      const bereich = cleanOneLine(
        criterion?.bereich ?? criterion?.area ?? criterion?.category ?? "Allgemein",
      );

      const kriterium = cleanOneLine(
        criterion?.kriterium ?? criterion?.criterion ?? criterion?.name ?? `Kriterium ${index + 1}`,
      );

      const beschreibung = cleanOneLine(
        criterion?.beschreibung ?? criterion?.description ?? "",
      );

      const erwartung = cleanOneLine(
        criterion?.erwartung ??
          criterion?.beobachtungshilfe ??
          criterion?.expected ??
          "",
      );

      const expectedElementsRaw =
        criterion?.expectedElements ??
        criterion?.expected_elements ??
        criterion?.unterpunkte ??
        [];

      const expectedElements = Array.isArray(expectedElementsRaw)
        ? expectedElementsRaw
            .map((item: any) => {
              if (typeof item === "string") return cleanOneLine(item);
              const label = cleanOneLine(item?.label ?? item?.name ?? item?.title ?? "");
              const text = cleanOneLine(item?.text ?? item?.erwartung ?? item?.expected ?? "");
              return [label, text].filter(Boolean).join(": ");
            })
            .filter(Boolean)
            .slice(0, 8)
        : [];

      const key = `${normalizeKey(bereich)}|${normalizeKey(kriterium)}`;

      if (!kriterium || seen.has(key)) return null;
      seen.add(key);

      return {
        id: cleanOneLine(criterion?.id) || `crit-${index}`,
        bereich,
        kriterium,
        beschreibung,
        erwartung,
        expectedElements,
      };
    })
    .filter(Boolean);
}

function splitStudentTextIntoParagraphs(studentText: string): string[] {
  const cleaned = clean(studentText);
  if (!cleaned) return [];

  const byBlankLines = cleaned
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (byBlankLines.length > 1) return byBlankLines;

  return cleaned
    .split(/\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildLinearWindows(studentText: string, maxChars = 1800): Array<{
  id: string;
  paragraphStart: number;
  paragraphEnd: number;
  text: string;
}> {
  const paragraphs = splitStudentTextIntoParagraphs(studentText);
  const windows: Array<{
    id: string;
    paragraphStart: number;
    paragraphEnd: number;
    text: string;
  }> = [];

  let current: string[] = [];
  let start = 1;

  const flush = (end: number) => {
    if (!current.length) return;

    windows.push({
      id: `abschnitt-${windows.length + 1}`,
      paragraphStart: start,
      paragraphEnd: end,
      text: current.join("\n\n"),
    });

    current = [];
  };

  for (let i = 0; i < paragraphs.length; i += 1) {
    const paragraph = paragraphs[i];
    const candidate = current.length ? `${current.join("\n\n")}\n\n${paragraph}` : paragraph;

    if (current.length && candidate.length > maxChars) {
      flush(i);
      start = i + 1;
    }

    current.push(paragraph);
  }

  flush(paragraphs.length);

  return windows;
}

function compactCriteria(criteria: any[]) {
  return criteria.slice(0, 10).map((criterion) => ({
    id: criterion.id,
    bereich: criterion.bereich,
    kriterium: criterion.kriterium,
    beschreibung: String(criterion.beschreibung ?? "").slice(0, 220),
    erwartung: String(criterion.erwartung ?? "").slice(0, 260),
    expectedElements: Array.isArray(criterion.expectedElements)
      ? criterion.expectedElements.slice(0, 5)
      : [],
  }));
}

function detectOperatorMode(assignmentText: string): string {
  const text = normalizeKey(assignmentText);

  if (/\b(darstellen|stellen sie dar|wiedergeben|fassen sie zusammen|zusammenfassen)\b/.test(text)) {
    return "darstellen";
  }

  if (/\b(analysieren|untersuchen)\b/.test(text)) {
    return "analysieren";
  }

  if (/\b(erläutern|erklären)\b/.test(text)) {
    return "erläutern";
  }

  if (/\b(erörtern|beurteilen|bewerten|stellung nehmen|diskutieren)\b/.test(text)) {
    return "erörtern";
  }

  return "unbekannt";
}

function buildPrompt(params: {
  sectionText: string;
  paragraphStart: number;
  paragraphEnd: number;
  criteria: any[];
  assignmentText: string;
  subject: string;
  gradeLevel: string;
  taskType: string;
  operatorMode: string;
}) {
  const {
    sectionText,
    paragraphStart,
    paragraphEnd,
    criteria,
    assignmentText,
    subject,
    gradeLevel,
    taskType,
    operatorMode,
  } = params;

  const operatorInstruction =
    operatorMode === "darstellen"
      ? "Die Aufgabe verlangt Darstellung/Wiedergabe. Verlange keine Wirkungsanalyse, Funktionsanalyse, eigene Bewertung oder Deutung, wenn dies nicht ausdrücklich im Kriterium steht. Bewerte sachliche Richtigkeit, Vollständigkeit, Struktur, Genauigkeit und Einordnung in den Gedankengang."
      : operatorMode === "analysieren"
        ? "Die Aufgabe verlangt Analyse. Bewerte Herausarbeitung, Funktion, Wirkung, Textbezug und fachliche Deutung."
        : operatorMode === "erläutern"
          ? "Die Aufgabe verlangt Erläuterung. Bewerte verständliche Entfaltung, Zusammenhang, Begründung und Nachvollziehbarkeit."
          : operatorMode === "erörtern"
            ? "Die Aufgabe verlangt Erörterung/Bewertung. Bewerte Position, Argumente, Begründungen, Abwägung, Gegenpositionen und Urteil."
            : "Bewerte streng nach Aufgabenstellung und Raster. Verlange keine Leistung, die weder Operator noch Kriterium fordern.";

  return `
Du formulierst lineare Randkommentare zu einem Abschnitt eines Schülertextes.

Rahmen:
Fach: ${subject || "nicht angegeben"}
Jahrgang: ${gradeLevel || "nicht angegeben"}
Aufgabenformat: ${taskType || "nicht angegeben"}
Absatzbereich: ${paragraphStart}-${paragraphEnd}
Erkannter Operator-Modus: ${operatorMode}

Aufgabenstellung:
${assignmentText || "nicht angegeben"}

Operatorgrenze:
${operatorInstruction}

Bewertungsraster:
${JSON.stringify(compactCriteria(criteria), null, 2)}

Schülertext-Abschnitt:
${sectionText}

Auftrag:
- Erzeuge 1 bis 4 konkrete Randkommentare.
- Jeder Kommentar bezieht sich auf einen konkreten Schülergedanken.
- Jeder Kommentar nennt einen passenden Rasterbezug.
- Jeder Kommentar enthält einen kurzen Textbeleg.
- Verwende wertende Formulierungen wie:
  „überwiegend nachvollziehbar dargestellt“, „im Wesentlichen schlüssig“, „hinreichend nachvollziehbar dargestellt“, „teilweise unpräzise“, „nur ansatzweise differenziert“, „treffend herausgearbeitet“, „schlüssig begründet“.
- Bei Darstellung nicht „Analyse/Wirkung/Funktion fehlt“ schreiben, wenn das nicht verlangt ist.
- Keine Gutachtenprosa.
- Keine pauschalen Sätze wie „Das Kriterium ist erfüllt“.

Antworte ausschließlich als JSON:

{
  "comments": [
    {
      "studentThought": "konkreter Schülergedanke",
      "marginComment": "wertender Randkommentar, 1–2 Sätze",
      "linkedCriterionId": "id aus dem Raster",
      "linkedCriterion": "Name des Rasterkriteriums",
      "linkedArea": "Bereich",
      "expectedElement": "passendes Erwartungselement aus dem Raster",
      "expectedElementStatus": "erfüllt | teilweise erfüllt | nicht erfüllt",
      "status": "erfüllt | teilweise erfüllt | nicht erfüllt",
      "confidence": "hoch | mittel | niedrig",
      "evidence": "kurzer Textbeleg aus dem Schülertext"
    }
  ]
}
`.trim();
}

function normalizeStatus(value: unknown): EvalStatus {
  const raw = normalizeKey(value);

  if (raw.includes("manuell")) return "manuell prüfen";

  if (
    raw.includes("nicht") ||
    raw.includes("kaum") ||
    raw.includes("fehlt") ||
    raw.includes("unzureichend")
  ) {
    return "nicht erfüllt";
  }

  if (
    raw.includes("teilweise") ||
    raw.includes("ansatz") ||
    raw.includes("eingeschränkt") ||
    raw.includes("zum teil")
  ) {
    return "teilweise erfüllt";
  }

  if (raw.includes("erfüllt") || raw.includes("überzeugend") || raw.includes("klar")) {
    return "erfüllt";
  }

  return "teilweise erfüllt";
}

function normalizeConfidence(value: unknown): "hoch" | "mittel" | "niedrig" {
  const raw = normalizeKey(value);
  if (raw.includes("hoch")) return "hoch";
  if (raw.includes("mittel")) return "mittel";
  return "niedrig";
}

function normalizeLinearComments(params: {
  rawComments: any[];
  criteria: any[];
  paragraphStart: number;
  paragraphEnd: number;
  offset: number;
}): LinearComment[] {
  const { rawComments, criteria, paragraphStart, paragraphEnd, offset } = params;

  const criteriaById = new Map(criteria.map((criterion) => [String(criterion.id), criterion]));

  return rawComments
    .map((item, index) => {
      const requestedId = cleanOneLine(item?.linkedCriterionId);
      const criterion =
        criteriaById.get(requestedId) ??
        criteria.find(
          (candidate) =>
            normalizeKey(candidate.kriterium) === normalizeKey(item?.linkedCriterion),
        ) ??
        criteria[0];

      if (!criterion) return null;

      const marginComment = cleanOneLine(item?.marginComment);
      const studentThought = cleanOneLine(item?.studentThought);
      const evidence = cleanOneLine(item?.evidence);

      if (!marginComment || !studentThought) return null;

      const status = normalizeStatus(item?.status);

      return {
        id: `lc-${offset + index + 1}`,
        paragraphStart,
        paragraphEnd,
        studentThought,
        marginComment,
        linkedCriterionId: criterion.id,
        linkedCriterion: criterion.kriterium,
        linkedArea: criterion.bereich,
        expectedElement: cleanOneLine(item?.expectedElement),
        expectedElementStatus: normalizeStatus(item?.expectedElementStatus ?? status),
        status,
        confidence: normalizeConfidence(item?.confidence),
        evidence: evidence || "Textbeleg muss manuell geprüft werden.",
        reviewStatus: "ungeprüft",
        analysisStatus: "success",
      };
    })
    .filter(Boolean) as LinearComment[];
}

async function callOpenAi(params: {
  apiKey: string;
  prompt: string;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        max_output_tokens: 1500,
        input: params.prompt,
        text: {
          format: {
            type: "json_object",
          },
        },
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`OPENAI_ERROR_${response.status}: ${raw.slice(0, 1000)}`);
    }

    const parsed = JSON.parse(raw);
    const outputText = extractOutputText(parsed);
    const json = extractJsonObject(outputText);

    return {
      json,
      usage: parsed?.usage ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildResultsFromLinearComments(criteria: any[], comments: LinearComment[]) {
  return criteria.map((criterion) => {
    const related = comments.filter((comment) => comment.linkedCriterionId === criterion.id);

    if (!related.length) {
      return {
        criterionId: criterion.id,
        criterion: criterion.kriterium,
        status: "manuell prüfen",
        confidence: "niedrig",
        comment: "Dieses Kriterium wurde in den linearen Randkommentaren noch nicht belastbar erfasst.",
        textbezug: "Manuelle Prüfung erforderlich.",
        textbeleg: "Manuelle Prüfung erforderlich.",
        evidence: "Manuelle Prüfung erforderlich.",
        quote: "Manuelle Prüfung erforderlich.",
      };
    }

    const fulfilled = related.filter((comment) => comment.status === "erfüllt").length;
    const partial = related.filter((comment) => comment.status === "teilweise erfüllt").length;
    const failed = related.filter((comment) => comment.status === "nicht erfüllt").length;

    const status =
      fulfilled >= partial && fulfilled >= failed
        ? "erfüllt"
        : failed > fulfilled + partial
          ? "nicht erfüllt"
          : "teilweise erfüllt";

    const evidence = related
      .map((comment) => comment.evidence)
      .filter(Boolean)
      .slice(0, 3)
      .join(" | ");

    return {
      criterionId: criterion.id,
      criterion: criterion.kriterium,
      status,
      confidence: related.some((comment) => comment.confidence === "hoch")
        ? "hoch"
        : related.some((comment) => comment.confidence === "mittel")
          ? "mittel"
          : "niedrig",
      comment: related
        .map((comment) => comment.marginComment)
        .slice(0, 2)
        .join(" "),
      textbezug: evidence,
      textbeleg: evidence,
      evidence,
      quote: evidence,
    };
  });
}

export default async function handler(req: any, res: any) {
  const startedAt = Date.now();

  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, {
      ok: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return sendJson(res, 500, {
        ok: false,
        error: "MISSING_API_KEY",
      });
    }

    const body = req.body ?? {};

    const studentText =
      clean(body.studentText) ||
      clean(body.cleanedStudentText) ||
      clean(body.analysisText) ||
      clean(body.text) ||
      clean(body.transcription) ||
      clean(body.transcript) ||
      clean(body.klausurText);

    const criteria =
      normalizeCriteria(body.criteria).length > 0
        ? normalizeCriteria(body.criteria)
        : normalizeCriteria(body.raster);

    const assignmentText = clean(body.assignmentText ?? body.aufgabenstellung ?? "");
    const subject = cleanOneLine(body.subject ?? body.fach ?? "");
    const gradeLevel = cleanOneLine(body.gradeLevel ?? body.jahrgang ?? "");
    const taskType = cleanOneLine(body.taskType ?? body.aufgabenformat ?? body.aufgabentyp ?? "");

    if (!studentText || criteria.length === 0) {
      return sendJson(res, 400, {
        ok: false,
        error: "MISSING_INPUT",
        message: "Schülertext oder Bewertungsraster fehlt.",
        debug: {
          receivedKeys: Object.keys(body),
          hasStudentText: Boolean(studentText),
          studentTextLength: studentText.length,
          criteriaCount: criteria.length,
        },
      });
    }

    const windows = buildLinearWindows(studentText, 1800);

    if (windows.length === 0) {
      return sendJson(res, 400, {
        ok: false,
        error: "NO_TEXT_WINDOWS",
        message: "Es konnten keine Textabschnitte gebildet werden.",
        debug: {
          studentTextLength: studentText.length,
          studentTextPreview: studentText.slice(0, 300),
        },
      });
    }

    const operatorMode = detectOperatorMode(assignmentText);
    const linearComments: LinearComment[] = [];
    const usages: any[] = [];
    let processedWindows = 0;
    let failedWindows = 0;
    let skippedWindows = 0;

    for (const window of windows) {
      const elapsed = Date.now() - startedAt;

      if (elapsed > 45_000) {
        skippedWindows += 1;

        linearComments.push({
          id: `lc-${linearComments.length + 1}`,
          paragraphStart: window.paragraphStart,
          paragraphEnd: window.paragraphEnd,
          studentThought: "Abschnitt wurde aus Zeitgründen nicht automatisch ausgewertet.",
          marginComment:
            "Dieser Abschnitt wurde aus Zeitgründen nicht automatisch ausgewertet und muss manuell geprüft werden.",
          linkedCriterionId: criteria[0]?.id ?? "manual",
          linkedCriterion: criteria[0]?.kriterium ?? "Manuelle Prüfung",
          linkedArea: criteria[0]?.bereich ?? "Manuelle Prüfung",
          expectedElement: "",
          expectedElementStatus: "manuell prüfen",
          status: "manuell prüfen",
          confidence: "niedrig",
          evidence: "Manuelle Prüfung erforderlich.",
          reviewStatus: "ungeprüft",
          analysisStatus: "not_processed",
          needsManualReview: true,
        });

        continue;
      }

      try {
        const call = await callOpenAi({
          apiKey,
          timeoutMs: 13_000,
          prompt: buildPrompt({
            sectionText: window.text,
            paragraphStart: window.paragraphStart,
            paragraphEnd: window.paragraphEnd,
            criteria,
            assignmentText,
            subject,
            gradeLevel,
            taskType,
            operatorMode,
          }),
        });

        usages.push(call.usage);

        const rawComments = Array.isArray(call.json?.comments) ? call.json.comments : [];

        const normalized = normalizeLinearComments({
          rawComments,
          criteria,
          paragraphStart: window.paragraphStart,
          paragraphEnd: window.paragraphEnd,
          offset: linearComments.length,
        });

        if (normalized.length > 0) {
          linearComments.push(...normalized);
          processedWindows += 1;
        } else {
          failedWindows += 1;

          linearComments.push({
            id: `lc-${linearComments.length + 1}`,
            paragraphStart: window.paragraphStart,
            paragraphEnd: window.paragraphEnd,
            studentThought: "Abschnitt muss manuell geprüft werden.",
            marginComment:
              "Für diesen Abschnitt wurde kein belastbarer automatischer Randkommentar erzeugt; die Stelle muss manuell geprüft werden.",
            linkedCriterionId: criteria[0]?.id ?? "manual",
            linkedCriterion: criteria[0]?.kriterium ?? "Manuelle Prüfung",
            linkedArea: criteria[0]?.bereich ?? "Manuelle Prüfung",
            expectedElement: "",
            expectedElementStatus: "manuell prüfen",
            status: "manuell prüfen",
            confidence: "niedrig",
            evidence: "Manuelle Prüfung erforderlich.",
            reviewStatus: "ungeprüft",
            analysisStatus: "failed",
            needsManualReview: true,
          });
        }
      } catch (error: any) {
        failedWindows += 1;

        linearComments.push({
          id: `lc-${linearComments.length + 1}`,
          paragraphStart: window.paragraphStart,
          paragraphEnd: window.paragraphEnd,
          studentThought: "Abschnitt muss manuell geprüft werden.",
          marginComment:
            "Für diesen Abschnitt wurde kein belastbarer automatischer Randkommentar erzeugt; die Stelle muss manuell geprüft werden.",
          linkedCriterionId: criteria[0]?.id ?? "manual",
          linkedCriterion: criteria[0]?.kriterium ?? "Manuelle Prüfung",
          linkedArea: criteria[0]?.bereich ?? "Manuelle Prüfung",
          expectedElement: "",
          expectedElementStatus: "manuell prüfen",
          status: "manuell prüfen",
          confidence: "niedrig",
          evidence: "Manuelle Prüfung erforderlich.",
          reviewStatus: "ungeprüft",
          analysisStatus: "failed",
          needsManualReview: true,
        });
      }
    }

    const coverage = {
      fullTextProcessed: processedWindows === windows.length,
      totalWindows: windows.length,
      processedWindows,
      failedWindows,
      skippedWindows,
    };

    const results = buildResultsFromLinearComments(criteria, linearComments);

    return sendJson(res, 200, {
      ok: true,
      linearComments,
      results,
      summary: "Basisanalyse abgeschlossen.",
      coverage,
      usage: usages,
      debug: {
        method: "minimal-linear-analysis",
        operatorMode,
        criteriaCount: criteria.length,
        totalWindows: windows.length,
        linearCommentCount: linearComments.length,
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (error: any) {
    console.error("ANALYZE_FATAL", error);

    return sendJson(res, 500, {
      ok: false,
      error: "SERVER_ERROR",
      message: error?.message ?? String(error),
    });
  }
}
