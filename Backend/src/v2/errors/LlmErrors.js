class LlmValidationError extends Error {
  constructor(purpose, issues) {
    const issueSummary = issues && Array.isArray(issues)
      ? issues.map((i) => `[${(i.path || []).join('.')}] ${i.message}`).join('; ')
      : 'Schema validation failed';
    super(`LLM output validation failed for ${purpose}: ${issueSummary}`);
    this.name = 'LlmValidationError';
    this.purpose = purpose;
    this.issues = issues;
    this.statusCode = 502;
  }
}

class LlmClientError extends Error {
  constructor(message, originalError = null, statusCode = 502) {
    super(message);
    this.name = 'LlmClientError';
    this.statusCode = statusCode;
    if (originalError && originalError.status) {
      this.upstreamStatus = originalError.status;
    }
  }
}

module.exports = {
  LlmValidationError,
  LlmClientError,
};
