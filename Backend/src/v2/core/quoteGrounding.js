/**
 * Pure function for quote grounding verification.
 * Validates that an LLM-provided evidenceQuote genuinely appears in the source evidence chunks.
 *
 * Enforces:
 * 1. Maximum quote length of 25 words.
 * 2. Minimum quote length of 3 tokens for 'yes' or 'partial' verdicts.
 * 3. Exact normalized substring match OR semi-global edit-distance ratio >= threshold (default 0.90).
 * 4. Grounding strictly against each chunk's `text` field (exact slice), never against context.
 * 5. Returns groundedChunkId and character offsets [charStart, charEnd] for UI highlighting.
 * 6. If verdict is 'yes' or 'partial' but quote is ungrounded or empty, forces verdict to 'no'.
 */

function computeSemiGlobalAlignment(pattern, text) {
  const m = pattern.length;
  const n = text.length;
  if (m === 0 || n === 0) {
    return { distance: Math.max(m, n), start: 0, end: 0, length: 0 };
  }

  // dp[i][j] where i is pattern index (0..m), j is text index (0..n)
  // Semi-global: dp[0][j] = 0 allows pattern to match any substring of text with 0 start penalty
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

  for (let i = 1; i <= m; i++) {
    dp[i][0] = i;
  }

  for (let i = 1; i <= m; i++) {
    const pChar = pattern[i - 1];
    for (let j = 1; j <= n; j++) {
      const cost = pChar === text[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,       // deletion from pattern
        dp[i][j - 1] + 1,       // insertion into pattern
        dp[i - 1][j - 1] + cost // match / substitution
      );
    }
  }

  // Find best end index in text (minimum distance in last row)
  let bestDist = Infinity;
  let bestEnd = 0;
  for (let j = 1; j <= n; j++) {
    if (dp[m][j] < bestDist) {
      bestDist = dp[m][j];
      bestEnd = j;
    }
  }

  // Backtrack to find start index in text
  let i = m;
  let j = bestEnd;
  while (i > 0 && j > 0) {
    const cost = pattern[i - 1] === text[j - 1] ? 0 : 1;
    if (dp[i][j] === dp[i - 1][j - 1] + cost) {
      i--;
      j--;
    } else if (dp[i][j] === dp[i - 1][j] + 1) {
      i--;
    } else if (dp[i][j] === dp[i][j - 1] + 1) {
      j--;
    } else {
      break;
    }
  }

  const bestStart = j;
  const matchLen = bestEnd - bestStart;

  return {
    distance: bestDist,
    start: bestStart,
    end: bestEnd,
    length: matchLen,
  };
}

/**
 * Grounds a quote against evidence chunks.
 *
 * @param {object} params
 * @param {string} params.quote
 * @param {Array<{ id: string, text: string }>} params.chunks
 * @param {'yes'|'partial'|'no'} params.verdict
 * @param {number} [params.threshold=0.90]
 * @returns {{
 *   isGrounded: boolean,
 *   quoteUngrounded: boolean,
 *   finalVerdict: 'yes'|'partial'|'no',
 *   groundedChunkId: string|null,
 *   charStart: number|null,
 *   charEnd: number|null
 * }}
 */
function groundQuote({ quote = '', chunks = [], verdict = 'no', threshold = 0.90 }) {
  const rawQuote = typeof quote === 'string' ? quote.trim() : '';
  const tokens = rawQuote.length > 0 ? rawQuote.split(/\s+/).filter(Boolean) : [];

  // Allowed empty quote for 'no' verdict
  if (verdict === 'no' && tokens.length === 0) {
    return {
      isGrounded: true,
      quoteUngrounded: false,
      finalVerdict: 'no',
      groundedChunkId: null,
      charStart: null,
      charEnd: null,
    };
  }

  // Rule: Enforce 25-word maximum
  if (tokens.length > 25) {
    return {
      isGrounded: false,
      quoteUngrounded: true,
      finalVerdict: 'no',
      groundedChunkId: null,
      charStart: null,
      charEnd: null,
    };
  }

  // Rule: For 'yes' or 'partial', require at least 3 tokens
  if ((verdict === 'yes' || verdict === 'partial') && tokens.length < 3) {
    return {
      isGrounded: false,
      quoteUngrounded: true,
      finalVerdict: 'no',
      groundedChunkId: null,
      charStart: null,
      charEnd: null,
    };
  }

  const normQuote = rawQuote.normalize('NFKC').toLowerCase();

  let bestMatch = null;

  for (const chunk of chunks) {
    if (!chunk || typeof chunk.text !== 'string' || chunk.text.length === 0) {
      continue;
    }

    const chunkText = chunk.text;
    const normChunkText = chunkText.normalize('NFKC').toLowerCase();

    // 1. Fast path: exact substring match (case-sensitive or normalized)
    const exactIdx = chunkText.indexOf(rawQuote);
    if (exactIdx !== -1) {
      return {
        isGrounded: true,
        quoteUngrounded: false,
        finalVerdict: verdict,
        groundedChunkId: chunk.id,
        charStart: exactIdx,
        charEnd: exactIdx + rawQuote.length,
      };
    }

    const normExactIdx = normChunkText.indexOf(normQuote);
    if (normExactIdx !== -1) {
      return {
        isGrounded: true,
        quoteUngrounded: false,
        finalVerdict: verdict,
        groundedChunkId: chunk.id,
        charStart: normExactIdx,
        charEnd: normExactIdx + normQuote.length,
      };
    }

    // 2. Semi-global character-level edit distance ratio against sliding window
    const align = computeSemiGlobalAlignment(normQuote, normChunkText);
    const denom = Math.max(normQuote.length, align.length);
    const ratio = denom > 0 ? 1 - align.distance / denom : 0;

    if (ratio >= threshold) {
      if (!bestMatch || ratio > bestMatch.ratio) {
        bestMatch = {
          chunkId: chunk.id,
          ratio,
          start: align.start,
          end: align.end,
        };
      }
    }
  }

  if (bestMatch) {
    return {
      isGrounded: true,
      quoteUngrounded: false,
      finalVerdict: verdict,
      groundedChunkId: bestMatch.chunkId,
      charStart: bestMatch.start,
      charEnd: bestMatch.end,
    };
  }

  // Not grounded: force verdict 'no' and set quoteUngrounded: true if original was yes/partial
  const isUngrounded = verdict === 'yes' || verdict === 'partial';
  return {
    isGrounded: false,
    quoteUngrounded: isUngrounded,
    finalVerdict: 'no',
    groundedChunkId: null,
    charStart: null,
    charEnd: null,
  };
}

module.exports = {
  groundQuote,
  computeSemiGlobalAlignment,
};
