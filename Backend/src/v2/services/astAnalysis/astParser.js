const acorn = require('acorn');

/**
 * Parses JavaScript source code to an AST using acorn.
 * Tries sourceType: 'module' first, then falls back to 'script'.
 * Returns null for unsupported syntax (such as TypeScript or JSX) or syntax errors.
 * Never throws an error.
 *
 * @param {string} sourceCode
 * @returns {object|null} Acorn AST or null
 */
function parseSource(sourceCode) {
  if (typeof sourceCode !== 'string' || !sourceCode.trim()) {
    return null;
  }

  try {
    return acorn.parse(sourceCode, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowHashBang: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });
  } catch {
    try {
      return acorn.parse(sourceCode, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        locations: true,
        allowHashBang: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
      });
    } catch {
      // JSX / TypeScript / syntax errors gracefully ignored
      return null;
    }
  }
}

module.exports = {
  parseSource,
};
