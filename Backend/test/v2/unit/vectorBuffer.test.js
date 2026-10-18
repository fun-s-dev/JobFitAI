import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  vectorToBuffer,
  bufferToFloat32Array,
  bufferToVector,
} = require('../../../src/v2/core/vectorBuffer');

describe('core/vectorBuffer (pure)', () => {
  it('converts an array of numbers to Float32 Buffer and roundtrips accurately', () => {
    const original = [0.12345, -0.6789, 1.0, 0.0, 0.55555];
    const buf = vectorToBuffer(original);

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.byteLength).toBe(original.length * 4);

    const roundtripped = bufferToVector(buf);
    expect(roundtripped.length).toBe(original.length);

    for (let i = 0; i < original.length; i++) {
      expect(roundtripped[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('safely decodes a Buffer sliced at an odd byte offset without byte alignment errors', () => {
    const original = [1.5, -2.5, 3.25];
    const fullBuffer = Buffer.alloc(30); // 30 bytes
    // Put original vector at an odd offset: byte 3
    const oddOffset = 3;
    const rawVecBuffer = vectorToBuffer(original);
    rawVecBuffer.copy(fullBuffer, oddOffset);

    // Slice at odd offset
    const sliced = fullBuffer.subarray(oddOffset, oddOffset + rawVecBuffer.byteLength);
    expect(sliced.byteOffset % 4).not.toBe(0); // confirms unaligned byte offset

    // Without copying to a fresh ArrayBuffer, new Float32Array(sliced.buffer, sliced.byteOffset)
    // throws RangeError: byte offset of Float32Array should be a multiple of 4
    const recovered = bufferToFloat32Array(sliced);
    expect(recovered.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('decodes a BSON Binary object correctly', () => {
    const { Binary } = require('bson');
    const original = [0.25, -0.75, 1.5];
    const nodeBuf = vectorToBuffer(original);
    const bsonBinary = new Binary(nodeBuf);

    const recovered = bufferToVector(bsonBinary);
    expect(recovered.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('decodes a Uint8Array correctly', () => {
    const original = [0.1, 0.2, 0.3];
    const nodeBuf = vectorToBuffer(original);
    const uint8 = new Uint8Array(nodeBuf.buffer, nodeBuf.byteOffset, nodeBuf.byteLength);

    const recovered = bufferToVector(uint8);
    expect(recovered.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('throws a TypeError for invalid input types', () => {
    expect(() => bufferToVector('not a buffer')).toThrow(/Expected a Node.js Buffer, BSON Binary, or Uint8Array/);
    expect(() => bufferToVector(12345)).toThrow(/Expected a Node.js Buffer, BSON Binary, or Uint8Array/);
    expect(() => bufferToVector({ foo: 'bar' })).toThrow(/Expected a Node.js Buffer, BSON Binary, or Uint8Array/);
    expect(() => bufferToVector(null)).toThrow(/Expected a Node.js Buffer, BSON Binary, or Uint8Array/);
    expect(() => bufferToVector(undefined)).toThrow(/Expected a Node.js Buffer, BSON Binary, or Uint8Array/);
  });
});

