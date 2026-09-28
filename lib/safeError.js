'use strict';

/**
 * Formats an error for a top-level crash log WITHOUT ever risking a leaked
 * credential. An axios error object carries the raw outgoing HTTP request
 * on `err.request` (including the `Authorization` header) and the full
 * request config on `err.config` (including `headers`) - printing the raw
 * error object (e.g. via `console.error('...', err)`) serializes those and
 * would print the bearer token in plain text. This extracts only the
 * pieces that are safe to display: the message, HTTP status, the JSON
 * response body HubSpot sent back (never contains request headers), and
 * the stack trace (file/line info only, no headers).
 */
function formatFatalError(err) {
  const lines = [`Message: ${err && err.message}`];
  if (err && err.response) {
    lines.push(`HTTP Status: ${err.response.status}`);
    if (err.response.data !== undefined) {
      try {
        lines.push(`Response: ${JSON.stringify(err.response.data)}`);
      } catch (e) {
        lines.push('Response: <unserializable>');
      }
    }
  }
  if (err && err.stack) {
    lines.push('', err.stack);
  }
  return lines.join('\n');
}

module.exports = { formatFatalError };
