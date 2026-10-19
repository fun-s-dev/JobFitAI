const {
  findExpressRoutes,
  findMongooseModels,
  findJwtUsage,
  findTestBlocks,
  findQueueWorkers,
} = require('./detectors');
const { analyzeReadme } = require('./readmeDetector');
const { parseSource } = require('./astParser');

/**
 * Runs all applicable AST detectors on a single source or test file.
 * Returns an array of EvidenceItem objects.
 *
 * @param {string} sourcePath - Relative repository path
 * @param {string} sourceCode - UTF-8 source string
 * @returns {Array<object>} Evidence items
 */
function analyzeSourceFile(sourcePath, sourceCode) {
  if (typeof sourceCode !== 'string' || !sourceCode.trim()) {
    return [];
  }

  const items = [];

  // Check test blocks
  const { hits: testHits } = findTestBlocks(sourceCode, sourcePath);
  items.push(...testHits);

  // Check Express routes
  const routeHits = findExpressRoutes(sourceCode, sourcePath);
  items.push(...routeHits);

  // Check Mongoose models and schemas
  const mongooseHits = findMongooseModels(sourceCode, sourcePath);
  items.push(...mongooseHits);

  // Check JWT calls
  const jwtHits = findJwtUsage(sourceCode, sourcePath);
  items.push(...jwtHits);

  // Check Queue and Worker instantiations
  const queueHits = findQueueWorkers(sourceCode, sourcePath);
  items.push(...queueHits);

  return items;
}

module.exports = {
  parseSource,
  findExpressRoutes,
  findMongooseModels,
  findJwtUsage,
  findTestBlocks,
  findQueueWorkers,
  analyzeReadme,
  analyzeSourceFile,
};
