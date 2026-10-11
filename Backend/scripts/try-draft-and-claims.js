/**
 * Eyeball verification script for Milestone 2:
 * Generates a tailored structured resume draft, extracts atomic claims,
 * and renders the final PDF.
 *
 * Output is saved strictly to gitignored directory (Backend/scratch/output/).
 * Never commits candidate resume text or personal details.
 *
 * Usage:
 *   node scripts/try-draft-and-claims.js --report-id <id>
 *   node scripts/try-draft-and-claims.js --resume <file.txt|pdf> --jd <file.txt> [--self <file.txt>]
 *   node scripts/try-draft-and-claims.js (runs with realistic built-in candidate profile)
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables (.env)
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { createLlmClient } = require('../src/v2/adapters/llmClient');
const { createDraftService } = require('../src/v2/services/draft.service');
const { createClaimExtractionService } = require('../src/v2/services/claimExtraction.service');
const { renderDraftToPdf } = require('../src/v2/adapters/pdfRenderer');

async function parsePdfIfApplicable(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fileBuffer = fs.readFileSync(filePath);
  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(fileBuffer);
    return data.text;
  }
  return fileBuffer.toString('utf-8');
}

async function main() {
  const args = process.argv.slice(2);
  let resumeText = '';
  let selfDescription = '';
  let jobDescription = '';

  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  };

  const reportId = getArg('--report-id');
  const resumeFile = getArg('--resume');
  const jdFile = getArg('--jd');
  const selfFile = getArg('--self');

  if (reportId) {
    const mongoose = require('mongoose');
    const connectDb = require('../src/config/db'); // or mongoose connect
    const InterviewReport = require('../src/models/interviewReport.model');
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      console.error('MONGO_URI is required to fetch report by ID');
      process.exit(1);
    }
    await mongoose.connect(mongoUri);
    const report = await InterviewReport.findById(reportId);
    if (!report) {
      console.error(`Report ${reportId} not found`);
      process.exit(1);
    }
    resumeText = report.resume || '';
    selfDescription = report.selfDescription || '';
    jobDescription = report.jobDescription || '';
    await mongoose.disconnect();
  } else if (resumeFile && jdFile) {
    resumeText = await parsePdfIfApplicable(resumeFile);
    jobDescription = fs.readFileSync(jdFile, 'utf-8');
    if (selfFile) {
      selfDescription = fs.readFileSync(selfFile, 'utf-8');
    }
  } else {
    // Realistic fallback profile for verification eyeball testing
    console.log('[Info] No input files specified. Using built-in candidate profile for eyeball run.');
    resumeText = `
John Doe
Senior Software Engineer with 6 years experience building scalable backend architectures.

Experience:
Senior Software Engineer | Acme Cloud (2022 - Present)
- Architected high-throughput notification service using RabbitMQ and Node.js, slashing delivery time by 35% across 2M daily notifications.
- Designed and deployed RESTful APIs using Express and MongoDB, serving 500k monthly active users with 99.9% uptime.
- Integrated Redis caching layer for session storage, reducing p95 database response latency by 45%.

Software Engineer | DevCorp (2019 - 2022)
- Migrated legacy monolithic application to Docker and Kubernetes on AWS, cutting infrastructure costs by $150k annually.
- Implemented JWT authentication with refresh token rotation and bcrypt password hashing.
- Authored comprehensive test suites using Vitest and Supertest, achieving 88% code coverage across 45 test files.

Skills:
Node.js, Express, JavaScript, TypeScript, MongoDB, Redis, RabbitMQ, Docker, Kubernetes, AWS, Git, Vitest, Jest.

Education:
B.S. in Computer Science | State University (2015 - 2019)
    `.trim();

    jobDescription = `
Senior Backend Engineer
We are seeking an experienced Backend Engineer to lead development of our distributed cloud platform.
Responsibilities:
- Build high-scale RESTful APIs and event-driven microservices.
- Optimize database performance and implement caching strategies (Redis, PostgreSQL, MongoDB).
- Maintain high system availability (99.9%+) and lead cloud migrations with Docker and Kubernetes.
Requirements:
- 4+ years of backend development with Node.js, Express, and distributed message queues.
- Strong knowledge of microservices, caching, and CI/CD pipelines.
    `.trim();

    selfDescription = 'Passionate backend engineer with expertise in distributed message queues, microservices, and database tuning.';
  }

  const outputDir = path.resolve(__dirname, '../scratch/output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log('\n--- Step 1: Initializing LLM Client & Services ---');
  const llmClient = createLlmClient();
  const draftService = createDraftService({ llmClient });
  const claimService = createClaimExtractionService({ llmClient, batchSize: 3 });

  console.log('--- Step 2: Generating Tailored Structured Resume Draft ---');
  const draft = await draftService.generateDraft({
    resume: resumeText,
    selfDescription,
    jobDescription,
  });

  const draftJsonPath = path.join(outputDir, 'draft.json');
  fs.writeFileSync(draftJsonPath, JSON.stringify(draft, null, 2), 'utf-8');
  console.log(`[Success] Draft generated and written to: ${draftJsonPath}`);

  // Collect all bullets from draft
  const bullets = [];
  for (const exp of draft.experience || []) {
    for (const b of exp.bullets || []) {
      bullets.push(b);
    }
  }
  for (const prj of draft.projects || []) {
    for (const b of prj.bullets || []) {
      bullets.push(b);
    }
  }

  console.log(`\n--- Step 3: Extracting Atomic Claims across ${bullets.length} Bullets ---`);
  const { claims, incompleteBullets } = await claimService.extractClaimsFromBullets(bullets);

  const claimsJsonPath = path.join(outputDir, 'claims.json');
  fs.writeFileSync(
    claimsJsonPath,
    JSON.stringify({ totalClaims: claims.length, incompleteBullets, claims }, null, 2),
    'utf-8'
  );
  console.log(`[Success] Extracted ${claims.length} atomic claims written to: ${claimsJsonPath}`);
  if (incompleteBullets.length > 0) {
    console.warn(`[Warning] Incomplete bullets: ${incompleteBullets.join(', ')}`);
  }

  console.log('\n--- Step 4: Rendering ATS-friendly PDF via Puppeteer ---');
  const pdfBuffer = await renderDraftToPdf(draft);
  const pdfPath = path.join(outputDir, 'resume.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);
  console.log(`[Success] PDF rendered (${pdfBuffer.length} bytes) to: ${pdfPath}`);

  console.log('\n=== Eyeball Verification Run Complete ===');
  console.log(`Summary: ${bullets.length} bullets -> ${claims.length} claims extracted.`);
  console.log(`Output folder (gitignored): ${outputDir}`);
}

main().catch((err) => {
  console.error('\n[Error] Eyeball run failed:', err.message);
  process.exit(1);
});
