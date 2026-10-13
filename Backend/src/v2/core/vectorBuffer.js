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

function bufferToFloat32Array(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('Expected a Node.js Buffer');
  }

  if (buf.byteLength % 4 !== 0) {
    throw new Error(`Invalid buffer byteLength ${buf.byteLength}: must be a multiple of 4 for Float32Array`);
  }

  // Copy into a new, 4-byte aligned ArrayBuffer to avoid unaligned offset crashes
  const ab = new ArrayBuffer(buf.byteLength);
  const u8 = new Uint8Array(ab);
  u8.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));

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
