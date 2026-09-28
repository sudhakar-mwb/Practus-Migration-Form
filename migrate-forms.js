#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./lib/config');
const { Logger } = require('./lib/logger');
const { createClient } = require('./lib/httpClient');
const { fetchAllForms, getFormById, createForm, patchForm } = require('./lib/formsApi');
const { writeJson } = require('./lib/fileStore');
const { loadMapping, saveMapping, upsertFormEntry } = require('./lib/mapping');
const { buildCreatePayload, buildUpdatePayload } = require('./lib/formPayload');
const { verifyForm } = require('./lib/verify');
const { loadAllowedFormNames, buildDestinationName } = require('./lib/nameFilter');
const { buildReport, printSummary, formatIssuesText, printIssues } = require('./lib/report');
const { formatFatalError } = require('./lib/safeError');

// The only formType the v3 Forms API create endpoint accepts (confirmed via
// the live HubSpot Forms v3 OpenAPI schema). The list endpoint can also
// return "captured", "flow" and "blog_comment" forms, none of which can be
// recreated through this API - those are flagged for manual review instead
// of being silently skipped.
const SUPPORTED_FORM_TYPE = 'hubspot';

// Statuses that mean "this form is fully and permanently resolved" - safe to
// skip on a re-run without re-evaluating duplicate detection. Anything else
// (CREATE_FAILED, VERIFICATION_FAILED, SKIPPED_MULTIPLE_NAME_MATCHES,
// SKIPPED_NAME_CONFLICT, FAILED_DUPLICATE_CHECK, FETCH_SOURCE_FAILED) is
// retried on every run since the underlying condition may have changed.
const TERMINAL_STATUSES = new Set(['CREATED_AND_VERIFIED', 'SKIPPED_ALREADY_EXISTS', 'UNSUPPORTED_FORM_TYPE']);

async function main() {
  const config = loadConfig();

  const dirs = {
    root: config.migrationDir,
    sourceDefs: path.join(config.migrationDir, 'source-form-definitions'),
    destDefs: path.join(config.migrationDir, 'destination-form-definitions'),
  };

  const logger = new Logger(config.migrationDir);
  const startedAt = new Date().toISOString();

  logger.logInfo('========================================');
  logger.logInfo('HubSpot Form Migration started.');
  logger.logInfo(`Source portal ID: ${config.sourcePortalId || 'unknown (SOURCE_PORTAL_ID not set)'}`);
  logger.logInfo(`Destination portal ID: ${config.destinationPortalId || 'unknown (DESTINATION_PORTAL_ID not set)'}`);
  logger.logInfo(`Migration output directory: ${config.migrationDir}`);

  const allowedNames = loadAllowedFormNames(config.allowedFormsFile);
  if (allowedNames) {
    logger.logInfo(
      `Form allowlist active (${config.allowedFormsFile}): only ${allowedNames.size} named form(s) will be considered for migration.`
    );
  }
  if (config.destinationNamePrefix) {
    logger.logInfo(`Destination naming rule active: every destination form name will be prefixed with "${config.destinationNamePrefix}".`);
  }

  const sourceClient = createClient(config.sourceBaseUrl, config.sourceToken);
  const destinationClient = createClient(config.destinationBaseUrl, config.destinationToken);

  const counts = { created: 0, skipped: 0, failed: 0, verificationFailed: 0, needsReview: 0, synced: 0 };
  const verificationDifferences = [];
  // Every non-clean outcome, across every failure category, collected in one
  // place so a human doesn't have to cross-reference 4 separate log files to
  // know what needs manual attention.
  const issues = [];
  function recordIssue(issue) {
    issues.push({ ...issue, recordedAt: new Date().toISOString() });
  }

  // ---------------------------------------------------------------------
  // Step 1: fetch all source forms (list), paginated.
  // ---------------------------------------------------------------------
  logger.logInfo('Fetching source forms (list, paginated)...');
  const sourceFormsList = await fetchAllForms(sourceClient, {
    logger,
    portalLabel: 'SOURCE',
    limit: config.pageLimit,
    maxRetries: config.maxRetries,
  });
  writeJson(path.join(config.migrationDir, 'source-forms.json'), sourceFormsList);
  logger.logInfo(`Total source forms: ${sourceFormsList.length}`);

  // ---------------------------------------------------------------------
  // Optional scope-down: only migrate forms named in allowed-forms.txt (if
  // present). Matching is on the trimmed name, since HubSpot form names can
  // carry incidental leading/trailing whitespace.
  // ---------------------------------------------------------------------
  let formsToMigrate = sourceFormsList;
  if (allowedNames) {
    const seenNames = new Set();
    formsToMigrate = sourceFormsList.filter((f) => {
      const trimmed = (f.name || '').trim();
      const isAllowed = allowedNames.has(trimmed);
      if (isAllowed) seenNames.add(trimmed);
      return isAllowed;
    });
    logger.logInfo(`Allowlist filter: ${formsToMigrate.length}/${sourceFormsList.length} source forms selected for migration.`);
    for (const name of allowedNames) {
      if (!seenNames.has(name)) {
        logger.logWarn(
          `Allowed form name "${name}" was not found among the ${sourceFormsList.length} source forms (check spelling/whitespace, or it may not be a native HubSpot form - e.g. a Gravity Forms embed isn't visible to this API).`
        );
        recordIssue({
          sourceFormId: 'N/A',
          sourceName: name,
          status: 'ALLOWED_NAME_NOT_FOUND',
          reason: `"${name}" is in allowed-forms.txt but no source form with that exact (trimmed) name was found via the Forms API. It may be misspelled, archived, or not a native HubSpot form.`,
        });
        counts.needsReview += 1;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Step 2: fetch the complete definition for every selected source form and
  // persist it locally, regardless of prior run status (source is
  // read-only and cheap to re-fetch; this guarantees we always
  // migrate/verify against the freshest source definition).
  // ---------------------------------------------------------------------
  const sourceDefinitions = [];
  const sourceFetchFailures = [];
  for (const summary of formsToMigrate) {
    const formId = summary.id;
    try {
      const def = await getFormById(sourceClient, formId, {
        logger,
        operation: 'GET_SOURCE_FORM',
        maxRetries: config.maxRetries,
      });
      writeJson(path.join(dirs.sourceDefs, `${formId}.json`), def);
      sourceDefinitions.push(def);
    } catch (err) {
      logger.logError({
        sourceFormId: formId,
        operation: 'FETCH_SOURCE_FAILED',
        status: err.response && err.response.status,
        message: err.message,
        responseData: err.response && err.response.data,
      });
      sourceFetchFailures.push({ formId, name: summary.name });
      recordIssue({
        sourceFormId: formId,
        sourceName: summary.name,
        status: 'FETCH_SOURCE_FAILED',
        reason: `Could not fetch the source form definition: ${err.message}`,
        httpStatus: err.response && err.response.status,
        apiResponse: err.response && err.response.data,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Step 3: fetch all destination forms before creating anything.
  // ---------------------------------------------------------------------
  logger.logInfo('Fetching destination forms (list, paginated)...');
  const destinationFormsBefore = await fetchAllForms(destinationClient, {
    logger,
    portalLabel: 'DESTINATION',
    limit: config.pageLimit,
    maxRetries: config.maxRetries,
  });
  writeJson(path.join(config.migrationDir, 'destination-forms-before.json'), destinationFormsBefore);

  const destinationById = new Map(destinationFormsBefore.map((f) => [f.id, f]));
  const destinationByNameType = new Map();
  for (const f of destinationFormsBefore) {
    const key = `${f.name}::${f.formType}`;
    if (!destinationByNameType.has(key)) destinationByNameType.set(key, []);
    destinationByNameType.get(key).push(f);
  }

  // ---------------------------------------------------------------------
  // Step 4: load the persistent source -> destination mapping.
  // ---------------------------------------------------------------------
  const mappingPath = path.join(config.migrationDir, 'form-mapping.json');
  const mapping = loadMapping(mappingPath, config.sourcePortalId, config.destinationPortalId);
  mapping.sourcePortal = mapping.sourcePortal || config.sourcePortalId || null;
  mapping.destinationPortal = mapping.destinationPortal || config.destinationPortalId || null;

  // Record forms whose source definition could not even be fetched, so they
  // show up in the mapping/report for manual follow-up.
  for (const failure of sourceFetchFailures) {
    upsertFormEntry(mapping, failure.formId, {
      sourceName: failure.name,
      status: 'FETCH_SOURCE_FAILED',
    });
    counts.failed += 1;
  }
  saveMapping(mappingPath, mapping);

  // ---------------------------------------------------------------------
  // Step 5: process every source form definition we successfully fetched.
  // ---------------------------------------------------------------------
  for (const sourceForm of sourceDefinitions) {
    const sourceFormId = sourceForm.id;
    const existingEntry = mapping.forms[sourceFormId];
    const destinationName = buildDestinationName(sourceForm.name, config.destinationNamePrefix);

    // --- Priority 1 duplicate detection: trust the persistent mapping when
    // it reflects a terminal, still-valid state. ---
    if (
      existingEntry &&
      TERMINAL_STATUSES.has(existingEntry.status) &&
      (!existingEntry.destinationFormId || destinationById.has(existingEntry.destinationFormId))
    ) {
      let justSynced = false;
      if (existingEntry.status === 'CREATED_AND_VERIFIED' || existingEntry.status === 'SKIPPED_ALREADY_EXISTS') {
        // Auto-sync: the source form may have changed since it was
        // migrated (new/edited fields, settings, name, etc.), or the naming
        // rule may have just been turned on/changed. Detect any drift from
        // the live destination form and, if present, push the current
        // source definition to the destination via a partial update - this
        // never touches the destination form's id or submission history,
        // only the fields the PATCH endpoint accepts (name, fieldGroups,
        // configuration, displayOptions, legalConsentOptions, archived).
        const liveDestForm = existingEntry.destinationFormId ? destinationById.get(existingEntry.destinationFormId) : null;
        if (liveDestForm) {
          const drift = verifyForm(sourceForm, liveDestForm, { expectedName: destinationName });
          if (!drift.matched) {
            const { payload: updatePayload, warnings } = buildUpdatePayload(sourceForm, { destinationName });
            for (const warning of warnings) {
              logger.logWarn(`Source form ${sourceFormId} ("${sourceForm.name}"): ${warning}`);
            }
            try {
              const updated = await patchForm(destinationClient, liveDestForm.id, updatePayload, {
                logger,
                sourceFormId,
                maxRetries: config.maxRetries,
              });
              writeJson(path.join(dirs.destDefs, `${liveDestForm.id}.json`), updated);
              const reverify = verifyForm(sourceForm, updated, { expectedName: destinationName });
              if (reverify.matched) {
                logger.logInfo(
                  `Synced destination form ${liveDestForm.id}: source form ${sourceFormId} ("${sourceForm.name}") had changed (${drift.differences.length} field/setting difference(s)) - destination updated to match.`
                );
                counts.synced += 1;
                justSynced = true;
                upsertFormEntry(mapping, sourceFormId, {
                  destinationFormId: liveDestForm.id,
                  sourceName: sourceForm.name,
                  status: existingEntry.status,
                });
                saveMapping(mappingPath, mapping);
              } else {
                logger.logError({
                  sourceFormId,
                  destinationFormId: liveDestForm.id,
                  operation: 'SYNC_FORM_VERIFY',
                  status: 200,
                  message: 'Destination form was updated to match the source but still differs after the sync.',
                  responseData: reverify.differences,
                });
                upsertFormEntry(mapping, sourceFormId, {
                  destinationFormId: liveDestForm.id,
                  sourceName: sourceForm.name,
                  status: 'VERIFICATION_FAILED',
                });
                saveMapping(mappingPath, mapping);
                verificationDifferences.push({
                  sourceFormId,
                  destinationFormId: liveDestForm.id,
                  status: 'VERIFICATION_FAILED',
                  differences: reverify.differences,
                });
                recordIssue({
                  sourceFormId,
                  sourceName: sourceForm.name,
                  status: 'VERIFICATION_FAILED',
                  destinationFormId: liveDestForm.id,
                  reason: `Destination form was synced but ${reverify.differences.length} field(s)/setting(s) still differ from the source. Review verification-differences.json.`,
                  differences: reverify.differences,
                });
                counts.verificationFailed += 1;
                continue;
              }
            } catch (err) {
              logger.logError({
                sourceFormId,
                destinationFormId: liveDestForm.id,
                operation: 'SYNC_FORM',
                status: err.response && err.response.status,
                message: err.message,
                responseData: err.response && err.response.data,
                extra: { rejectedPayload: updatePayload },
              });
              recordIssue({
                sourceFormId,
                sourceName: sourceForm.name,
                status: 'SYNC_FAILED',
                destinationFormId: liveDestForm.id,
                reason: `Could not sync destination form ${liveDestForm.id} to match the updated source: ${err.message}. It still has its previous definition; will retry automatically on next run.`,
                httpStatus: err.response && err.response.status,
                apiResponse: err.response && err.response.data,
              });
              counts.needsReview += 1;
              continue;
            }
          }
        }
      }
      if (!justSynced) {
        logger.logInfo(
          `Source form ${sourceFormId} ("${sourceForm.name}") already resolved as ${existingEntry.status}. Skipping.`
        );
      }
      if (existingEntry.status === 'CREATED_AND_VERIFIED') counts.created += 1;
      else if (existingEntry.status === 'SKIPPED_ALREADY_EXISTS') counts.skipped += 1;
      else {
        counts.needsReview += 1;
        recordIssue({
          sourceFormId,
          sourceName: sourceForm.name,
          status: existingEntry.status,
          destinationFormId: existingEntry.destinationFormId,
          reason: `Previously recorded as ${existingEntry.status} and formType is permanently unsupported by the create API; no change needed to re-check.`,
          formType: existingEntry.formType,
        });
      }
      continue;
    }
    if (existingEntry && existingEntry.destinationFormId && !destinationById.has(existingEntry.destinationFormId)) {
      logger.logWarn(
        `Mapping for source form ${sourceFormId} points to destination form ${existingEntry.destinationFormId}, which no longer exists in the destination portal. Re-evaluating.`
      );
    }

    // --- formType support check: only "hubspot" forms can be created via
    // this API. Other types (captured/flow/blog_comment) are a hard API
    // limitation, not something we can silently work around. ---
    if (sourceForm.formType !== SUPPORTED_FORM_TYPE) {
      logger.logWarn(
        `Source form ${sourceFormId} ("${sourceForm.name}") has formType "${sourceForm.formType}", which the Forms v3 create API does not support. Marked for manual review; not migrated.`
      );
      upsertFormEntry(mapping, sourceFormId, {
        sourceName: sourceForm.name,
        status: 'UNSUPPORTED_FORM_TYPE',
        formType: sourceForm.formType,
      });
      saveMapping(mappingPath, mapping);
      counts.needsReview += 1;
      recordIssue({
        sourceFormId,
        sourceName: sourceForm.name,
        status: 'UNSUPPORTED_FORM_TYPE',
        reason: `formType "${sourceForm.formType}" cannot be created via POST /marketing/v3/forms (only "hubspot" is supported). Recreate this form manually in the destination portal if needed.`,
        formType: sourceForm.formType,
      });
      continue;
    }

    // --- Priority 2/3 duplicate detection: name + formType match against
    // the live destination list, then normalized full-definition compare.
    // Matched against `destinationName` (source name + configured prefix,
    // if any) since that is what the destination form is expected to be
    // named. ---
    const nameTypeKey = `${destinationName}::${sourceForm.formType}`;
    const matches = destinationByNameType.get(nameTypeKey) || [];

    let destinationFormId = null;
    let wasSkippedAsExisting = false;

    if (matches.length > 1) {
      logger.logWarn(
        `WARNING: Multiple destination forms found with the expected name "${destinationName}". Manual review required. Source form ${sourceFormId} was NOT created to avoid an ambiguous duplicate.`
      );
      upsertFormEntry(mapping, sourceFormId, {
        sourceName: sourceForm.name,
        status: 'SKIPPED_MULTIPLE_NAME_MATCHES',
        candidateDestinationFormIds: matches.map((m) => m.id),
      });
      saveMapping(mappingPath, mapping);
      counts.needsReview += 1;
      recordIssue({
        sourceFormId,
        sourceName: sourceForm.name,
        status: 'SKIPPED_MULTIPLE_NAME_MATCHES',
        reason: `${matches.length} destination forms share the expected name "${destinationName}". Manually identify the correct one (or confirm none is a match) and update form-mapping.json, or rename/merge the duplicates in the destination portal.`,
        candidateDestinationFormIds: matches.map((m) => m.id),
      });
      continue;
    }

    if (matches.length === 1) {
      const candidate = matches[0];
      try {
        const candidateDef = await getFormById(destinationClient, candidate.id, {
          logger,
          operation: 'GET_DEST_FORM_FOR_DUP_CHECK',
          maxRetries: config.maxRetries,
        });
        const comparison = verifyForm(sourceForm, candidateDef, { expectedName: destinationName });
        if (comparison.matched) {
          destinationFormId = candidate.id;
          wasSkippedAsExisting = true;
          logger.logInfo(
            `Source form ${sourceFormId} matches existing destination form ${candidate.id} by name, type, and full definition. Skipping creation.`
          );
        } else {
          logger.logWarn(
            `WARNING: A destination form named "${destinationName}" already exists (id ${candidate.id}) but its definition differs from the source. Manual review required. Source form ${sourceFormId} was NOT created to avoid a conflicting duplicate.`
          );
          upsertFormEntry(mapping, sourceFormId, {
            sourceName: sourceForm.name,
            status: 'SKIPPED_NAME_CONFLICT',
            destinationFormId: candidate.id,
            differences: comparison.differences,
          });
          saveMapping(mappingPath, mapping);
          counts.needsReview += 1;
          recordIssue({
            sourceFormId,
            sourceName: sourceForm.name,
            status: 'SKIPPED_NAME_CONFLICT',
            destinationFormId: candidate.id,
            reason: `A destination form named "${destinationName}" already exists (id ${candidate.id}) but its definition differs from the source. Compare manually and either update the destination form or rename one of them, then re-run.`,
            differences: comparison.differences,
          });
          continue;
        }
      } catch (err) {
        logger.logError({
          sourceFormId,
          destinationFormId: candidate.id,
          operation: 'GET_DEST_FORM_FOR_DUP_CHECK',
          status: err.response && err.response.status,
          message: err.message,
          responseData: err.response && err.response.data,
        });
        upsertFormEntry(mapping, sourceFormId, { sourceName: sourceForm.name, status: 'FAILED_DUPLICATE_CHECK' });
        saveMapping(mappingPath, mapping);
        counts.needsReview += 1;
        recordIssue({
          sourceFormId,
          sourceName: sourceForm.name,
          status: 'FAILED_DUPLICATE_CHECK',
          destinationFormId: candidate.id,
          reason: `Could not fetch destination form ${candidate.id} to check for a duplicate: ${err.message}. Will retry automatically on next run.`,
          httpStatus: err.response && err.response.status,
          apiResponse: err.response && err.response.data,
        });
        continue;
      }
    }

    // --- Create the destination form (only if no safe match was found). ---
    if (!wasSkippedAsExisting) {
      const { payload, warnings } = buildCreatePayload(sourceForm, { destinationName });
      for (const warning of warnings) {
        logger.logWarn(`Source form ${sourceFormId} ("${sourceForm.name}"): ${warning}`);
      }
      try {
        const created = await createForm(destinationClient, payload, {
          logger,
          sourceFormId,
          maxRetries: config.maxRetries,
        });
        destinationFormId = created.id;
        logger.logInfo(
          `Created destination form ${destinationFormId} for source form ${sourceFormId} ("${sourceForm.name}").`
        );
      } catch (err) {
        logger.logError({
          sourceFormId,
          operation: 'CREATE_FORM',
          status: err.response && err.response.status,
          message: err.message,
          responseData: err.response && err.response.data,
          extra: { rejectedPayload: payload },
        });
        upsertFormEntry(mapping, sourceFormId, { sourceName: sourceForm.name, status: 'CREATE_FAILED' });
        saveMapping(mappingPath, mapping);
        counts.failed += 1;
        recordIssue({
          sourceFormId,
          sourceName: sourceForm.name,
          status: 'CREATE_FAILED',
          reason: `HubSpot rejected the create request: ${err.message}. See errors.log for the full rejected payload and response.`,
          httpStatus: err.response && err.response.status,
          apiResponse: err.response && err.response.data,
        });
        continue;
      }
    }

    // --- Verify the (newly created or pre-existing) destination form. ---
    try {
      const destinationDef = await getFormById(destinationClient, destinationFormId, {
        logger,
        operation: 'GET_DEST_FORM_VERIFY',
        maxRetries: config.maxRetries,
      });
      writeJson(path.join(dirs.destDefs, `${destinationFormId}.json`), destinationDef);

      const result = verifyForm(sourceForm, destinationDef, { expectedName: destinationName });
      if (result.matched) {
        const status = wasSkippedAsExisting ? 'SKIPPED_ALREADY_EXISTS' : 'CREATED_AND_VERIFIED';
        upsertFormEntry(mapping, sourceFormId, { destinationFormId, sourceName: sourceForm.name, status });
        saveMapping(mappingPath, mapping);
        if (status === 'CREATED_AND_VERIFIED') {
          logger.logSuccess({ sourceFormId, destinationFormId, name: sourceForm.name, status });
          counts.created += 1;
        } else {
          logger.logInfo(`Source form ${sourceFormId} confirmed as already migrated (destination form ${destinationFormId}).`);
          counts.skipped += 1;
        }
      } else {
        upsertFormEntry(mapping, sourceFormId, {
          destinationFormId,
          sourceName: sourceForm.name,
          status: 'VERIFICATION_FAILED',
        });
        saveMapping(mappingPath, mapping);
        verificationDifferences.push({
          sourceFormId,
          destinationFormId,
          status: 'VERIFICATION_FAILED',
          differences: result.differences,
        });
        logger.logError({
          sourceFormId,
          destinationFormId,
          operation: 'VERIFY_FORM',
          status: 200,
          message: 'Destination form definition does not match the normalized source definition.',
          responseData: result.differences,
        });
        counts.verificationFailed += 1;
        recordIssue({
          sourceFormId,
          sourceName: sourceForm.name,
          status: 'VERIFICATION_FAILED',
          destinationFormId,
          reason: `Form was created but ${result.differences.length} field(s) differ from the source. Review verification-differences.json and fix manually in the destination portal.`,
          differences: result.differences,
        });
      }
    } catch (err) {
      logger.logError({
        sourceFormId,
        destinationFormId,
        operation: 'GET_DEST_FORM_VERIFY',
        status: err.response && err.response.status,
        message: err.message,
        responseData: err.response && err.response.data,
      });
      upsertFormEntry(mapping, sourceFormId, {
        destinationFormId,
        sourceName: sourceForm.name,
        status: 'VERIFICATION_FAILED',
      });
      saveMapping(mappingPath, mapping);
      verificationDifferences.push({
        sourceFormId,
        destinationFormId,
        status: 'VERIFICATION_FAILED',
        error: err.message,
      });
      counts.verificationFailed += 1;
      recordIssue({
        sourceFormId,
        sourceName: sourceForm.name,
        status: 'VERIFICATION_FAILED',
        destinationFormId,
        reason: `Form was created (or matched) but could not be re-fetched to verify: ${err.message}. Manually confirm destination form ${destinationFormId} matches the source, then re-run to retry verification.`,
        httpStatus: err.response && err.response.status,
        apiResponse: err.response && err.response.data,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Step 6: final reports.
  // ---------------------------------------------------------------------
  writeJson(path.join(config.migrationDir, 'verification-differences.json'), verificationDifferences);
  writeJson(path.join(config.migrationDir, 'issues.json'), issues);
  fs.writeFileSync(path.join(config.migrationDir, 'issues.txt'), formatIssuesText(issues), 'utf8');

  const completedAt = new Date().toISOString();
  const report = buildReport({ counts, startedAt, completedAt, sourceFormCount: formsToMigrate.length });
  writeJson(path.join(config.migrationDir, 'migration-report.json'), report);

  logger.logInfo('HubSpot Form Migration finished.');
  printSummary(report);
  if (issues.length > 0) printIssues(issues);
}

main().catch((err) => {
  // Never pass the raw error object to console.error here - an axios error
  // carries the full outgoing HTTP request (including the Authorization
  // header) on err.request/err.config, and printing the object would leak
  // the access token into the terminal/log. Only print sanitized fields.
  console.error('Fatal error during migration:');
  console.error(formatFatalError(err));
  process.exit(1);
});
