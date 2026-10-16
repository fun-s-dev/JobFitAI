#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { normalizeText } = require('../src/v2/core/normalizeText');
const { chunkText } = require('../src/v2/core/chunker');
const { extractNumericTokens, extractTechTokens } = require('../src/v2/core/coverageCheck');
const { normalizeSkill } = require('../src/v2/core/skillNormalizer');
const { createLlmClient } = require('../src/v2/adapters/llmClient');
const { createEvidenceMatchingService } = require('../src/v2/services/evidenceMatching.service');
const { createEntailmentService } = require('../src/v2/services/entailment.service');
const { getCfg } = require('../src/v2/config/env');

async function extractFileText(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  const fileBuffer = fs.readFileSync(filePath);
  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    if (typeof pdfParse === 'function') {
      const data = await pdfParse(fileBuffer);
      return data.text;
    } else if (pdfParse.PDFParse) {
      const parser = new pdfParse.PDFParse(Uint8Array.from(fileBuffer));
      const resumeContent = await parser.getText();
      return resumeContent.text;
    }
    throw new Error('Unsupported pdf-parse export signature');
  }
  return fileBuffer.toString('utf-8');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node scripts/try-claim.js <resumeFile> "<claim text>"');
    process.exit(1);
  }

  const resumeFilePath = path.resolve(process.cwd(), args[0]);
  const claimText = args[1];

  const cfg = getCfg();

  // Create isolated LLM client with no persistence (callRepo: null, cacheRepo: null)
  const llmClient = createLlmClient({
    cfg,
    callRepo: null,
    cacheRepo: null,
  });

  const matchingService = createEvidenceMatchingService({
    llmClient,
    cfg,
  });

  const entailmentService = createEntailmentService({
    llmClient,
    config: cfg,
  });

  // 1. Read & normalize resume text
  const rawText = await extractFileText(resumeFilePath);
  const normalized = normalizeText(rawText);

  // 2. Chunk text
  const chunks = chunkText(normalized, { source: 'resume' });

  // 3. Extract claim numbers & skills using pure M2 extractors
  const numbers = extractNumericTokens(claimText);
  const rawTech = extractTechTokens(claimText);
  const skills = Array.from(rawTech).map(normalizeSkill);

  const claim = {
    claimText,
    numbers,
    skills,
  };

  // 4. Embed chunks and retrieve top-3 by cosine similarity
  const { chunksWithVectors } = await matchingService.prepareEvidenceChunks(chunks);
  const topMatches = await matchingService.matchClaim(claimText, chunksWithVectors, { k: 3 });
  const topChunks = topMatches.map((m) => m.chunk);

  // 5. Run entailment judge -> quote grounding -> guardrails
  const entailmentResult = await entailmentService.evaluateClaim({
    claim,
    evidenceChunks: topChunks,
  });

  const output = {
    claim,
    retrievedEvidence: topMatches.map((m) => ({
      id: m.chunk.id,
      section: m.chunk.section,
      rawCosine: Number(m.rawCosine.toFixed(4)),
      similarityScore: Number(m.similarityScore.toFixed(4)),
    })),
    entailment: entailmentResult,
  };

  // Print full JSON to stdout only
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }, null, 2));
  process.exit(1);
});
