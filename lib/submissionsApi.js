'use strict';

const { requestWithRetry } = require('./httpClient');

function submissionsPath(formId) {
  return `/form-integrations/v1/submissions/forms/${formId}`;
}

/**
 * Fetches every historical submission for one form from the SOURCE portal
 * (read-only; there is no destination-side equivalent - see README). Pages
 * through the legacy v1 submissions endpoint (max 50 per page) until
 * `paging.next.after` is no longer present.
 */
async function fetchFormSubmissions(client, formId, { logger, maxRetries }) {
  let after;
  const all = [];
  do {
    const params = { limit: 50 };
    if (after) params.after = after;
    const res = await requestWithRetry(client, {
      method: 'GET',
      url: submissionsPath(formId),
      params,
      operation: 'GET_FORM_SUBMISSIONS',
      formId,
      logger,
      maxRetries,
    });
    const data = res.data || {};
    const results = data.results || [];
    all.push(...results);
    after = data.paging && data.paging.next && data.paging.next.after;
  } while (after);
  return all;
}

module.exports = { fetchFormSubmissions };
