'use strict';

const { normalizeForComparison } = require('./normalize');
const { computeDiff } = require('./diff');

/**
 * Compares a source form definition against a destination form definition
 * after stripping portal-generated fields (id, timestamps, etc.). Returns
 * `{ matched, differences }` - `matched` is true only when every remaining
 * field (name, formType, fieldGroups, configuration, displayOptions,
 * legalConsentOptions, ...) is identical.
 *
 * `expectedName`, when given, overrides the name the destination is
 * compared against - e.g. when a naming rule (prefix) is configured, the
 * destination is intentionally named differently from the source, and
 * comparing against the raw source name would produce a false-positive
 * mismatch on every single form.
 */
function verifyForm(sourceDef, destinationDef, { expectedName } = {}) {
  const normalizedSource = normalizeForComparison(sourceDef);
  if (expectedName) normalizedSource.name = expectedName;
  const normalizedDestination = normalizeForComparison(destinationDef);
  const differences = computeDiff(normalizedSource, normalizedDestination);
  return { matched: differences.length === 0, differences };
}

module.exports = { verifyForm };
