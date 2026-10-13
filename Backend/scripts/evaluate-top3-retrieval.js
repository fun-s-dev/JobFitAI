require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { createLlmClient } = require('../src/v2/adapters/llmClient');
const { normalizeText } = require('../src/v2/core/normalizeText');
const { chunkText } = require('../src/v2/core/chunker');
const { createEvidenceMatchingService } = require('../src/v2/services/evidenceMatching.service');
const { getCfg } = require('../src/v2/config/env');

async function parseResumeFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Resume file not found at: ${filePath}`);
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

function parseClaimsFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Claims file not found at: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const resumePath = getArg('--resume');
  const claimsPath = getArg('--claims');

  if (!resumePath || !claimsPath) {
    console.error('Usage: node scripts/evaluate-top3-retrieval.js --resume <resume.pdf|resume.txt> --claims <claims.txt>');
    process.exit(1);
  }

  const rawResumeText = await parseResumeFile(resumePath);
  const claims = parseClaimsFile(claimsPath);

  if (claims.length === 0) {
    console.error('Error: No claims found in claims file.');
    process.exit(1);
  }

  console.log(`Loaded resume: ${resumePath} (${rawResumeText.length} chars)`);
  console.log(`Loaded ${claims.length} claims from: ${claimsPath}`);

  // 1. Normalize and chunk resume
  const normalized = normalizeText(rawResumeText);
  const chunks = chunkText(normalized, { source: 'resume' });
  console.log(`Created ${chunks.length} evidence chunks.`);

  // 2. Initialize LLM client and evidence matching service
  const cfg = getCfg();
  const llmClient = createLlmClient({
    cfg,
    callRepo: { create: async () => {} },
    cacheRepo: null,
  });

  const service = createEvidenceMatchingService({
    llmClient,
    cfg,
  });

  console.log('\nEmbedding evidence chunks and matching claims...');
  const { chunksWithVectors, stats } = await service.prepareEvidenceChunks(chunks);
  console.log(`Chunks embedded. Cache misses: ${stats.misses}, API calls: ${stats.apiCalls}`);

  // 3. Evaluate each claim against chunks
  const rows = [];
  rows.push('# Retrieval Top-3 Evaluation Report');
  rows.push(`- **Date:** ${new Date().toISOString()}`);
  rows.push(`- **Resume:** \`${path.basename(resumePath)}\``);
  rows.push(`- **Total Chunks:** ${chunks.length}`);
  rows.push(`- **Total Claims:** ${claims.length}\n`);

  rows.push('| # | Claim Text | Rank | Chunk ID | Raw Cosine | Scaled Score | Evidence Chunk Preview (First 100 chars) | Correct? (y/n) |');
  rows.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');

  for (let cIdx = 0; cIdx < claims.length; cIdx++) {
    const claim = claims[cIdx];
    const topChunks = await service.matchClaim(claim, chunksWithVectors, { k: 3 });

    for (let rank = 0; rank < topChunks.length; rank++) {
      const match = topChunks[rank];
      const preview = match.chunk.text.replace(/\s+/g, ' ').slice(0, 100).replace(/\|/g, '\\|');
      const claimEscaped = claim.replace(/\|/g, '\\|');
      const claimCol = rank === 0 ? `**Claim ${cIdx + 1}:** ${claimEscaped}` : ' ';
      rows.push(
        `| ${cIdx + 1} | ${claimCol} | ${rank + 1} | \`${match.chunk.id}\` | ${match.rawCosine.toFixed(4)} | ${match.similarityScore.toFixed(4)} | ${preview}... | [ ] |`
      );
    }
  }

  // Ensure scratch dir exists
  const scratchDir = path.join(__dirname, '..', 'scratch');
  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(scratchDir, `retrieval-evaluation-${timestamp}.md`);
  const reportContent = rows.join('\n');

  fs.writeFileSync(reportPath, reportContent, 'utf-8');

  console.log('\n================================================================');
  console.log(reportContent);
  console.log('================================================================');
  console.log(`\nEvaluation report successfully written to: ${reportPath}`);
}

main().catch((err) => {
  console.error('Retrieval evaluation failed:', err);
  process.exit(1);
});
