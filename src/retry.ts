// Retry helper with exponential backoff. Kalshi API occasionally returns
// 5xx or connection errors; one retry usually suffices.

export interface RetryOpts {
  attempts?: number;
  initialDelayMs?: number;
  backoff?: number;
  isRetryable?: (err: unknown) => boolean;
}

const DEFAULTS: Required<RetryOpts> = {
  attempts: 3,
  initialDelayMs: 400,
  backoff: 2,
  isRetryable: (err) => {
    const msg = String(err);
    return /5\d\d|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(msg);
  },
};

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const o = { ...DEFAULTS, ...opts };
  let lastErr: unknown;
  let delay = o.initialDelayMs;
  for (let i = 0; i < o.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === o.attempts - 1 || !o.isRetryable(err)) break;
      await new Promise((r) => setTimeout(r, delay));
      delay *= o.backoff;
    }
  }
  throw lastErr;
}
