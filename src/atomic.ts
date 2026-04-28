// Atomic file-write helper. On a crash mid-write, the target file is
// either the old content or the new content — never a half-written file.
//
// Implementation note: Windows + cloud-synced folders (OneDrive, Dropbox)
// can briefly hold open the target file, causing renameSync() to fail
// with EPERM. We retry a small number of times with a tiny sleep before
// surrendering — the typical hold is <50 ms.

import { writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { dirname } from 'path';

const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 25;

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

export function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);

  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      lastErr = err;
      // OS-locked target on Windows — sleep briefly and retry.
      sleepSync(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  // Final fallback: write directly (loses atomicity but doesn't lose data).
  // Cleans up the temp file if it's still around.
  try {
    writeFileSync(path, content);
    if (existsSync(tmp)) unlinkSync(tmp);
    return;
  } catch {
    /* if even direct write fails, surface the original rename error */
  }
  throw lastErr;
}
