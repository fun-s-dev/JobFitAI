import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const EmbeddingCache = require('../../../src/v2/models/embeddingCache.model');
const { vectorToBuffer, bufferToVector } = require('../../../src/v2/core/vectorBuffer');

describe('EmbeddingCache integration with mongodb-memory-server (.lean() round-trip)', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
    await EmbeddingCache.init();
  }, 60000);

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongoServer) {
      await mongoServer.stop();
    }
  }, 60000);

  it('round-trips Float32Array vector through real MongoDB and .lean() read', async () => {
    const testVector = [0.123456, -0.654321, 0.987654, 0.0, -1.0, 0.5];
    const key = 'test-roundtrip-key-lean-1';

    // 1. Write through real Mongoose EmbeddingCache model
    const buf = vectorToBuffer(testVector);
    await EmbeddingCache.create({
      key,
      vector: buf,
      dims: testVector.length,
      model: 'gemini-embedding-001',
      taskType: 'SEMANTIC_SIMILARITY',
    });

    // 2. Read back with .lean()
    const doc = await EmbeddingCache.findOne({ key }).lean();
    expect(doc).toBeDefined();
    expect(doc.key).toBe(key);

    // Assert that the stored vector deserializes properly into Float32 numbers
    const roundTripped = bufferToVector(doc.vector);
    expect(roundTripped).toHaveLength(testVector.length);
    for (let i = 0; i < testVector.length; i++) {
      expect(roundTripped[i]).toBeCloseTo(testVector[i], 5);
    }
  });
});
