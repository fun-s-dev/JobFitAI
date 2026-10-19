const path = require('node:path');

/**
 * npm dependency to canonical skill mapping.
 * Canonical skill names align strictly with Backend/src/v2/data/skillAliases.json.
 * Rule: A dependency alone has strength at most 0.5.
 */
const NPM_SKILL_MAP = {
  express: [
    { skill: 'Express', strength: 0.5 },
    { skill: 'REST APIs', strength: 0.3 },
  ],
  mongoose: [
    { skill: 'MongoDB', strength: 0.5 },
    { skill: 'Mongoose', strength: 0.5 },
  ],
  mongodb: [
    { skill: 'MongoDB', strength: 0.5 },
  ],
  jsonwebtoken: [
    { skill: 'JWT Authentication', strength: 0.5 },
  ],
  bcryptjs: [
    { skill: 'Password Hashing', strength: 0.4 },
  ],
  bcrypt: [
    { skill: 'Password Hashing', strength: 0.4 },
  ],
  bullmq: [
    { skill: 'BullMQ', strength: 0.5 },
    { skill: 'Redis', strength: 0.4 },
  ],
  bull: [
    { skill: 'BullMQ', strength: 0.5 },
    { skill: 'Redis', strength: 0.4 },
  ],
  redis: [
    { skill: 'Redis', strength: 0.5 },
  ],
  ioredis: [
    { skill: 'Redis', strength: 0.5 },
  ],
  react: [
    { skill: 'React', strength: 0.5 },
  ],
  'react-dom': [
    { skill: 'React', strength: 0.5 },
  ],
  vitest: [
    { skill: 'Unit Testing', strength: 0.4 },
  ],
  jest: [
    { skill: 'Unit Testing', strength: 0.4 },
  ],
  mocha: [
    { skill: 'Unit Testing', strength: 0.4 },
  ],
  supertest: [
    { skill: 'API Testing', strength: 0.4 },
  ],
  axios: [
    { skill: 'REST APIs', strength: 0.3 },
  ],
  cors: [
    { skill: 'REST APIs', strength: 0.2 },
  ],
};

/**
 * Python PyPI package to canonical skill mapping.
 * Canonical skill names align strictly with Backend/src/v2/data/skillAliases.json.
 * Rule: A dependency alone has strength at most 0.5.
 */
const PY_SKILL_MAP = {
  flask: [
    { skill: 'Flask', strength: 0.5 },
    { skill: 'REST APIs', strength: 0.3 },
  ],
  fastapi: [
    { skill: 'FastAPI', strength: 0.5 },
    { skill: 'REST APIs', strength: 0.3 },
  ],
  django: [
    { skill: 'Django', strength: 0.5 },
    { skill: 'REST APIs', strength: 0.3 },
  ],
  pymongo: [
    { skill: 'MongoDB', strength: 0.5 },
  ],
  redis: [
    { skill: 'Redis', strength: 0.5 },
  ],
  celery: [
    { skill: 'Redis', strength: 0.3 },
  ],
  pytest: [
    { skill: 'Unit Testing', strength: 0.4 },
  ],
  pyjwt: [
    { skill: 'JWT Authentication', strength: 0.5 },
  ],
};

/**
 * Parses package.json content and returns extracted dependencies and EvidenceItems.
 *
 * @param {string} content
 * @param {string} [sourcePath='package.json']
 * @returns {{ dependencies: Array<{ name: string, version: string, ecosystem: string, isDev: boolean, skills: string[] }>, evidenceItems: Array<object> }}
 */
function parsePackageJson(content, sourcePath = 'package.json') {
  if (typeof content !== 'string' || !content.trim()) {
    return { dependencies: [], evidenceItems: [] };
  }

  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch {
    return { dependencies: [], evidenceItems: [] };
  }

  const dependencies = [];
  const evidenceItems = [];
  const seenEvidenceKey = new Set();

  function processDeps(depsObj, isDev) {
    if (!depsObj || typeof depsObj !== 'object') return;
    for (const [rawName, version] of Object.entries(depsObj)) {
      const name = rawName.toLowerCase();
      const mappings = NPM_SKILL_MAP[name] || [];
      const skills = mappings.map((m) => m.skill);

      dependencies.push({
        name: rawName,
        version: typeof version === 'string' ? version : '*',
        ecosystem: 'npm',
        isDev,
        skills,
      });

      for (const mapping of mappings) {
        const key = `${mapping.skill}:${rawName}`;
        if (!seenEvidenceKey.has(key)) {
          seenEvidenceKey.add(key);
          evidenceItems.push({
            type: 'dependency',
            skill: mapping.skill,
            claimSupport: `npm dependency "${rawName}" (${version || 'any'}) in ${sourcePath}`,
            sourcePath,
            lineStart: null,
            lineEnd: null,
            strength: Math.min(0.5, mapping.strength),
            contradiction: false,
          });
        }
      }
    }
  }

  processDeps(pkg.dependencies, false);
  processDeps(pkg.devDependencies, true);

  return { dependencies, evidenceItems };
}

/**
 * Parses requirements.txt content and returns extracted dependencies and EvidenceItems.
 *
 * @param {string} content
 * @param {string} [sourcePath='requirements.txt']
 * @returns {{ dependencies: Array<{ name: string, version: string, ecosystem: string, isDev: boolean, skills: string[] }>, evidenceItems: Array<object> }}
 */
function parseRequirementsTxt(content, sourcePath = 'requirements.txt') {
  if (typeof content !== 'string' || !content.trim()) {
    return { dependencies: [], evidenceItems: [] };
  }

  const dependencies = [];
  const evidenceItems = [];
  const seenEvidenceKey = new Set();

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) {
      continue;
    }

    // Strip inline comment
    const withoutComment = trimmed.split('#')[0].trim();
    if (!withoutComment) continue;

    // Split on version specifiers: ==, >=, <=, ~=, !=, >, <
    const match = withoutComment.match(/^([a-zA-Z0-9_\-.]+)(.*)$/);
    if (!match) continue;

    const rawName = match[1];
    const versionPart = match[2] ? match[2].trim() : '*';
    const name = rawName.toLowerCase().replace(/_/g, '-');

    // Try lookup with both hyphens and original name
    const mappings = PY_SKILL_MAP[name] || PY_SKILL_MAP[rawName.toLowerCase()] || [];
    const skills = mappings.map((m) => m.skill);

    dependencies.push({
      name: rawName,
      version: versionPart,
      ecosystem: 'pypi',
      isDev: false,
      skills,
    });

    for (const mapping of mappings) {
      const key = `${mapping.skill}:${rawName}`;
      if (!seenEvidenceKey.has(key)) {
        seenEvidenceKey.add(key);
        evidenceItems.push({
          type: 'dependency',
          skill: mapping.skill,
          claimSupport: `Python package "${rawName}" in ${sourcePath}`,
          sourcePath,
          lineStart: null,
          lineEnd: null,
          strength: Math.min(0.5, mapping.strength),
          contradiction: false,
        });
      }
    }
  }

  return { dependencies, evidenceItems };
}

/**
 * Generic dispatcher for manifest files.
 */
function extractDependenciesFromContent(filePath, content) {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'package.json') {
    return parsePackageJson(content, filePath);
  }
  if (base === 'requirements.txt') {
    return parseRequirementsTxt(content, filePath);
  }
  return { dependencies: [], evidenceItems: [] };
}

module.exports = {
  parsePackageJson,
  parseRequirementsTxt,
  extractDependenciesFromContent,
  NPM_SKILL_MAP,
  PY_SKILL_MAP,
};
