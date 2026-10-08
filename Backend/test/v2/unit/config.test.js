import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadConfig, ConfigError } = require('../../../src/v2/config/env');

describe('v2 Environment Configuration (loadConfig)', () => {
  const validBaseEnv = {
    MONGO_URI: 'mongodb://localhost:27017/jobfitai_test',
    JWT_SECRET: 'this_is_a_very_secure_and_long_jwt_secret_key_at_least_32_chars',
    GOOGLE_GENAI_API_KEY: 'test-genai-api-key',
  };

  it('successfully loads and freezes a valid configuration with defaults', () => {
    const config = loadConfig(validBaseEnv);

    expect(config.MONGO_URI).toBe(validBaseEnv.MONGO_URI);
    expect(config.JWT_SECRET).toBe(validBaseEnv.JWT_SECRET);
    expect(config.GOOGLE_GENAI_API_KEY).toBe(validBaseEnv.GOOGLE_GENAI_API_KEY);
    expect(config.NODE_ENV).toBe('development');
    expect(config.GEMINI_MODEL).toBe('gemini-3-flash-preview');
    expect(config.EMBEDDING_MODEL).toBe('gemini-embedding-001');
    expect(config.EMBEDDING_DIMS).toBe(768);
    expect(config.LLM_TIMEOUT_MS).toBe(30000);
    expect(config.THRESHOLD_VERIFIED).toBe(0.8);
    expect(config.THRESHOLD_REVIEW).toBe(0.5);
    expect(config.LOG_LEVEL).toBe('info');

    expect(config.PORT).toBe(3000);
    expect(typeof config.PORT).toBe('number');

    // Should be frozen
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      config.PORT = 9999;
    }).toThrow();
  });

  it('coerces PORT from a string to a positive number', () => {
    const customPortEnv = {
      ...validBaseEnv,
      PORT: '5001',
    };
    const config = loadConfig(customPortEnv);
    expect(config.PORT).toBe(5001);
    expect(typeof config.PORT).toBe('number');
  });

  it('fails with a readable message when JWT_SECRET is shorter than 32 characters', () => {
    const shortSecretEnv = {
      ...validBaseEnv,
      JWT_SECRET: 'short_secret_only_24_chrs',
    };

    expect(() => loadConfig(shortSecretEnv)).toThrow(ConfigError);

    try {
      loadConfig(shortSecretEnv);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain('JWT_SECRET');
      expect(err.message).toContain('32');
      expect(err.issues).toBeDefined();
      expect(err.issues.some((i) => i.path.includes('JWT_SECRET'))).toBe(true);
    }
  });

  it('fails when THRESHOLD_VERIFIED is less than or equal to THRESHOLD_REVIEW', () => {
    const invalidThresholdEnv = {
      ...validBaseEnv,
      THRESHOLD_VERIFIED: '0.4',
      THRESHOLD_REVIEW: '0.7',
    };

    expect(() => loadConfig(invalidThresholdEnv)).toThrow(ConfigError);

    try {
      loadConfig(invalidThresholdEnv);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain('THRESHOLD_VERIFIED');
    }
  });

  it('fails with readable messages when required keys are missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);

    try {
      loadConfig({});
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain('MONGO_URI');
      expect(err.message).toContain('JWT_SECRET');
      expect(err.message).toContain('GOOGLE_GENAI_API_KEY');
    }
  });

  it('does not mutate the input environment object', () => {
    const inputEnv = { ...validBaseEnv };
    loadConfig(inputEnv);
    expect(inputEnv).toEqual(validBaseEnv);
  });
});
