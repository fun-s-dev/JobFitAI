require('dotenv').config();
const { createLlmClient } = require('../src/v2/adapters/llmClient');
const { cosineSimilarity } = require('../src/v2/core/cosineSimilarity');
const { getCfg } = require('../src/v2/config/env');

const PAIRS = [
  {
    id: 1,
    category: 'Paraphrase',
    textA: 'Built REST APIs with Express',
    textB: 'Developed backend services using Node.js and Express',
  },
  {
    id: 2,
    category: 'Number changed',
    textA: 'Reduced latency by 40%',
    textB: 'Reduced latency by 4%',
  },
  {
    id: 3,
    category: 'Role changed',
    textA: 'Led a team of 10',
    textB: 'Worked in a team of 10',
  },
  {
    id: 4,
    category: 'Sibling technology',
    textA: 'Used Redis for caching',
    textB: 'Used Memcached for caching',
  },
  {
    id: 5,
    category: 'Unrelated',
    textA: 'Built REST APIs with Express',
    textB: 'Played cricket on weekends',
  },
];

async function main() {
  const cfg = getCfg();
  const client = createLlmClient({
    cfg,
    // Use in-memory dummy call repo for standalone CLI script if mongo not connected
    callRepo: { create: async () => {} },
    cacheRepo: null,
  });

  console.log('Embedding five concept pairs from Guide §4.4...');
  console.log(`Model: ${cfg.EMBEDDING_MODEL} | Dimensions: ${cfg.EMBEDDING_DIMS}\n`);

  const results = [];

  for (const pair of PAIRS) {
    const { vectors } = await client.embedTexts([pair.textA, pair.textB], { purpose: 'experiment_five_pairs' });
    const cos = cosineSimilarity(vectors[0], vectors[1]);
    results.push({
      id: pair.id,
      category: pair.category,
      textA: pair.textA,
      textB: pair.textB,
      cosine: cos.toFixed(4),
    });
  }

  // Print neutral table only
  console.log('| Pair | Category | Text A | Text B | Cosine Similarity |');
  console.log('| :--- | :--- | :--- | :--- | :--- |');
  for (const r of results) {
    console.log(`| ${r.id} | ${r.category} | "${r.textA}" | "${r.textB}" | ${r.cosine} |`);
  }
}

main().catch((err) => {
  console.error('Experiment script failed:', err.message);
  process.exit(1);
});
