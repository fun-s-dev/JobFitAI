const fs = require('fs');
const path = require('path');

function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(424242);

function run() {
  const casesFile = path.join(__dirname, '../data/cases.jsonl');
  const lines = fs.readFileSync(casesFile, 'utf8').trim().split('\n');
  const allCases = lines.map(l => JSON.parse(l));

  // Stratified sample ~25% (4 cases per type across 9 types = 36 cases >= 30)
  const grouped = {};
  for (const c of allCases) {
    if (!grouped[c.caseType]) grouped[c.caseType] = [];
    grouped[c.caseType].push(c);
  }

  const sample = [];
  const benchmarkTypes = Object.keys(grouped).filter(t => t !== 'injection_control');
  for (const type of benchmarkTypes) {
    const list = [...grouped[type]];
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    // Take 4 from each of the 9 types -> 36 cases (28.6% sample)
    sample.push(...list.slice(0, 4));
  }

  sample.sort((a, b) => a.id.localeCompare(b.id));

  // Load fixtures to provide surrounding context if goldEvidenceChunk is short
  const fixtureMap = {};
  const fixturesDir = path.join(__dirname, '../fixtures');
  for (const f of fs.readdirSync(fixturesDir)) {
    if (f.endsWith('.json')) {
      const data = JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8'));
      fixtureMap[data.id] = data;
    }
  }

  let md = `# JobFitAI v2 — Benchmark Spot-Check Sample (Stratified 25%)

This file contains a stratified random sample of **${sample.length} cases** (out of ${allCases.length} total) for human spot-check validation.

## Instructions
For each case below:
1. Compare the **Claim** against the **Constructed Label** and the **Evidence Snippet** from the candidate's resume.
2. Tick exactly one box: \`[x] agree\` or \`[x] disagree\`.
3. If you disagree, optionally add a short reason.
4. When finished, notify the assistant or run \`node evaluation/scripts/process-spotcheck.js\`.

*Note: All checkboxes below are initially unticked. The automated generator does NOT tick checkboxes.*

---

`;

  sample.forEach((item, index) => {
    const fixture = fixtureMap[item.evidence.resume] || {};
    const candidateName = fixture.name || item.evidence.resume;
    const snippet = item.goldEvidenceChunk || '*(None: fully fabricated claim with no matching resume text)*';

    md += `### Case ${index + 1}: \`${item.id}\` (${item.caseType})
- **Fixture Candidate:** ${candidateName} (\`${item.evidence.resume}\`)
- **Constructed Label:** **\`${item.label}\`** (source: \`${item.labelSource}\`)
- **Mutation Description:** *${item.mutation}*
- **Claim:**
  > "${item.claim}"
- **Resume Evidence Snippet:**
  > "${snippet}"
- **Spot-Check Verification:**
  - [ ] agree
  - [ ] disagree
- **Reviewer Notes (if disagree):** 

---

`;
  });

  const outPath = path.join(__dirname, '../spotcheck.md');
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`Wrote ${sample.length} spot-check cases to evaluation/spotcheck.md`);
}

run();
