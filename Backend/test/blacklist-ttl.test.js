import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestKit, teardownTestKit } from './helpers/testKit.js';

describe('Blacklist Token TTL Index Test', () => {
  let kit;
  let tokenBlacklistModel;

  beforeAll(async () => {
    kit = await setupTestKit();
    tokenBlacklistModel = kit.require('../../src/models/blacklist.model');
  });

  afterAll(async () => {
    await teardownTestKit();
  });

  it('verifies createdAt field in schema and TTL index with expireAfterSeconds 86400', async () => {
    // Verify timestamps: true creates createdAt in schema definition
    expect(tokenBlacklistModel.schema.paths.createdAt).toBeDefined();

    // Ensure Mongoose index creation is finished in MongoDB
    await tokenBlacklistModel.init();

    // Read indexes directly from the MongoDB collection
    const indexes = await tokenBlacklistModel.collection.indexes();

    const ttlIndex = indexes.find(
      (idx) => idx.key && idx.key.createdAt === 1 && idx.expireAfterSeconds === 86400
    );

    expect(ttlIndex).toBeDefined();
    expect(ttlIndex.expireAfterSeconds).toBe(86400);
  });
});
