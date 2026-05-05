// analyzeSchema.ts

import { z } from "zod";

export const StatusEnum = z.enum([
  "klar vorhanden",
  "weitgehend vorhanden",
  "teilweise vorhanden",
  "kaum erkennbar",
  "nicht erkennbar",
]);

export const AnalyzeResponseSchema = z.object({
  struktur: z.object({
    einleitung: z.object({
      status: StatusEnum,
      hinweis: z.string(),
      textEvidence: z.string().optional(),
    }),
    interpretationshypothese: z.object({
      status: StatusEnum,
      hinweis: z.string(),
      textEvidence: z.string().optional(),
      position_ok: z.boolean(), // wichtig für Reihenfolge
    }),
    hauptteil: z.object({
      status: StatusEnum,
      hinweis: z.string(),
    }),
    analyseform: z.object({
      typ: z.enum(["linear", "aspektorientiert", "unklar"]),
      konsistent: z.boolean(),
      hinweis: z.string(),
    }),
    schluss: z.object({
      status: StatusEnum,
      hinweis: z.string(),
      textEvidence: z.string().optional(),
      unterscheidung_zur_hypothese: z.string(), // trennt Hypothese vs Fazit
    }),
  }),

  rasterabgleich: z.array(
    z.object({
      kriterium: z.string(),
      status: StatusEnum,
      hinweis: z.string(),
      textEvidence: z.string().optional(), // 🔥 DAS hat dir gefehlt
      confidence: z.enum(["hoch", "mittel", "niedrig"]),
    })
  ),

  sprachliche_auffaelligkeiten: z.array(
    z.object({
      bereich: z.string(),
      beschreibung: z.string(),
      beispiel: z.string().optional(),
    })
  ),

  meta: z.object({
    textbelege_verwendet: z.boolean(),
    struktur_erkannt: z.boolean(),
    analyseform_erkannt: z.boolean(),
  }),

  hinweise: z.array(z.string()),
});
