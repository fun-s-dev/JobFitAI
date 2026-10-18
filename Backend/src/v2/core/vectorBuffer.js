/**
 * Pure functions for serializing and deserializing Float32 embedding vectors to/from Node Buffers.
 *
 * Avoids the Node.js Buffer unaligned byte offset pitfall:
 * Node Buffers from pools or mongo reads can start at arbitrary unaligned byteOffsets.
 * Constructing `new Float32Array(buf.buffer, buf.byteOffset, length)` throws a RangeError
 * if buf.byteOffset is not a multiple of 4.
 * We safely copy bytes into a freshly allocated ArrayBuffer before instantiating Float32Array.
 */

function vectorToBuffer(vector) {
  if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) {
    throw new TypeError('Expected an array or TypedArray of numbers');
  }

  const float32 = vector instanceof Float32Array ? vector : new Float32Array(vector);
  // Allocate a dedicated Buffer with exact byte slice
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

function normalizeToBuffer(input) {
  if (Buffer.isBuffer(input)) {
    return input;
  }

  // Handle BSON Binary (e.g. from mongoose .lean() query or bson package)
  if (input && (input._bsontype === 'Binary' || input.constructor?.name === 'Binary')) {
    const inner = input.buffer;
    if (!inner) {
      throw new TypeError('Expected a Node.js Buffer, BSON Binary, or Uint8Array (BSON Binary has no inner buffer)');
    }
    const len =
      typeof input.length === 'function'
        ? input.length()
        : typeof input.length === 'number'
          ? input.length
          : (input.position ?? inner.length);
    const innerBuf = Buffer.isBuffer(inner)
      ? inner
      : Buffer.from(inner.buffer || inner, inner.byteOffset || 0, inner.byteLength || len);
    return innerBuf.subarray(0, len);
  }

  // Handle Uint8Array
  if (input instanceof Uint8Array || (input && input.constructor?.name === 'Uint8Array')) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }

  throw new TypeError('Expected a Node.js Buffer, BSON Binary, or Uint8Array');
}

function bufferToFloat32Array(buf) {
  const normalized = normalizeToBuffer(buf);

  if (normalized.byteLength % 4 !== 0) {
    throw new Error(`Invalid buffer byteLength ${normalized.byteLength}: must be a multiple of 4 for Float32Array`);
  }

  // Copy into a new, 4-byte aligned ArrayBuffer to avoid unaligned offset crashes
  const ab = new ArrayBuffer(normalized.byteLength);
  const u8 = new Uint8Array(ab);
  u8.set(new Uint8Array(normalized.buffer, normalized.byteOffset, normalized.byteLength));

  return new Float32Array(ab);
}

function bufferToVector(buf) {
  const f32 = bufferToFloat32Array(buf);
  return Array.from(f32);
}

module.exports = {
  vectorToBuffer,
  bufferToFloat32Array,
  bufferToVector,
};

