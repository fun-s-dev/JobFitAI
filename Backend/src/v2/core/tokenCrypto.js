const crypto = require('node:crypto');

/**
 * AES-256-GCM encryption for secrets stored in MongoDB (GitHub access/refresh tokens, PKCE verifiers).
 * Pure module: no I/O. The key is supplied by the caller.
 *
 * Format: "v1.<iv>.<authTag>.<ciphertext>" (base64url). `aad` (additional authenticated data) binds a
 * ciphertext to its owner, so a value copied from one user's record into another's fails to decrypt.
 */

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;

class TokenCryptoError extends Error {
  constructor(message = 'Token could not be decrypted') {
    super(message);
    this.name = 'TokenCryptoError';
  }
}

/** @param {string} base64Key base64 of exactly 32 bytes */
function parseKey(base64Key) {
  const key = Buffer.from(String(base64Key || ''), 'base64');
  if (key.length !== 32) {
    throw new TokenCryptoError('Encryption key must be 32 bytes (base64)');
  }
  return key;
}

function encrypt(plaintext, key, aad) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TokenCryptoError('Nothing to encrypt');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decrypt(payload, key, aad) {
  const parts = typeof payload === 'string' ? payload.split('.') : [];
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new TokenCryptoError();
  }
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, wrong owner (aad), or tampered data: never reveal which
    throw new TokenCryptoError();
  }
}

module.exports = { encrypt, decrypt, parseKey, TokenCryptoError };
