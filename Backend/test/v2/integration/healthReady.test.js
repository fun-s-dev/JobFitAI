import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setupTestKit, teardownTestKit } from '../../helpers/testKit.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mongoose = require('mongoose');

describe('Health and Readiness Endpoints', () => {
  let kit;

  beforeAll(async () => {
    kit = await setupTestKit();
  });

  afterAll(async () => {
    await teardownTestKit();
  });

  describe('GET /health (Liveness)', () => {
    it('returns 200 with status ok and uptime', async () => {
      const res = await request(kit.app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.uptime).toBe('number');
      expect(res.body.timestamp).toBeDefined();
    });

    it('returns 200 on /api/v2/health as well', async () => {
      const res = await request(kit.app).get('/api/v2/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('GET /ready (Readiness)', () => {
    it('returns 200 with status ready when MongoDB is connected', async () => {
      expect(mongoose.connection.readyState).toBe(1);

      const res = await request(kit.app).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.mongo).toBe('connected');
    });

    it('returns 503 with status not_ready when MongoDB is disconnected', async () => {
      const originalDescriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(mongoose.connection),
        'readyState'
      ) || Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');

      // Define writable readyState = 0
      Object.defineProperty(mongoose.connection, 'readyState', {
        value: 0,
        configurable: true,
        writable: true,
      });

      try {
        const res = await request(kit.app).get('/ready');
        expect(res.status).toBe(503);
        expect(res.body.status).toBe('not_ready');
        expect(res.body.mongo).toBe('disconnected');
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(mongoose.connection, 'readyState', originalDescriptor);
        } else {
          delete mongoose.connection.readyState;
        }
      }
    });
  });
});
