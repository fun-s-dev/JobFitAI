require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { z } = require('zod');
const { loadConfig } = require('../src/v2/config/env');
const { createLlmClient } = require('../src/v2/adapters/llmClient');
const LlmCall = require('../src/v2/models/llmCall.model');

async function runSmoke() {
  console.log('🚀 Starting Gemini Smoke Test...\n');

  if (!process.env.GOOGLE_GENAI_API_KEY) {
    console.error('❌ GOOGLE_GENAI_API_KEY is not set in environment or .env file.');
    process.exit(1);
  }

  const cfg = loadConfig(process.env);
  console.log('✓ Configuration validated successfully.');
  console.log(`  Model: ${cfg.GEMINI_MODEL}`);
  console.log(`  Embedding Model: ${cfg.EMBEDDING_MODEL} (dims: ${cfg.EMBEDDING_DIMS})`);

  let dbConnected = false;
  if (cfg.MONGO_URI) {
    try {
      await mongoose.connect(cfg.MONGO_URI);
      dbConnected = true;
      console.log('✓ Connected to MongoDB for audit log recording.');
    } catch (dbErr) {
      console.warn('⚠️ Could not connect to MongoDB:', dbErr.message);
      console.warn('  (LlmCall logging will be tested in best-effort mode)');
    }
  }

  const client = createLlmClient({
    cfg,
    callRepo: LlmCall,
  });

  const fixturesDir = path.join(__dirname, '../test/fixtures');
  if (!fs.existsSync(fixturesDir)) {
    fs.mkdirSync(fixturesDir, { recursive: true });
  }

  // 1. Structured Call
  console.log('\n[1/2] Executing structured generation call...');
  const sampleSchema = z.object({
    role: z.string().describe('The primary software engineering role'),
    skills: z.array(z.string()).describe('Top technical skills identified'),
    estimatedYears: z.number().describe('Estimated years of experience'),
  });

  const structuredResult = await client.generateStructured({
    purpose: 'smoke_test_structured',
    system: 'You are an accurate technical profile parser. Extract structured facts.',
    prompt: 'Candidate is a Senior Node.js and React developer with 5 years of industry experience.',
    schema: sampleSchema,
    thinkingLevel: 'LOW',
  });

  console.log('✓ Structured result received:');
  console.log(JSON.stringify(structuredResult, null, 2));

  const structuredFixturePath = path.join(fixturesDir, 'gemini-structured-smoke.json');
  fs.writeFileSync(structuredFixturePath, JSON.stringify(structuredResult, null, 2), 'utf8');
  console.log(`✓ Saved structured fixture to: ${path.relative(process.cwd(), structuredFixturePath)}`);

  // 2. Embedding Call
  console.log('\n[2/2] Executing batched embedding call...');
  const sampleText = 'Senior Node.js and React developer with 5 years of industry experience.';
  const vectors = await client.embed([sampleText], { purpose: 'smoke_test_embed' });

  if (!vectors || vectors.length === 0) {
    throw new Error('No embedding vectors returned');
  }

  const vec = vectors[0];
  const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
  console.log(`✓ Embedding vector received: length = ${vec.length}, norm = ${norm.toFixed(4)}`);

  if (vec.length !== cfg.EMBEDDING_DIMS) {
    console.warn(`⚠️ Warning: Expected dimensionality ${cfg.EMBEDDING_DIMS}, but got ${vec.length}`);
  }

  const embedFixturePath = path.join(fixturesDir, 'gemini-embed-smoke.json');
  fs.writeFileSync(
    embedFixturePath,
    JSON.stringify(
      {
        sampleText,
        dimensions: vec.length,
        norm: Number(norm.toFixed(4)),
        preview: vec.slice(0, 10),
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`✓ Saved embedding fixture to: ${path.relative(process.cwd(), embedFixturePath)}`);

  // 3. Print resulting LlmCall documents from MongoDB
  if (dbConnected) {
    console.log('\n--- Recorded LlmCall Documents from MongoDB ---');
    const recentCalls = await LlmCall.find({
      purpose: { $in: ['smoke_test_structured', 'smoke_test_embed'] },
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    if (recentCalls.length === 0) {
      console.log('  No recent calls found in database.');
    } else {
      recentCalls.forEach((call, idx) => {
        console.log(`\nCall #${idx + 1}:`);
        console.log(`  Purpose:     ${call.purpose}`);
        console.log(`  Model:       ${call.model}`);
        console.log(`  Attempt:     ${call.attempt}`);
        console.log(`  Success:     ${call.ok}`);
        console.log(`  Latency:     ${call.ms} ms`);
        console.log(`  Tokens In:   ${call.tokensIn}`);
        console.log(`  Tokens Out:  ${call.tokensOut}`);
        console.log(`  Created At:  ${call.createdAt}`);
      });
    }

    await mongoose.disconnect();
    console.log('\n✓ Closed database connection.');
  }

  console.log('\n🎉 Smoke test completed successfully!');
}

if (require.main === module) {
  runSmoke().catch((err) => {
    console.error('\n❌ Smoke test failed:', err);
    process.exit(1);
  });
}

module.exports = { runSmoke };
