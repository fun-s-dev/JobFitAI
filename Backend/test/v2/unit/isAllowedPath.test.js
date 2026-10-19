import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAllowedPath, filterAllowedTree, MAX_FILES_CAP, MAX_TOTAL_BYTES_CAP } = require('../../../src/v2/core/isAllowedPath');

describe('core/isAllowedPath (pure)', () => {
  describe('isAllowedPath checks', () => {
    it('allows manifests at root and subdirectories', () => {
      expect(isAllowedPath('package.json').allowed).toBe(true);
      expect(isAllowedPath('backend/package.json').allowed).toBe(true);
      expect(isAllowedPath('requirements.txt').allowed).toBe(true);
      expect(isAllowedPath('pyproject.toml').allowed).toBe(true);
      expect(isAllowedPath('pom.xml').allowed).toBe(true);
      expect(isAllowedPath('build.gradle').allowed).toBe(true);
      expect(isAllowedPath('go.mod').allowed).toBe(true);
    });

    it('allows README variants (case-insensitive)', () => {
      expect(isAllowedPath('README.md').allowed).toBe(true);
      expect(isAllowedPath('README').allowed).toBe(true);
      expect(isAllowedPath('readme.txt').allowed).toBe(true);
      expect(isAllowedPath('docs/README.rst').allowed).toBe(true);
    });

    it('allows source files under allowlisted folders', () => {
      expect(isAllowedPath('src/index.js').allowed).toBe(true);
      expect(isAllowedPath('server/app.js').allowed).toBe(true);
      expect(isAllowedPath('backend/routes/auth.js').allowed).toBe(true);
      expect(isAllowedPath('app/controllers/userController.js').allowed).toBe(true);
      expect(isAllowedPath('models/user.js').allowed).toBe(true);
      expect(isAllowedPath('services/queue.js').allowed).toBe(true);
      expect(isAllowedPath('api/v1/endpoints.py').allowed).toBe(true);
    });

    it('allows test files and test directories', () => {
      expect(isAllowedPath('src/utils.test.js').allowed).toBe(true);
      expect(isAllowedPath('controllers/auth.spec.ts').allowed).toBe(true);
      expect(isAllowedPath('test/auth.test.js').allowed).toBe(true);
      expect(isAllowedPath('__tests__/login.js').allowed).toBe(true);
      expect(isAllowedPath('tests/unit/test_api.py').allowed).toBe(true);
    });

    it('rejects files over 100 KB (102,400 bytes)', () => {
      expect(isAllowedPath('src/large.js', 100 * 1024).allowed).toBe(true);
      const res = isAllowedPath('src/huge.js', 100 * 1024 + 1);
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/size|large/i);
    });

    it('rejects .env files and variants', () => {
      expect(isAllowedPath('.env').allowed).toBe(false);
      expect(isAllowedPath('.env.production').allowed).toBe(false);
      expect(isAllowedPath('backend/.env.local').allowed).toBe(false);
      expect(isAllowedPath('config/.env.test').allowed).toBe(false);
    });

    it('rejects key files and certificates (*.pem, *.key, id_rsa*)', () => {
      expect(isAllowedPath('server.key').allowed).toBe(false);
      expect(isAllowedPath('cert.pem').allowed).toBe(false);
      expect(isAllowedPath('id_rsa').allowed).toBe(false);
      expect(isAllowedPath('id_rsa.pub').allowed).toBe(false);
      expect(isAllowedPath('.ssh/id_rsa_backup').allowed).toBe(false);
    });

    it('rejects lockfiles', () => {
      expect(isAllowedPath('package-lock.json').allowed).toBe(false);
      expect(isAllowedPath('yarn.lock').allowed).toBe(false);
      expect(isAllowedPath('pnpm-lock.yaml').allowed).toBe(false);
      expect(isAllowedPath('Pipfile.lock').allowed).toBe(false);
      expect(isAllowedPath('poetry.lock').allowed).toBe(false);
      expect(isAllowedPath('Cargo.lock').allowed).toBe(false);
      expect(isAllowedPath('go.sum').allowed).toBe(false);
    });

    it('rejects node_modules, dist, and build directories', () => {
      expect(isAllowedPath('node_modules/express/index.js').allowed).toBe(false);
      expect(isAllowedPath('dist/bundle.js').allowed).toBe(false);
      expect(isAllowedPath('build/static/main.js').allowed).toBe(false);
      expect(isAllowedPath('.git/config').allowed).toBe(false);
    });

    it('rejects binary extensions', () => {
      expect(isAllowedPath('assets/image.png').allowed).toBe(false);
      expect(isAllowedPath('public/logo.jpg').allowed).toBe(false);
      expect(isAllowedPath('bin/app.exe').allowed).toBe(false);
      expect(isAllowedPath('archive.zip').allowed).toBe(false);
      expect(isAllowedPath('docs/manual.pdf').allowed).toBe(false);
      expect(isAllowedPath('db.sqlite').allowed).toBe(false);
    });

    it('rejects unrelated top-level files not on allowlist', () => {
      expect(isAllowedPath('deploy.sh').allowed).toBe(false);
      expect(isAllowedPath('Dockerfile').allowed).toBe(false);
      expect(isAllowedPath('notes.txt').allowed).toBe(false);
      expect(isAllowedPath('unknown/folder/file.js').allowed).toBe(false);
    });
  });

  describe('filterAllowedTree caps', () => {
    it('enforces maximum 40 files cap', () => {
      const tree = [];
      for (let i = 0; i < 60; i++) {
        tree.push({ path: `src/file_${i}.js`, size: 1000, type: 'blob' });
      }
      const filtered = filterAllowedTree(tree);
      expect(filtered.length).toBeLessThanOrEqual(MAX_FILES_CAP);
      expect(filtered.length).toBe(40);
    });

    it('enforces 500,000 bytes maximum cap', () => {
      const tree = [
        { path: 'package.json', size: 2000, type: 'blob' },
        { path: 'src/big1.js', size: 90000, type: 'blob' },
        { path: 'src/big2.js', size: 90000, type: 'blob' },
        { path: 'src/big3.js', size: 90000, type: 'blob' },
        { path: 'src/big4.js', size: 90000, type: 'blob' },
        { path: 'src/big5.js', size: 90000, type: 'blob' },
        { path: 'src/big6.js', size: 90000, type: 'blob' }, // would exceed 500k
      ];
      const filtered = filterAllowedTree(tree);
      const totalBytes = filtered.reduce((acc, f) => acc + (f.size || 0), 0);
      expect(totalBytes).toBeLessThanOrEqual(MAX_TOTAL_BYTES_CAP);
      expect(filtered.length).toBe(6);
    });

    it('prioritizes manifests and README over arbitrary source files', () => {
      const tree = [];
      for (let i = 0; i < 45; i++) {
        tree.push({ path: `src/file_${i}.js`, size: 1000, type: 'blob' });
      }
      tree.push({ path: 'package.json', size: 500, type: 'blob' });
      tree.push({ path: 'README.md', size: 1500, type: 'blob' });

      const filtered = filterAllowedTree(tree);
      expect(filtered.some((f) => f.path === 'package.json')).toBe(true);
      expect(filtered.some((f) => f.path === 'README.md')).toBe(true);
      expect(filtered.length).toBe(40);
    });
  });
});
