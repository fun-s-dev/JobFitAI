/**
 * Pure function: normalizes raw resume text extracted from PDFs or text inputs.
 *
 * Steps:
 * 1. Unicode NFKC normalization (expands ligatures like 'fi', normalizes accents/symbols).
 * 2. Re-joins words hyphenated across line breaks (e.g. 'micro-\nservices' -> 'microservices').
 * 3. Replaces bullet glyphs (•, ▪, ●, etc.) with '-' ONLY at the start of a line.
 *    Leaves mid-line en/em dashes intact (e.g. in date ranges like '2022 – 2024').
 * 4. Collapses horizontal and vertical whitespace typical of pdf-parse outputs.
 */
function normalizeText(text) {
  if (typeof text !== 'string' || !text) {
    return '';
  }

  // 1. Unicode NFKC normalization
  let normalized = text.normalize('NFKC');

  // Normalize Windows CRLF to standard LF
  normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 2. Re-join words hyphenated across line breaks (e.g. 'micro-\nservices' -> 'microservices')
  normalized = normalized.replace(/(\b[a-zA-Z]+)-\s*\n\s*([a-zA-Z]+\b)/g, '$1$2');

  // 3. Replace bullet glyphs ONLY at the start of a line with '- '
  // Matches line-start whitespace followed by bullet characters: •, ▪, ●, ◆, ⁃, ◦, ‣
  normalized = normalized.replace(/^[ \t]*[•▪●◆⁃◦‣][ \t]*/gm, '- ');

  // 4. Clean line-by-line whitespace
  const lines = normalized.split('\n');
  const cleanedLines = lines.map((line) => {
    // Collapse runs of spaces/tabs to a single space, trim margins
    return line.replace(/[ \t]+/g, ' ').trim();
  });

  // Re-join and collapse multiple blank lines (3+ newlines -> 2 newlines)
  let result = cleanedLines.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

module.exports = {
  normalizeText,
};
