import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestKit, teardownTestKit } from './helpers/testKit.js';

describe('Test Kit Smoke Test', () => {
  let kit;

  beforeAll(async () => {
    kit = await setupTestKit();
  });

  afterAll(async () => {
    await teardownTestKit();
  });

  it('boots app with in-memory Mongo and logs in two users with session cookies', async () => {
    expect(kit.userA).toBeDefined();
    expect(kit.userA.username).toBe('alice');

    expect(kit.userB).toBeDefined();
    expect(kit.userB.username).toBe('bob');

    // Verify agentA can access get-me
    const resA = await kit.agentA.get('/api/auth/get-me');
    expect(resA.status).toBe(200);
    expect(resA.body.user.username).toBe('alice');

    // Verify agentB can access get-me
    const resB = await kit.agentB.get('/api/auth/get-me');
    expect(resB.status).toBe(200);
    expect(resB.body.user.username).toBe('bob');
  });
});
