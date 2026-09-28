'use strict';

// Fields confirmed (via the live HubSpot Forms v3 OpenAPI schema) to be
// generated/owned by the portal a form lives in, rather than meaningful form
// configuration. These are the only fields stripped for comparison purposes.
// NOTE: `id` is the only one of these actually present on
// HubSpotFormDefinition per the current schema; the others are included
// defensively in case HubSpot adds them or an older/legacy portal returns
// them.
const GENERATED_TOP_LEVEL_FIELDS = ['id', 'guid', 'portalId', 'createdAt', 'updatedAt', 'archivedAt'];

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Produces a copy of a form definition with portal-generated fields removed,
 * suitable for deep-comparison between a source and destination form. This
 * intentionally does NOT reorder arrays or drop any real configuration -
 * field order, labels, validation, etc. are all preserved so the diff can
 * catch meaningful mismatches.
 */
function normalizeForComparison(formDef) {
  const clone = deepClone(formDef || {});
  for (const field of GENERATED_TOP_LEVEL_FIELDS) {
    delete clone[field];
  }
  return clone;
}

module.exports = { normalizeForComparison, deepClone, GENERATED_TOP_LEVEL_FIELDS };
