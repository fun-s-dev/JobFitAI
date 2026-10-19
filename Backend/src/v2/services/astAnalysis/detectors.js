const walk = require('acorn-walk');
const { parseSource } = require('./astParser');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

/**
 * Detects Express/REST style route declarations.
 * e.g. router.get('/users', ...), app.post('/auth/login', ...)
 */
function findExpressRoutes(source, sourcePath) {
  const ast = parseSource(source);
  if (!ast) return [];

  const hits = [];
  walk.simple(ast, {
    CallExpression(node) {
      const c = node.callee;
      const a0 = node.arguments[0];

      if (
        c &&
        c.type === 'MemberExpression' &&
        c.property &&
        c.property.type === 'Identifier' &&
        HTTP_METHODS.has(c.property.name.toLowerCase())
      ) {
        let routePath = null;
        if (a0 && a0.type === 'Literal' && typeof a0.value === 'string' && a0.value.startsWith('/')) {
          routePath = a0.value;
        } else if (a0 && a0.type === 'TemplateLiteral' && a0.quasis.length > 0 && a0.quasis[0].value.raw.startsWith('/')) {
          routePath = a0.quasis[0].value.raw;
        }

        if (routePath) {
          hits.push({
            type: 'source_file',
            skill: 'REST APIs',
            claimSupport: `${c.property.name.toUpperCase()} ${routePath} route in ${sourcePath}`,
            sourcePath,
            lineStart: node.loc ? node.loc.start.line : 1,
            lineEnd: node.loc ? node.loc.end.line : 1,
            strength: 0.8,
            contradiction: false,
          });
        }
      }
    },
  });

  return hits;
}

/**
 * Detects Mongoose model declarations and schemas.
 * e.g. mongoose.model('User', schema), new mongoose.Schema({...}), new Schema({...})
 */
function findMongooseModels(source, sourcePath) {
  const ast = parseSource(source);
  if (!ast) return [];

  const hits = [];
  const seenLine = new Set();

  function addHit(skill, support, node) {
    const lineStart = node.loc ? node.loc.start.line : 1;
    const key = `${skill}:${lineStart}`;
    if (!seenLine.has(key)) {
      seenLine.add(key);
      hits.push({
        type: 'source_file',
        skill,
        claimSupport: support,
        sourcePath,
        lineStart,
        lineEnd: node.loc ? node.loc.end.line : lineStart,
        strength: 0.8,
        contradiction: false,
      });
    }
  }

  walk.simple(ast, {
    CallExpression(node) {
      const c = node.callee;
      if (!c) return;

      const isMongooseModel =
        c.type === 'MemberExpression' &&
        c.object &&
        c.object.name === 'mongoose' &&
        c.property &&
        c.property.name === 'model';

      const isBareModel = c.type === 'Identifier' && c.name === 'model';

      if (isMongooseModel || isBareModel) {
        const modelName = node.arguments[0]?.value ? ` "${node.arguments[0].value}"` : '';
        addHit('MongoDB', `Mongoose model${modelName} declaration in ${sourcePath}`, node);
        addHit('Mongoose', `Mongoose model${modelName} declaration in ${sourcePath}`, node);
      }
    },
    NewExpression(node) {
      const c = node.callee;
      if (!c) return;

      const isMongooseSchema =
        c.type === 'MemberExpression' &&
        c.object &&
        c.object.name === 'mongoose' &&
        c.property &&
        c.property.name === 'Schema';

      const isBareSchema = c.type === 'Identifier' && c.name === 'Schema';

      if (isMongooseSchema || isBareSchema) {
        addHit('MongoDB', `Mongoose Schema definition in ${sourcePath}`, node);
        addHit('Mongoose', `Mongoose Schema definition in ${sourcePath}`, node);
      }
    },
  });

  return hits;
}

/**
 * Detects JWT authentication calls (jwt.sign, jwt.verify).
 */
function findJwtUsage(source, sourcePath) {
  const ast = parseSource(source);
  if (!ast) return [];

  const hits = [];

  walk.simple(ast, {
    CallExpression(node) {
      const c = node.callee;
      if (
        c &&
        c.type === 'MemberExpression' &&
        c.object &&
        (c.object.name === 'jwt' || c.object.name === 'jsonwebtoken') &&
        c.property &&
        (c.property.name === 'sign' || c.property.name === 'verify')
      ) {
        const method = c.property.name;
        hits.push({
          type: 'source_file',
          skill: 'JWT Authentication',
          claimSupport: `Call to jwt.${method}() in ${sourcePath}`,
          sourcePath,
          lineStart: node.loc ? node.loc.start.line : 1,
          lineEnd: node.loc ? node.loc.end.line : 1,
          strength: 0.8,
          contradiction: false,
        });
      }
    },
  });

  return hits;
}

/**
 * Detects unit test blocks (describe, it, test) and counts them.
 * Strength is 0.8, or 0.9 if > 5 tests.
 */
function findTestBlocks(source, sourcePath) {
  const ast = parseSource(source);
  if (!ast) return { testCount: 0, hits: [] };

  let testCount = 0;
  let firstLine = Infinity;
  let lastLine = 0;

  walk.simple(ast, {
    CallExpression(node) {
      const c = node.callee;
      if (!c) return;

      let name = null;
      if (c.type === 'Identifier') {
        name = c.name;
      } else if (c.type === 'MemberExpression' && c.object && c.object.type === 'Identifier') {
        name = c.object.name;
      }

      if (name === 'it' || name === 'test' || name === 'describe') {
        if (name === 'it' || name === 'test') {
          testCount++;
        }
        if (node.loc) {
          firstLine = Math.min(firstLine, node.loc.start.line);
          lastLine = Math.max(lastLine, node.loc.end.line);
        }
      }
    },
  });

  if (testCount === 0) {
    return { testCount: 0, hits: [] };
  }

  const strength = testCount > 5 ? 0.9 : 0.8;
  const hit = {
    type: 'test',
    skill: 'Unit Testing',
    claimSupport: `Found ${testCount} automated test cases in ${sourcePath}`,
    sourcePath,
    lineStart: firstLine === Infinity ? 1 : firstLine,
    lineEnd: lastLine === 0 ? 1 : lastLine,
    strength,
    contradiction: false,
  };

  return { testCount, hits: [hit] };
}

/**
 * Detects Queue and Worker constructors (BullMQ / job queues).
 * e.g. new Queue(...), new Worker(...)
 */
function findQueueWorkers(source, sourcePath) {
  const ast = parseSource(source);
  if (!ast) return [];

  const hits = [];

  walk.simple(ast, {
    NewExpression(node) {
      const c = node.callee;
      if (c && c.type === 'Identifier' && (c.name === 'Queue' || c.name === 'Worker')) {
        hits.push({
          type: 'source_file',
          skill: 'Job Queues',
          claimSupport: `Instantiation of ${c.name} in ${sourcePath}`,
          sourcePath,
          lineStart: node.loc ? node.loc.start.line : 1,
          lineEnd: node.loc ? node.loc.end.line : 1,
          strength: 0.8,
          contradiction: false,
        });
      }
    },
  });

  return hits;
}

module.exports = {
  findExpressRoutes,
  findMongooseModels,
  findJwtUsage,
  findTestBlocks,
  findQueueWorkers,
};
