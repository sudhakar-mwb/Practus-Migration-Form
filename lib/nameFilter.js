'use strict';

const fs = require('fs');

/**
 * Loads a plain-text, one-name-per-line allowlist of source form names.
 * Returns `null` (meaning "no filtering, migrate everything") if the file
 * doesn't exist - this keeps the default behavior unchanged for anyone not
 * using this feature. Blank lines are ignored; names are trimmed so
 * incidental leading/trailing whitespace in the list doesn't cause a form
 * to be missed.
 */
function loadAllowedFormNames(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const names = new Set();
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) names.add(trimmed);
  }
  return names;
}

/**
 * Builds the name the destination form should have. Trims the source name
 * before prefixing so an accidental trailing space on the source form
 * doesn't end up sandwiched between the prefix and the name.
 */
function buildDestinationName(sourceName, prefix) {
  const trimmedSource = (sourceName || '').trim();
  if (!prefix) return trimmedSource;
  return `${prefix}${trimmedSource}`;
}

module.exports = { loadAllowedFormNames, buildDestinationName };
