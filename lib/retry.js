'use strict';

const DEFAULT_MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  if (err.response && typeof err.response.status === 'number') {
    return RETRYABLE_STATUSES.has(err.response.status);
  }
  // No response object at all => network/timeout style failure.
  if (err.code && RETRYABLE_NETWORK_CODES.has(err.code)) return true;
  if (err.message && /timeout/i.test(err.message)) return true;
  return false;
}

/**
 * Determines the delay before the next retry attempt, honoring a
 * `Retry-After` header (seconds, or an HTTP date) when present, otherwise
 * falling back to exponential backoff: 1s, 2s, 4s, 8s, 16s, ...
 */
function getRetryDelayMs(err, attempt) {
  const retryAfterHeader = err.response && err.response.headers && err.response.headers['retry-after'];
  if (retryAfterHeader) {
    const asSeconds = Number(retryAfterHeader);
    if (!Number.isNaN(asSeconds)) return Math.max(0, asSeconds * 1000);
    const asDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  }
  return BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

/**
 * Runs `fn(attempt)` with retry + exponential backoff for retryable HTTP
 * statuses (429, 500, 502, 503, 504) and network/timeout errors. Throws the
 * last error once `maxRetries` attempts have been exhausted or the error is
 * not retryable.
 */
async function withRetry(fn, { maxRetries = DEFAULT_MAX_RETRIES, onRetry } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = isRetryableError(err);
      if (!retryable || attempt >= maxRetries) {
        err.attempt = attempt;
        err.exhausted = true;
        throw err;
      }
      const delay = getRetryDelayMs(err, attempt);
      if (onRetry) onRetry({ attempt, delay, err });
      await sleep(delay);
    }
  }
}

module.exports = { withRetry, isRetryableError, getRetryDelayMs };
