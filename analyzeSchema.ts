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
  sprachliche_auffaelligkeiten: z.array(
    z.object({
      bereich: z.string(),
      beschreibung: z.string(),
      beispiel: z.string().optional(),
    })
  ),
  struktur: z.object({
    einleitung: z.object({
      status: StatusEnum,
      hinweis: z.string(),
    }),
    hauptteil: z.object({
      status: StatusEnum,
      hinweis: z.string(),
    }),
    schluss: z.object({
      status: StatusEnum,
      hinweis: z.string(),
    }),
  }),
  rasterabgleich: z.array(
    z.object({
      kriterium: z.string(),
      status: StatusEnum,
      hinweis: z.string(),
    })
  ),
  hinweise: z.array(z.string()),
});
