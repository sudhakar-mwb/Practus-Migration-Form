'use strict';

const fs = require('fs');
const path = require('path');

function timestamp() {
  return new Date().toISOString();
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

/**
 * Structured file + console logger. Writes four separate log files as
 * required by the migration spec:
 *   - migration.log     general progress
 *   - success.log       successfully migrated + verified forms
 *   - errors.log        all failures / API errors (full detail)
 *   - api-requests.log  every API request/response (never includes tokens)
 */
class Logger {
  constructor(migrationDir) {
    this.dir = migrationDir;
    fs.mkdirSync(migrationDir, { recursive: true });
    this.files = {
      migration: path.join(migrationDir, 'migration.log'),
      success: path.join(migrationDir, 'success.log'),
      errors: path.join(migrationDir, 'errors.log'),
      apiRequests: path.join(migrationDir, 'api-requests.log'),
    };
  }

  _append(file, text) {
    fs.appendFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  }

  logInfo(message) {
    const line = `[${timestamp()}] [INFO] ${message}`;
    console.log(line);
    this._append(this.files.migration, line);
  }

  logWarn(message) {
    const line = `[${timestamp()}] [WARNING] ${message}`;
    console.warn(line);
    this._append(this.files.migration, line);
  }

  logSuccess({ sourceFormId, destinationFormId, name, status }) {
    const line = `[${timestamp()}] SUCCESS sourceFormId=${sourceFormId} destinationFormId=${destinationFormId} name=${safeStringify(
      name
    )} status=${status}`;
    console.log(line);
    this._append(this.files.success, line);
    this._append(this.files.migration, line);
  }

  logError({ sourceFormId, destinationFormId, operation, status, message, responseData, extra }) {
    const block = [
      `${timestamp()}`,
      `Operation: ${operation}`,
      `Source Form: ${sourceFormId !== undefined ? sourceFormId : 'n/a'}`,
      destinationFormId ? `Destination Form: ${destinationFormId}` : null,
      `Status: ${status !== undefined && status !== null ? status : 'n/a'}`,
      'Result: FAILED',
      `Message: ${message}`,
      responseData !== undefined ? `Response: ${safeStringify(responseData)}` : null,
      extra !== undefined ? `Extra: ${safeStringify(extra)}` : null,
      '',
    ]
      .filter((line) => line !== null)
      .join('\n');

    this._append(this.files.errors, block);

    const summaryLine = `[${timestamp()}] [ERROR] ${operation} failed for source form ${
      sourceFormId !== undefined ? sourceFormId : 'n/a'
    }: ${message}`;
    console.error(summaryLine);
    this._append(this.files.migration, summaryLine);
  }

  logApiRequest({ method, endpoint, formId, operation, attempt, status, result, error }) {
    const block = [
      `${timestamp()}`,
      `${method} ${endpoint}`,
      `Form: ${formId !== undefined && formId !== null ? formId : 'n/a'}`,
      `Operation: ${operation}`,
      `Attempt: ${attempt}`,
      `Status: ${status !== undefined && status !== null ? status : 'NETWORK_ERROR'}`,
      `Result: ${result}`,
      error !== undefined ? `Response: ${safeStringify(error)}` : null,
      '',
    ]
      .filter((line) => line !== null)
      .join('\n');

    this._append(this.files.apiRequests, block);
  }
}

module.exports = { Logger };
