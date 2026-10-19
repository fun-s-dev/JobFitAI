const path = require('node:path');

const MAX_FILE_SIZE_BYTES = 100 * 1024; // 100 KB = 102,400 bytes
const MAX_FILES_CAP = 40;
const MAX_TOTAL_BYTES_CAP = 500000; // 500 KB

const DENIED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.next',
  'out',
  'coverage',
  '.cache',
  '.vscode',
  '.idea',
  'target',
  'vendor',
]);

const LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pipfile.lock',
  'poetry.lock',
  'cargo.lock',
  'composer.lock',
  'go.sum',
]);

const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.jar', '.war', '.wasm', '.pyc', '.pyo', '.class',
  '.db', '.sqlite', '.sqlite3',
  '.mp4', '.mp3', '.mov', '.avi',
  '.woff', '.woff2', '.ttf', '.eot',
]);

const MANIFEST_NAMES = new Set([
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'go.mod',
]);

const ALLOWED_SOURCE_DIRS = new Set([
  'src',
  'server',
  'backend',
  'app',
  'routes',
  'controllers',
  'models',
  'services',
  'api',
]);

const ALLOWED_TEST_DIRS = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
]);

/**
 * Determines whether a file path within a repository is allowed to be fetched and inspected.
 *
 * @param {string} filePath - Relative file path (e.g. "src/index.js")
 * @param {number} [fileSize] - File size in bytes if known
 * @returns {{ allowed: boolean, reason?: string }}
 */
function isAllowedPath(filePath, fileSize) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { allowed: false, reason: 'Empty or invalid file path' };
  }

  // Size cap check
  if (typeof fileSize === 'number' && fileSize > MAX_FILE_SIZE_BYTES) {
    return { allowed: false, reason: `File size ${fileSize} exceeds maximum limit of ${MAX_FILE_SIZE_BYTES} bytes (100 KB)` };
  }

  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  const baseName = segments[segments.length - 1];
  const baseNameLower = baseName.toLowerCase();
  const ext = path.extname(baseName).toLowerCase();

  // Denylist: directories
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i].toLowerCase();
    if (DENIED_DIRS.has(dir)) {
      return { allowed: false, reason: `Path contains denylisted directory: ${dir}` };
    }
  }

  // Denylist: .env* files
  if (baseNameLower === '.env' || baseNameLower.startsWith('.env.')) {
    return { allowed: false, reason: 'Environment configuration files (.env) are denylisted' };
  }

  // Denylist: secret / key files (*.pem, *.key, id_rsa*)
  if (ext === '.pem' || ext === '.key' || baseNameLower.startsWith('id_rsa')) {
    return { allowed: false, reason: 'Cryptographic key and certificate files are denylisted' };
  }

  // Denylist: lockfiles
  if (LOCKFILES.has(baseNameLower)) {
    return { allowed: false, reason: 'Lockfiles are denylisted' };
  }

  // Denylist: binaries and media
  if (BINARY_EXTENSIONS.has(ext)) {
    return { allowed: false, reason: `Binary extension ${ext} is denylisted` };
  }

  // Allowlist check 1: Manifests
  if (MANIFEST_NAMES.has(baseNameLower)) {
    return { allowed: true };
  }

  // Allowlist check 2: README*
  if (baseNameLower.startsWith('readme')) {
    return { allowed: true };
  }

  // Allowlist check 3: Tests (*.test.*, *.spec.*, or inside test directories)
  const isTestFile =
    /\.(test|spec)\.[a-zA-Z0-9]+$/i.test(baseName) ||
    segments.some((seg) => ALLOWED_TEST_DIRS.has(seg.toLowerCase()));

  if (isTestFile) {
    return { allowed: true };
  }

  // Allowlist check 4: Source files under allowed folders
  const isInSourceDir = segments.slice(0, -1).some((seg) => ALLOWED_SOURCE_DIRS.has(seg.toLowerCase()));
  if (isInSourceDir) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'Path does not match any allowlisted manifest, README, test, or source directory' };
}

/**
 * Filters a repository tree (from git.getTree) using the allowlist and hard caps.
 * Prioritizes manifests, then README, then source & test files.
 *
 * @param {Array<{ path: string, size?: number, type?: string }>} treeEntries
 * @param {object} [options]
 * @param {number} [options.maxFiles=40]
 * @param {number} [options.maxTotalBytes=500000]
 * @returns {Array<{ path: string, size?: number, type?: string }>}
 */
function filterAllowedTree(treeEntries, options = {}) {
  const maxFiles = options.maxFiles ?? MAX_FILES_CAP;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES_CAP;

  if (!Array.isArray(treeEntries)) {
    return [];
  }

  const allowedEntries = [];

  for (const entry of treeEntries) {
    if (entry.type && entry.type !== 'blob') {
      continue;
    }
    const check = isAllowedPath(entry.path, entry.size);
    if (check.allowed) {
      allowedEntries.push(entry);
    }
  }

  // Priority sorting:
  // 1. Manifests (priority 0)
  // 2. README (priority 1)
  // 3. Tests & Source (priority 2)
  function getPriority(p) {
    const lower = path.basename(p).toLowerCase();
    if (MANIFEST_NAMES.has(lower)) return 0;
    if (lower.startsWith('readme')) return 1;
    return 2;
  }

  allowedEntries.sort((a, b) => {
    const priA = getPriority(a.path);
    const priB = getPriority(b.path);
    if (priA !== priB) return priA - priB;
    return a.path.localeCompare(b.path);
  });

  const selected = [];
  let currentBytes = 0;

  for (const entry of allowedEntries) {
    if (selected.length >= maxFiles) {
      break;
    }
    const entrySize = typeof entry.size === 'number' ? entry.size : 0;
    if (currentBytes + entrySize > maxTotalBytes) {
      continue;
    }
    selected.push(entry);
    currentBytes += entrySize;
  }

  return selected;
}

module.exports = {
  isAllowedPath,
  filterAllowedTree,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_CAP,
  MAX_TOTAL_BYTES_CAP,
};
