'use strict';

const path = require('path');
require('dotenv').config();

function readEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === null || !value.trim()) return null;
  return value.trim();
}

// Unlike readEnv, does not trim - some values (like a name prefix ending in
// a space, e.g. "Touchmath | ") are meaningful whitespace-sensitive.
// dotenv itself only preserves such whitespace when the value is quoted in
// the .env file (DESTINATION_NAME_PREFIX="Touchmath | "), so document that.
function readEnvPreserveWhitespace(name) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return '';
  return value;
}

/**
 * Loads and validates the environment configuration required to run the
 * migration. Exits the process (safely, before any API calls are made) if a
 * required token is missing.
 */
function loadConfig() {
  const sourceToken = readEnv('SOURCE_ACCESS_TOKEN');
  const destinationToken = readEnv('DESTINATION_ACCESS_TOKEN');

  const missing = [];
  if (!sourceToken) missing.push('SOURCE_ACCESS_TOKEN');
  if (!destinationToken) missing.push('DESTINATION_ACCESS_TOKEN');

  if (missing.length > 0) {
    for (const name of missing) {
      console.error(`${name} is not configured`);
    }
    console.error(
      'Set the required environment variables (see .env.example) before running the migration.'
    );
    process.exit(1);
  }

  const migrationDir = readEnv('MIGRATION_DIR')
    ? path.resolve(readEnv('MIGRATION_DIR'))
    : path.join(process.cwd(), 'migration');

  const defaultBaseUrl = readEnv('HUBSPOT_BASE_URL') || 'https://api.hubapi.com';

  return {
    sourceToken,
    destinationToken,
    sourcePortalId: readEnv('SOURCE_PORTAL_ID'),
    destinationPortalId: readEnv('DESTINATION_PORTAL_ID'),
    // Separate overrides let source/destination live in different HubSpot
    // data-residency regions (e.g. api-eu1.hubapi.com) or, during testing,
    // point at separate mock servers.
    sourceBaseUrl: readEnv('SOURCE_BASE_URL') || defaultBaseUrl,
    destinationBaseUrl: readEnv('DESTINATION_BASE_URL') || defaultBaseUrl,
    maxRetries: parseInt(readEnv('MAX_RETRIES') || '5', 10),
    pageLimit: parseInt(readEnv('PAGE_LIMIT') || '100', 10),
    migrationDir,
    // Optional scope-down: when this file exists, only source forms whose
    // name (trimmed) appears in it are migrated. Absent by default so
    // existing behavior (migrate everything) is unchanged.
    allowedFormsFile: readEnv('ALLOWED_FORMS_FILE')
      ? path.resolve(readEnv('ALLOWED_FORMS_FILE'))
      : path.join(process.cwd(), 'allowed-forms.txt'),
    // Optional prefix applied to every destination form's name, e.g.
    // "Touchmath | ". Empty by default (destination name == source name).
    // Quote the value in .env if it needs a trailing space.
    destinationNamePrefix: readEnvPreserveWhitespace('DESTINATION_NAME_PREFIX'),
  };
}

module.exports = { loadConfig };
