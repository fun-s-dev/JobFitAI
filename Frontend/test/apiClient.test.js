import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Frontend API Client Unification & localhost:3000 hygiene', () => {
  function getAllFiles(dirPath, arrayOfFiles = []) {
    const files = fs.readdirSync(dirPath);

    files.forEach((file) => {
      const fullPath = path.join(dirPath, file);
      if (fs.statSync(fullPath).isDirectory()) {
        getAllFiles(fullPath, arrayOfFiles);
      } else {
        arrayOfFiles.push(fullPath);
      }
    });

    return arrayOfFiles;
  }

  it('ensures zero occurrences of hardcoded localhost:3000 across all Frontend/src source files', () => {
    const srcDir = path.resolve(__dirname, '../src');
    const allFiles = getAllFiles(srcDir);

    const violations = [];

    allFiles.forEach((file) => {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('localhost:3000')) {
        violations.push(path.relative(srcDir, file));
      }
    });

    expect(violations).toEqual([]);
  });
});
