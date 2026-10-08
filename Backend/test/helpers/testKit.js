import { createRequire } from 'node:module';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

const require = createRequire(import.meta.url);
const mongoose = require('mongoose');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-very-long-key-32-chars-minimum';
process.env.NODE_ENV = 'test';

let mongoServer;
let appInstance;

export async function setupTestKit() {
  if (!mongoServer) {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
  }

  if (!appInstance) {
    appInstance = require('../../src/app');
  }

  // Clear database collections
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }

  const agentA = request.agent(appInstance);
  const agentB = request.agent(appInstance);

  const userAPayload = {
    username: 'alice',
    email: 'alice@example.com',
    password: 'Password123!',
  };

  const userBPayload = {
    username: 'bob',
    email: 'bob@example.com',
    password: 'Password123!',
  };

  // Register & log in User A
  const resRegA = await agentA.post('/api/auth/register').send(userAPayload);
  const userA = resRegA.body.user;

  // Register & log in User B
  const resRegB = await agentB.post('/api/auth/register').send(userBPayload);
  const userB = resRegB.body.user;

  return {
    app: appInstance,
    agentA,
    agentB,
    userA,
    userB,
    mongoose,
    require,
  };
}

export async function teardownTestKit() {
  if (mongoose.connection.readyState !== 0) {
    const collections = mongoose.connection.collections;
    for (const key of Object.keys(collections)) {
      await collections[key].deleteMany({});
    }
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
    mongoServer = null;
  }
}
