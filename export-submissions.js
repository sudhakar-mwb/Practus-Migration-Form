#!/usr/bin/env node
'use strict';

// Read-only export of historical form submissions from the SOURCE portal.
//
// IMPORTANT: this is intentionally a separate tool from migrate-forms.js.
// Form submissions are a fundamentally different kind of data from form
// definitions, and HubSpot provides no API to import historical submissions
// into a destination portal against a newly created form - the only way to
// attach data to a form is the live submit endpoint, which always uses the
// current timestamp, always creates/updates a real destination contact, and
// can trigger destination workflows/notifications. That is not a replica of
// history, so this tool only ever reads from the source and writes local
// files - it never touches the destination portal.

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./lib/config');
const { Logger } = require('./lib/logger');
const { createClient } = require('./lib/httpClient');
const { fetchAllForms } = require('./lib/formsApi');
const { fetchFormSubmissions } = require('./lib/submissionsApi');
const { writeJson, readJsonSafe } = require('./lib/fileStore');
const { toCsv } = require('./lib/csv');
const { formatFatalError } = require('./lib/safeError');

async function main() {
  const config = loadConfig();
  const logger = new Logger(config.migrationDir);
  const outDir = path.join(config.migrationDir, 'source-form-submissions');
  fs.mkdirSync(outDir, { recursive: true });

  logger.logInfo('========================================');
  logger.logInfo('Source form submissions export started (READ-ONLY; source portal only, nothing written to destination).');

  const sourceClient = createClient(config.sourceBaseUrl, config.sourceToken);

  // Reuse the forms list already fetched by migrate-forms.js if it exists,
  // to avoid an unnecessary re-fetch; otherwise fetch it fresh.
  const existingList = readJsonSafe(path.join(config.migrationDir, 'source-forms.json'), null);
  const sourceFormsList =
    existingList ||
    (await fetchAllForms(sourceClient, {
      logger,
      portalLabel: 'SOURCE',
      limit: config.pageLimit,
      maxRetries: config.maxRetries,
    }));

  const summary = {
    totalForms: sourceFormsList.length,
    totalSubmissions: 0,
    forms: [],
    errors: [],
    startedAt: new Date().toISOString(),
  };

  for (const form of sourceFormsList) {
    const formId = form.id;
    try {
      const submissions = await fetchFormSubmissions(sourceClient, formId, {
        logger,
        maxRetries: config.maxRetries,
      });
      writeJson(path.join(outDir, `${formId}.json`), submissions);

      const fieldNames = new Set();
      for (const submission of submissions) {
        for (const value of submission.values || []) fieldNames.add(value.name);
      }
      const columns = ['conversionId', 'submittedAt', 'submittedAtIso', 'pageUrl', ...Array.from(fieldNames)];
      const rows = submissions.map((submission) => {
        const row = {
          conversionId: submission.conversionId,
          submittedAt: submission.submittedAt,
          submittedAtIso: new Date(submission.submittedAt).toISOString(),
          pageUrl: submission.pageUrl,
        };
        for (const value of submission.values || []) row[value.name] = value.value;
        return row;
      });
      fs.writeFileSync(path.join(outDir, `${formId}.csv`), toCsv(rows, columns), 'utf8');

      logger.logInfo(`Form ${formId} ("${form.name}"): exported ${submissions.length} submission(s).`);
      summary.totalSubmissions += submissions.length;
      summary.forms.push({ formId, name: form.name, submissionCount: submissions.length });
    } catch (err) {
      const status = err.response && err.response.status;
      logger.logError({
        sourceFormId: formId,
        operation: 'GET_FORM_SUBMISSIONS',
        status,
        message: err.message,
        responseData: err.response && err.response.data,
      });
      summary.errors.push({
        formId,
        name: form.name,
        status,
        message: err.message,
        note:
          status === 403
            ? 'Missing scope - the source Private App token needs both "forms" and "forms-uploaded-files" scopes to read submissions.'
            : undefined,
      });
    }
  }

  summary.completedAt = new Date().toISOString();
  writeJson(path.join(config.migrationDir, 'submissions-export-report.json'), summary);

  logger.logInfo(
    `Submissions export finished. ${summary.totalSubmissions} submission(s) exported across ${summary.forms.length}/${summary.totalForms} forms. ${summary.errors.length} form(s) failed.`
  );

  console.log('');
  console.log('========================================');
  console.log('SOURCE FORM SUBMISSIONS EXPORT SUMMARY');
  console.log('========================================');
  console.log(`Forms processed         : ${summary.totalForms}`);
  console.log(`Forms exported OK       : ${summary.forms.length}`);
  console.log(`Forms failed            : ${summary.errors.length}`);
  console.log(`Total submissions saved : ${summary.totalSubmissions}`);
  console.log('========================================');
  if (summary.errors.length > 0) {
    console.log('See migration/submissions-export-report.json and migration/errors.log for details on failed forms.');
  }
}

main().catch((err) => {
  console.error('Fatal error during submissions export:');
  console.error(formatFatalError(err));
  process.exit(1);
});
