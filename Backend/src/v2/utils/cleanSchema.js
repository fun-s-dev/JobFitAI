/**
 * Strips $schema and additionalProperties keys that the Gemini API rejects.
 * Duplicated from v1 (src/services/ai.service.js) to preserve v1 freeze.
 */
function cleanSchemaForGemini(schema) {
  const copy = JSON.parse(JSON.stringify(schema));
  function strip(obj) {
    if (obj && typeof obj === 'object') {
      delete obj['$schema'];
      delete obj['additionalProperties'];
      for (const val of Object.values(obj)) strip(val);
    }
  }
  strip(copy);
  return copy;
}

module.exports = { cleanSchemaForGemini };
