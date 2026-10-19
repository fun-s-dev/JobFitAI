const skillAliases = require('../../data/skillAliases.json');

/**
 * Common high-signal skills to scan for in README documentation.
 */
const TRACKED_README_SKILLS = [
  'Express',
  'React',
  'MongoDB',
  'Mongoose',
  'Redis',
  'JWT Authentication',
  'REST APIs',
  'Unit Testing',
  'API Testing',
  'BullMQ',
  'Job Queues',
  'Node.js',
  'PostgreSQL',
  'Docker',
  'Kubernetes',
  'Kafka',
  'GraphQL',
  'Flask',
  'FastAPI',
  'Django',
];

/**
 * Analyzes README content for skill claims and detects contradictions against code/manifest evidence.
 *
 * @param {string} readmeContent
 * @param {string} sourcePath - e.g. "README.md"
 * @param {Set<string>|Array<string>} backedSkills - Set of canonical skills confirmed by manifest or AST
 * @returns {Array<object>} Evidence items (corroborating or contradiction)
 */
function analyzeReadme(readmeContent, sourcePath = 'README.md', backedSkills = new Set()) {
  if (typeof readmeContent !== 'string' || !readmeContent.trim()) {
    return [];
  }

  const backedSet = backedSkills instanceof Set ? backedSkills : new Set(backedSkills);
  const items = [];
  const seenSkill = new Set();
  const lowerReadme = readmeContent.toLowerCase();

  for (const canonicalSkill of TRACKED_README_SKILLS) {
    if (seenSkill.has(canonicalSkill)) continue;

    // Check if canonical skill or any of its known aliases appear as whole-word tokens in README
    const aliases = Object.entries(skillAliases)
      .filter(([, canonical]) => canonical.toLowerCase() === canonicalSkill.toLowerCase())
      .map(([alias]) => alias);

    const patterns = [canonicalSkill.toLowerCase(), ...aliases];

    let found = false;
    for (const pat of patterns) {
      // Escape special regex chars like . or + or #
      const escaped = pat.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(`(?:^|[^a-zA-Z0-9])${escaped}(?:$|[^a-zA-Z0-9])`, 'i');
      if (regex.test(lowerReadme)) {
        found = true;
        break;
      }
    }

    if (found) {
      seenSkill.add(canonicalSkill);
      const isBacked = backedSet.has(canonicalSkill);

      if (isBacked) {
        items.push({
          type: 'readme',
          skill: canonicalSkill,
          claimSupport: `Documented in ${sourcePath}`,
          sourcePath,
          lineStart: null,
          lineEnd: null,
          strength: 0.5, // README capped at 0.5
          contradiction: false,
        });
      } else {
        items.push({
          type: 'readme',
          skill: canonicalSkill,
          claimSupport: `Mentioned in ${sourcePath} but not found in manifest or AST`,
          sourcePath,
          lineStart: null,
          lineEnd: null,
          strength: 0.0,
          contradiction: true,
        });
      }
    }
  }

  return items;
}

module.exports = {
  analyzeReadme,
  TRACKED_README_SKILLS,
};
