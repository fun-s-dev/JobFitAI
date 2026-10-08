/**
 * Test fake for llmClient.
 * Provides a canned/scripted implementation of the llmClient interface
 * (generateStructured, embed) for downstream services without touching the network or SDK.
 */
function makeFakeLlm({ responses = [], embedResponses = [] } = {}) {
  let responseIndex = 0;
  let embedIndex = 0;
  const recordedCalls = [];
  const recordedEmbedCalls = [];

  return {
    recordedCalls,
    recordedEmbedCalls,

    async generateStructured({ purpose, system, prompt, schema, temperature, thinkingLevel, user, runId }) {
      recordedCalls.push({
        purpose,
        system,
        prompt,
        schema,
        temperature,
        thinkingLevel,
        user,
        runId,
      });

      if (responseIndex >= responses.length) {
        throw new Error(`makeFakeLlm: No more canned responses available (called ${recordedCalls.length} times)`);
      }

      const next = responses[responseIndex++];
      if (next instanceof Error) {
        throw next;
      }

      // If a schema was provided, validate canned response to ensure test fixtures are realistic
      if (schema && typeof schema.parse === 'function') {
        return schema.parse(next);
      }

      return next;
    },

    async embed(texts, options = {}) {
      recordedEmbedCalls.push({ texts, options });

      if (embedResponses.length > 0) {
        if (embedIndex >= embedResponses.length) {
          throw new Error('makeFakeLlm: No more canned embed responses available');
        }
        return embedResponses[embedIndex++];
      }

      // Default fallback: return dummy unit vectors of length 768
      const list = Array.isArray(texts) ? texts : [texts];
      return list.map(() => {
        return Array.from({ length: 768 }, (_, idx) => (idx === 0 ? 1.0 : 0.0));
      });
    },
  };
}

module.exports = {
  makeFakeLlm,
};
