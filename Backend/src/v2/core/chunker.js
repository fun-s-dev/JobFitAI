const crypto = require('node:crypto');

const SECTION_HEADERS = [
  { pattern: /^(?:(?:professional\s+)?summary|objective|profile)$/i, name: 'Summary' },
  { pattern: /^(?:(?:work\s+|professional\s+)?experience|employment(?:\s+history)?)$/i, name: 'Experience' },
  { pattern: /^(?:(?:technical\s+|personal\s+)?projects)$/i, name: 'Projects' },
  { pattern: /^(?:(?:technical\s+)?skills)$/i, name: 'Skills' },
  { pattern: /^(?:education|academic(?:\s+background)?)$/i, name: 'Education' },
  { pattern: /^(?:certifications?|licenses?)$/i, name: 'Certifications' },
  { pattern: /^(?:awards|honors|publications)$/i, name: 'Awards' },
];

/**
 * Checks if a trimmed line is a top-level section header.
 */
function matchSectionHeader(line) {
  const cleaned = line.replace(/^#+\s*/, '').replace(/[:\-_]+$/, '').trim();
  for (const { pattern, name } of SECTION_HEADERS) {
    if (pattern.test(cleaned)) {
      return name;
    }
  }
  return null;
}

/**
 * Checks if a line in Experience or Projects appears to be an organization / role header
 * (e.g., "Acme Corp", "Beta Technologies | Software Engineer (2018 – 2021)").
 */
function isSubSectionHeader(line, currentSection) {
  if (currentSection !== 'Experience' && currentSection !== 'Projects') {
    return false;
  }
  if (line.startsWith('-') || line.length > 90 || /[.!?]$/.test(line)) {
    return false;
  }
  return (
    line.includes('|') ||
    line.includes('—') ||
    /\b(?:20\d\d|19\d\d|present)\b/i.test(line) ||
    /^[A-Z0-9][A-Za-z0-9\s,&.-]{2,50}$/.test(line)
  );
}

/**
 * Pure function: segments normalized text into contextual chunks.
 *
 * Guarantees:
 * 1. normalizedText.slice(chunk.start, chunk.end) === chunk.text
 * 2. chunk.id includes source (e.g. 'resume_chunk_0' or 'self_description_chunk_0')
 * 3. chunk.embedText = context ? `${context} ${text}` : text
 * 4. chunk.hash = sha256(chunk.embedText)
 * 5. Never emits empty chunks
 * 6. Sentences longer than maxChars (default 400) are split at word boundaries
 *
 * @param {string} normalizedText - The normalized source text
 * @param {object} options
 * @param {'resume'|'self_description'} [options.source='resume']
 * @param {number} [options.maxChars=400]
 * @param {number} [options.maxSentences=3]
 * @returns {Array<object>} Array of Chunk objects
 */
function chunkText(normalizedText, {
  source = 'resume',
  maxChars = 400,
  maxSentences = 3,
} = {}) {
  if (typeof normalizedText !== 'string' || !normalizedText.trim()) {
    return [];
  }

  const chunks = [];
  let currentSection = source === 'self_description' ? 'Self-Description' : 'Other';
  let currentSubSection = '';
  let chunkIndex = 0;

  // Split lines while tracking character positions in normalizedText
  const lines = [];
  let lineStart = 0;
  const rawLines = normalizedText.split('\n');

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];
    const lineEnd = lineStart + rawLine.length;
    lines.push({
      text: rawLine,
      start: lineStart,
      end: lineEnd,
      trimmed: rawLine.trim(),
    });
    // +1 for the \n delimiter
    lineStart = lineEnd + 1;
  }

  // Helper to add a chunk ensuring exact slice invariant
  function addChunk(start, end, section, subSection) {
    if (start >= end) return;
    const textSlice = normalizedText.slice(start, end);
    if (!textSlice.trim()) return;

    let context = '';
    if (section && section !== 'Other') {
      if (subSection) {
        context = `${section} > ${subSection}:`;
      } else {
        context = `${section}:`;
      }
    } else if (subSection) {
      context = `${subSection}:`;
    }

    const embedText = context ? `${context} ${textSlice}` : textSlice;
    const hash = crypto.createHash('sha256').update(embedText).digest('hex');

    chunks.push({
      id: `${source}_chunk_${chunkIndex++}`,
      source,
      section,
      context,
      text: textSlice,
      embedText,
      start,
      end,
      hash,
    });
  }

  // Helper to split a long span into chunks <= maxChars at word boundaries
  function splitSpanAtWordBoundaries(spanStart, spanEnd, section, subSection) {
    let cursor = spanStart;
    while (cursor < spanEnd) {
      // Find non-whitespace start
      while (cursor < spanEnd && /\s/.test(normalizedText[cursor])) {
        cursor++;
      }
      if (cursor >= spanEnd) break;

      const remainingLength = spanEnd - cursor;
      if (remainingLength <= maxChars) {
        let chunkEnd = spanEnd;
        while (chunkEnd > cursor && /\s/.test(normalizedText[chunkEnd - 1])) {
          chunkEnd--;
        }
        addChunk(cursor, chunkEnd, section, subSection);
        break;
      }

      const targetEnd = cursor + maxChars;
      let cutPoint = -1;

      // Scan backwards from targetEnd to find whitespace
      for (let p = targetEnd; p > cursor; p--) {
        if (/\s/.test(normalizedText[p])) {
          cutPoint = p;
          break;
        }
      }

      if (cutPoint === -1) {
        cutPoint = targetEnd;
      }

      let chunkEnd = cutPoint;
      while (chunkEnd > cursor && /\s/.test(normalizedText[chunkEnd - 1])) {
        chunkEnd--;
      }

      addChunk(cursor, chunkEnd, section, subSection);
      cursor = cutPoint + 1;
    }
  }

  // Active buffer of items within current section/subsection
  let bufferItems = []; // Array of { start, end, text, isBullet }

  function flushBuffer() {
    if (bufferItems.length === 0) return;

    let currentChunkStart = bufferItems[0].start;
    let currentChunkEnd = bufferItems[0].end;
    let sentenceCount = 1;

    for (let i = 1; i < bufferItems.length; i++) {
      const item = bufferItems[i];
      const combinedSpanLength = item.end - currentChunkStart;

      // Group if within maxSentences, within maxChars, and not a separate bullet item unless both are short
      const canGroup = sentenceCount < maxSentences && combinedSpanLength <= maxChars;

      if (canGroup) {
        currentChunkEnd = item.end;
        sentenceCount++;
      } else {
        addChunk(currentChunkStart, currentChunkEnd, currentSection, currentSubSection);
        currentChunkStart = item.start;
        currentChunkEnd = item.end;
        sentenceCount = 1;
      }
    }

    addChunk(currentChunkStart, currentChunkEnd, currentSection, currentSubSection);
    bufferItems = [];
  }

  for (const line of lines) {
    if (!line.trimmed) {
      continue;
    }

    // Check if line is a section header
    const detectedSection = matchSectionHeader(line.trimmed);
    if (detectedSection) {
      flushBuffer();
      currentSection = detectedSection;
      currentSubSection = '';
      continue;
    }

    // Check if line is a subsection header
    if (isSubSectionHeader(line.trimmed, currentSection)) {
      flushBuffer();
      currentSubSection = line.trimmed.replace(/[:\-_]+$/, '').trim();
      continue;
    }

    // Content line: determine exact character offsets without boundary whitespace
    const leadingWhitespaceLen = line.text.match(/^\s*/)[0].length;
    const trailingWhitespaceLen = line.text.match(/\s*$/)[0].length;
    const contentStart = line.start + leadingWhitespaceLen;
    const contentEnd = line.end - trailingWhitespaceLen;

    if (contentStart >= contentEnd) {
      continue;
    }

    const contentLen = contentEnd - contentStart;
    if (contentLen > maxChars) {
      flushBuffer();
      splitSpanAtWordBoundaries(contentStart, contentEnd, currentSection, currentSubSection);
    } else {
      // If line is a bullet point, it's typically an independent evidence statement
      const isBullet = line.trimmed.startsWith('-');
      if (isBullet && bufferItems.length > 0) {
        // If current buffer already has a bullet or > 1 item, flush before starting new bullet
        flushBuffer();
      }

      bufferItems.push({
        start: contentStart,
        end: contentEnd,
        text: normalizedText.slice(contentStart, contentEnd),
        isBullet,
      });
    }
  }

  flushBuffer();

  return chunks;
}

module.exports = {
  chunkText,
};
