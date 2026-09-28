'use strict';

const { writeJson, readJsonSafe } = require('./fileStore');

/**
 * Loads the persistent source->destination mapping file, creating an empty
 * one (in memory) if it doesn't exist yet. This file is the primary source
 * of truth for duplicate prevention across script runs.
 */
function loadMapping(filePath, sourcePortalId, destinationPortalId) {
  const fallback = {
    sourcePortal: sourcePortalId || null,
    destinationPortal: destinationPortalId || null,
    forms: {},
  };
  const mapping = readJsonSafe(filePath, fallback);
  if (!mapping.forms || typeof mapping.forms !== 'object') mapping.forms = {};
  return mapping;
}

function saveMapping(filePath, mapping) {
  writeJson(filePath, mapping);
}

function upsertFormEntry(mapping, sourceFormId, patch) {
  const existing = mapping.forms[sourceFormId] || { sourceFormId };
  mapping.forms[sourceFormId] = {
    ...existing,
    ...patch,
    sourceFormId,
    lastUpdatedAt: new Date().toISOString(),
  };
  return mapping.forms[sourceFormId];
}

module.exports = { loadMapping, saveMapping, upsertFormEntry };
