'use strict';

function buildReport({ counts, startedAt, completedAt, sourceFormCount }) {
  return {
    sourceFormCount,
    created: counts.created,
    skipped: counts.skipped,
    failed: counts.failed,
    verificationFailed: counts.verificationFailed,
    needsManualReview: counts.needsReview,
    synced: counts.synced || 0,
    completed: counts.created,
    startedAt,
    completedAt,
  };
}

/**
 * Renders every collected issue as one plain-text block per form, ordered
 * status-first so similar problems are grouped together. Designed to be
 * read top-to-bottom by a human doing manual cleanup - each entry says what
 * went wrong and what to do about it.
 */
function formatIssuesText(issues) {
  if (issues.length === 0) return 'No issues - every source form was created and verified (or safely skipped).';

  const sorted = [...issues].sort((a, b) => a.status.localeCompare(b.status));
  return sorted
    .map((issue, index) => {
      const lines = [
        `${index + 1}. [${issue.status}] Source Form: ${issue.sourceFormId} ("${issue.sourceName || 'unknown'}")`,
        issue.destinationFormId ? `   Destination Form: ${issue.destinationFormId}` : null,
        `   Reason: ${issue.reason}`,
        issue.httpStatus !== undefined && issue.httpStatus !== null ? `   HTTP Status: ${issue.httpStatus}` : null,
        Array.isArray(issue.differences) && issue.differences.length > 0
          ? `   Differences: ${issue.differences
              .slice(0, 5)
              .map((d) => `${d.path}: source=${JSON.stringify(d.source)} destination=${JSON.stringify(d.destination)}`)
              .join(' | ')}${issue.differences.length > 5 ? ` (+${issue.differences.length - 5} more)` : ''}`
          : null,
        Array.isArray(issue.candidateDestinationFormIds)
          ? `   Candidate destination form IDs: ${issue.candidateDestinationFormIds.join(', ')}`
          : null,
      ].filter(Boolean);
      return lines.join('\n');
    })
    .join('\n\n');
}

function printIssues(issues) {
  console.log('');
  console.log('========================================');
  console.log(`ISSUES REQUIRING MANUAL REVIEW (${issues.length})`);
  console.log('========================================');
  console.log(formatIssuesText(issues));
  console.log('========================================');
}

function printSummary(report) {
  const lines = [
    '========================================',
    'HUBSPOT FORM MIGRATION SUMMARY',
    '========================================',
    '',
    `Source Forms          : ${report.sourceFormCount}`,
    `Created               : ${report.created}`,
    `Already Existing      : ${report.skipped}`,
    `Creation Failed       : ${report.failed}`,
    `Verification Failed   : ${report.verificationFailed}`,
    `Needs Manual Review   : ${report.needsManualReview}`,
    `Synced (drift-fixed)  : ${report.synced}`,
    '',
    'Migration Completed',
    '========================================',
  ];
  console.log(lines.join('\n'));
}

module.exports = { buildReport, printSummary, formatIssuesText, printIssues };
