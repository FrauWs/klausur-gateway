function splitIntoLogicalLines(text: string): string[] {
  const normalized = clean(text)
    .replace(/\r/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/\s+–\s+/g, "\n– ")
    .replace(/\s+•\s+/g, "\n• ")

    // Überschriften
    .replace(/\s+(Verstehensleistung)\s+/g, "\n$1\n")
    .replace(/\s+(Darstellungsleistung)\s+/g, "\n$1\n")
    .replace(/\s+(Kurzkommentar)\s+/g, "\n$1\n")

    // neue Kriterien
    .replace(/\s+(Du hast\s+)/g, "\n$1")
    .replace(/\s+(Du schreibst\s+)/g, "\n$1")
    .replace(/\s+(Du belegst\s+)/g, "\n$1")
    .replace(/\s+(Du beachtest\s+)/g, "\n$1")
    .replace(/\s+(Du formulierst\s+)/g, "\n$1")

    // Strophen
    .replace(/\s+(Strophe\s+\d+:)/gi, "\n$1")

    // Konkrete Anforderungen separieren
    .replace(/\s+(Konkrete Anforderungen:)/gi, "\n$1\n");

  const rawLines = normalized
    .split(/\n+/)
    .map((line) => cleanLine(line))
    .filter(Boolean);

  const uniqueLines: string[] = [];
  const seen = new Set<string>();

  for (const line of rawLines) {
    const normalizedLine = line
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    if (seen.has(normalizedLine)) {
      continue;
    }

    seen.add(normalizedLine);
    uniqueLines.push(line);
  }

  return uniqueLines;
}
