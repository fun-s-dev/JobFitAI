import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findExpressRoutes,
  findMongooseModels,
  findJwtUsage,
  findTestBlocks,
  findQueueWorkers,
  analyzeReadme,
  analyzeSourceFile,
} = require('../../../src/v2/services/astAnalysis');

describe('services/astAnalysis (pure)', () => {
  describe('Express routes detector', () => {
    it('detects router.get and app.post routes with exact line numbers', () => {
      const code = `
const express = require('express');
const router = express.Router();

router.get('/api/users', (req, res) => {
  res.json({ users: [] });
});

app.post('/api/login', (req, res) => {
  res.send('ok');
});
      `;

      const hits = findExpressRoutes(code, 'src/routes/user.js');
      expect(hits.length).toBe(2);

      const getRoute = hits.find((h) => h.claimSupport.includes('GET'));
      expect(getRoute).toBeDefined();
      expect(getRoute.skill).toBe('REST APIs');
      expect(getRoute.strength).toBe(0.8);
      expect(getRoute.lineStart).toBe(5);
      expect(getRoute.sourcePath).toBe('src/routes/user.js');
      expect(getRoute.contradiction).toBe(false);

      const postRoute = hits.find((h) => h.claimSupport.includes('POST'));
      expect(postRoute).toBeDefined();
      expect(postRoute.lineStart).toBe(9);
    });

    it('returns empty array on non-route calls or syntax errors (negative test)', () => {
      const negativeCode = `
const logger = console.log;
logger('/not-a-route');
const arr = [1, 2, 3];
arr.forEach(x => x);
      `;
      expect(findExpressRoutes(negativeCode, 'src/utils.js')).toEqual([]);
      expect(findExpressRoutes('const = invalid syntax +++', 'src/bad.js')).toEqual([]);
    });
  });

  describe('Mongoose models and schemas detector', () => {
    it('detects mongoose.model and new Schema definitions', () => {
      const code = `
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true }
});

const User = mongoose.model('User', UserSchema);
module.exports = User;
      `;

      const hits = findMongooseModels(code, 'src/models/user.model.js');
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits.some((h) => h.skill === 'MongoDB')).toBe(true);
      expect(hits.some((h) => h.skill === 'Mongoose')).toBe(true);
      expect(hits[0].strength).toBe(0.8);
      expect(hits[0].lineStart).toBeDefined();
      expect(hits[0].contradiction).toBe(false);
    });

    it('returns empty array when mongoose is not used (negative test)', () => {
      const code = `
class PlainUser {
  constructor(name) { this.name = name; }
}
      `;
      expect(findMongooseModels(code, 'src/user.js')).toEqual([]);
    });
  });

  describe('JWT usage detector', () => {
    it('detects jwt.sign and jwt.verify calls with line numbers', () => {
      const code = `
const jwt = require('jsonwebtoken');

function generateToken(user) {
  return jwt.sign({ id: user._id }, 'secret', { expiresIn: '1h' });
}

function verifyToken(token) {
  return jwt.verify(token, 'secret');
}
      `;

      const hits = findJwtUsage(code, 'src/auth/token.js');
      expect(hits.length).toBe(2);
      expect(hits[0].skill).toBe('JWT Authentication');
      expect(hits[0].strength).toBe(0.8);
      expect(hits[0].claimSupport).toContain('jwt.sign');
      expect(hits[1].claimSupport).toContain('jwt.verify');
      expect(hits[0].lineStart).toBe(5);
      expect(hits[1].lineStart).toBe(9);
    });

    it('returns empty array when jwt is not called (negative test)', () => {
      const code = `
function hashPassword(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}
      `;
      expect(findJwtUsage(code, 'src/hash.js')).toEqual([]);
    });
  });

  describe('Test blocks detector (counting)', () => {
    it('detects describe and it/test blocks and awards 0.8 (or 0.9 if > 5 tests)', () => {
      const code = `
describe('Auth service', () => {
  it('logs in user', () => {});
  it('rejects invalid password', () => {});
  test('refreshes token', () => {});
});
      `;

      const result = findTestBlocks(code, 'test/auth.test.js');
      expect(result.testCount).toBe(3);
      expect(result.hits.length).toBe(1);
      expect(result.hits[0].skill).toBe('Unit Testing');
      expect(result.hits[0].strength).toBe(0.8); // <= 5 tests

      // > 5 tests code
      const manyTests = `
describe('Suite', () => {
  it('t1', () => {});
  it('t2', () => {});
  it('t3', () => {});
  it('t4', () => {});
  it('t5', () => {});
  it('t6', () => {});
});
      `;
      const resultMany = findTestBlocks(manyTests, 'test/suite.test.js');
      expect(resultMany.testCount).toBe(6);
      expect(resultMany.hits[0].strength).toBe(0.9);
    });

    it('returns 0 tests and no hits on files without test blocks', () => {
      const result = findTestBlocks('const x = 10;', 'src/index.js');
      expect(result.testCount).toBe(0);
      expect(result.hits).toEqual([]);
    });
  });

  describe('Job Queues and Workers detector', () => {
    it('detects new Queue and new Worker instances', () => {
      const code = `
const { Queue, Worker } = require('bullmq');

const mailQueue = new Queue('emails');
const emailWorker = new Worker('emails', async job => {});
      `;

      const hits = findQueueWorkers(code, 'src/workers/mail.js');
      expect(hits.length).toBe(2);
      expect(hits[0].skill).toBe('Job Queues');
      expect(hits[0].strength).toBe(0.8);
      expect(hits[0].lineStart).toBe(4);
      expect(hits[1].lineStart).toBe(5);
    });

    it('returns empty array on non-queue constructor calls', () => {
      const code = 'const date = new Date(); const map = new Map();';
      expect(findQueueWorkers(code, 'src/data.js')).toEqual([]);
    });
  });

  describe('README analysis & contradiction detection', () => {
    it('generates corroborating evidence (strength <= 0.5) when README skill is backed by code/manifest', () => {
      const readme = `
# Project Title
A modern web application built with Express and MongoDB.
Features full REST APIs and JWT Authentication.
      `;

      const backedSkills = new Set(['Express', 'MongoDB', 'REST APIs', 'JWT Authentication']);
      const items = analyzeReadme(readme, 'README.md', backedSkills);

      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.type).toBe('readme');
        expect(item.contradiction).toBe(false);
        expect(item.strength).toBeLessThanOrEqual(0.5);
      }
    });

    it('generates contradiction items (contradiction: true, strength: 0) when README skill is NOT backed by code/manifest', () => {
      const readme = `
# Scalable Microservices
Uses Redis distributed caching and Kafka message streams.
      `;

      // Backed skills contains only Express and MongoDB, but NOT Redis or Kafka
      const backedSkills = new Set(['Express', 'MongoDB']);
      const items = analyzeReadme(readme, 'README.md', backedSkills);

      const redisItem = items.find((i) => i.skill === 'Redis');
      expect(redisItem).toBeDefined();
      expect(redisItem.contradiction).toBe(true);
      expect(redisItem.strength).toBe(0);
      expect(redisItem.claimSupport).toMatch(/not found in manifest or AST/i);
    });
  });

  describe('analyzeSourceFile coordinator', () => {
    it('runs all AST detectors on a source file', () => {
      const code = `
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

router.get('/health', (req, res) => res.send('ok'));
const token = jwt.sign({ u: 1 }, 'key');
      `;

      const hits = analyzeSourceFile('src/routes/health.js', code);
      expect(hits.some((h) => h.skill === 'REST APIs')).toBe(true);
      expect(hits.some((h) => h.skill === 'JWT Authentication')).toBe(true);
    });
  });
});
