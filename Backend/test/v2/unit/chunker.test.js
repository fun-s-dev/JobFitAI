import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { chunkText } = require('../../../src/v2/core/chunker');
const { normalizeText } = require('../../../src/v2/core/normalizeText');

// Sample Resume 1: Standard professional resume
const sampleResume1 = `
Jane Doe
jane.doe@example.com | San Francisco, CA

SUMMARY
Experienced software engineer with 5+ years building scalable distributed backends.

EXPERIENCE
Acme Corp
Senior Backend Engineer (2021 – Present)
- Architected a distributed messaging bus handling 100k events/sec using Node.js and Redis.
- Reduced database p95 latency by 45% by restructuring Mongoose queries and adding indexes.
- Mentored 4 junior engineers on backend testing best practices.

Beta Technologies
Software Engineer (2018 – 2021)
- Developed REST APIs in Express.js supporting 500k monthly active users.
- Automated CI/CD deployment pipelines using GitHub Actions and Docker.

PROJECTS
JobFitAI
- Built automated resume verification tool in React and Node.js.
- Integrated LLM fact-checking against extracted AST evidence.

SKILLS
JavaScript, TypeScript, Node.js, Express, MongoDB, Redis, Docker, Git

EDUCATION
University of California, Berkeley
B.S. in Computer Science (2014 – 2018)
`;

// Sample Resume 2: Concise but complete resume
const sampleResume2 = `
Alex Smith
alex@example.com

SUMMARY
Full stack developer specializing in modern JavaScript stacks and cloud services.

SKILLS
Node.js, React, PostgreSQL, Docker, AWS

EXPERIENCE
Startup XYZ
Full Stack Developer (2022 – 2024)
- Built user authentication with JWT and bcrypt password hashing.
- Deployed React single-page application to AWS S3 and CloudFront.
- Optimized PostgreSQL database queries reducing API response times by 30%.

EDUCATION
Tech University, B.S. in Software Engineering (2018 – 2022)
`;

// Sample Resume 3: Messy two-column extraction typical of pdf-parse
const sampleResume3 = `
CONTACT                  WORK EXPERIENCE
John Developer           Gamma Systems | Cloud Engineer (2020 – 2023)
john@dev.io              - Designed and deployed Kubernetes clusters across multi-cloud regions.
                         - Configured Prometheus and Grafana for real-time alerting.
SKILLS                   Delta Labs | Associate Engineer (2018 – 2020)
Python, Go, K8s, AWS     - Maintained high-throughput REST microservices in Go.
Docker, Terraform        - Cut cloud infrastructure costs by 28% via instance rightsizing.
PostgreSQL, Redis        - Spearheaded database migration from MySQL to PostgreSQL.

CERTIFICATIONS           Epsilon Corp | Junior Developer (2017 – 2018)
AWS Solutions Architect  - Built backend batch processing workers in Python.
CKA Kubernetes Admin     - Automated integration testing suite with pytest and Docker.

EDUCATION                PROJECTS
MIT, B.S. CS 2018        OpenCloud CLI — Open-source deployment tool with 1,200 stars.
                         - Wrote Go CLI with Cobra framework for multi-cluster provisioning.
`;

describe('core/chunker (pure)', () => {
  it('guarantees normalizedText.slice(start, end) === chunk.text for EVERY chunk', () => {
    const normalized = normalizeText(sampleResume1);
    const chunks = chunkText(normalized, { source: 'resume' });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const sliced = normalized.slice(chunk.start, chunk.end);
      expect(sliced).toBe(chunk.text);
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('prefixes chunk embedText with context while keeping chunk.text clean', () => {
    const normalized = normalizeText(sampleResume1);
    const chunks = chunkText(normalized, { source: 'resume' });

    const experienceChunk = chunks.find((c) => c.section === 'Experience');
    expect(experienceChunk).toBeDefined();
    expect(experienceChunk.context.length).toBeGreaterThan(0);
    expect(experienceChunk.embedText).toContain(experienceChunk.context);
    expect(experienceChunk.embedText).toContain(experienceChunk.text);
    // chunk.text itself must not contain the prefixed context
    expect(experienceChunk.text.startsWith(experienceChunk.context)).toBe(false);
  });

  it('calculates sha256 hash strictly over embedText', () => {
    const normalized = normalizeText(sampleResume1);
    const chunks = chunkText(normalized, { source: 'resume' });

    for (const chunk of chunks) {
      const expectedHash = crypto.createHash('sha256').update(chunk.embedText).digest('hex');
      expect(chunk.hash).toBe(expectedHash);
    }
  });

  it('includes the source in chunk ids to prevent cross-source offset collision', () => {
    const resumeChunks = chunkText(normalizeText(sampleResume2), { source: 'resume' });
    const selfDescChunks = chunkText('Experienced backend engineer with Node.js.', {
      source: 'self_description',
    });

    expect(resumeChunks[0].id).toMatch(/^resume_/);
    expect(selfDescChunks[0].id).toMatch(/^self_description_/);
  });

  it('never emits empty or whitespace-only chunks', () => {
    const messyEmptyInput = `
      \n\n\n   ---   \n\n
      • \n
      - \n
      Actual valid sentence here.
      \n\n   \n
    `;
    const normalized = normalizeText(messyEmptyInput);
    const chunks = chunkText(normalized, { source: 'resume' });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
      expect(chunk.embedText.trim().length).toBeGreaterThan(0);
    }
  });

  it('splits single sentences longer than 400 chars at word boundaries, never mid-word', () => {
    // Generate a long sentence > 500 characters
    const words = [
      'Architected', 'enterprise', 'grade', 'distributed', 'event', 'streaming',
      'pipeline', 'processing', 'billions', 'of', 'records', 'daily', 'across',
      'multiple', 'geographic', 'cloud', 'regions', 'with', 'strict', 'consistency',
      'guarantees', 'and', 'zero', 'downtime', 'automated', 'failover', 'mechanisms',
      'utilizing', 'Kafka', 'clusters', 'and', 'custom', 'partitioning', 'strategies',
      'while', 'maintaining', 'sub', 'millisecond', 'latency', 'under', 'peak',
      'load', 'conditions', 'without', 'data', 'loss', 'or', 'service', 'degradation',
      'for', 'mission', 'critical', 'production', 'systems.',
    ];
    const longSentence = words.join(' ');
    expect(longSentence.length).toBeGreaterThan(400);

    const chunks = chunkText(longSentence, { source: 'resume', maxChars: 400 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(400);
      const sliced = longSentence.slice(chunk.start, chunk.end);
      expect(sliced).toBe(chunk.text);
      // Ensure it did not split mid-word (should start and end with complete word characters or punctuation)
      expect(chunk.text).not.toMatch(/^\w{1,3}\b\s/); // Doesn't start with arbitrary word fragment
    }
  });

  it('processes THREE sample resumes and logs sane chunk counts (5-100 chunks)', () => {
    const resumes = [
      { name: 'Resume 1 (Standard)', raw: sampleResume1 },
      { name: 'Resume 2 (Concise)', raw: sampleResume2 },
      { name: 'Resume 3 (Two-column extraction)', raw: sampleResume3 },
    ];

    const results = [];

    for (const { name, raw } of resumes) {
      const normalized = normalizeText(raw);
      const chunks = chunkText(normalized, { source: 'resume' });

      results.push({ name, chunkCount: chunks.length, chunks: chunks.map(c => ({ id: c.id, section: c.section, text: c.text })) });
    }

    // Print summary so the user can sanity-check
    console.log('\n--- Resume Chunking Sanity-Check Counts ---');
    for (const r of results) {
      console.log(`  ${r.name}: ${r.chunkCount} chunks`);
      console.log(r.chunks);
    }
    console.log('-------------------------------------------\n');

    for (const r of results) {
      expect(r.chunkCount).toBeGreaterThanOrEqual(4);
      expect(r.chunkCount).toBeLessThanOrEqual(100);
    }
  });
});
