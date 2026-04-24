// sanitizeOutput.ts

export function sanitizeOutput(text: string): string {
  const forbidden = [
    /\b\d+\s*(Punkte|von)\b/gi,
    /\bNote\b/gi,
    /\bgut\b/gi,
    /\bschlecht\b/gi,
    /\bstark\b/gi,
    /\bschwach\b/gi,
  ];

  let cleaned = text;

  forbidden.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, "");
  });

  return cleaned;
}
