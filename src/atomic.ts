// Atomic file-write helper. On a crash mid-write, the target file is
// either the old content or the new content — never a half-written file.

import { writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

export function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (err) {
    // Some Windows edge cases need the target to not exist. Retry if needed.
    if (existsSync(path)) {
      renameSync(tmp, path);
    } else {
      throw err;
    }
  }
}
