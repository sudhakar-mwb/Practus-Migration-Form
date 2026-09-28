'use strict';

const { requestWithRetry } = require('./httpClient');

const FORMS_PATH = '/marketing/v3/forms';

async function listFormsPage(client, { after, limit, logger, maxRetries }) {
  const params = { limit: limit || 100 };
  if (after) params.after = after;
  const res = await requestWithRetry(client, {
    method: 'GET',
    url: FORMS_PATH,
    params,
    operation: 'LIST_FORMS',
    formId: null,
    logger,
    maxRetries,
  });
  return res.data || {};
}

/**
 * Fetches every form in the portal's forms listing, following
 * `paging.next.after` until it is no longer present. Logs page-by-page
 * progress as required by the migration spec.
 */
async function fetchAllForms(client, { logger, portalLabel, limit, maxRetries }) {
  let after;
  let page = 0;
  const all = [];
  do {
    page += 1;
    const data = await listFormsPage(client, { after, limit, logger, maxRetries });
    const results = data.results || [];
    all.push(...results);
    logger.logInfo(`[${portalLabel}] Page ${page}: ${results.length} forms`);
    after = data.paging && data.paging.next && data.paging.next.after;
  } while (after);
  logger.logInfo(`[${portalLabel}] Total forms fetched: ${all.length}`);
  return all;
}

async function getFormById(client, formId, { logger, operation = 'GET_FORM', maxRetries }) {
  const res = await requestWithRetry(client, {
    method: 'GET',
    url: `${FORMS_PATH}/${formId}`,
    operation,
    formId,
    logger,
    maxRetries,
  });
  return res.data;
}

async function createForm(client, payload, { logger, sourceFormId, maxRetries }) {
  const res = await requestWithRetry(client, {
    method: 'POST',
    url: FORMS_PATH,
    data: payload,
    operation: 'CREATE_FORM',
    formId: sourceFormId,
    logger,
    maxRetries,
  });
  return res.data;
}

/**
 * Partial update (PATCH) - only the fields present in `patchBody` are
 * changed; everything else on the form (fields, submissions, id) is left
 * untouched. Used to bring an already-created destination form's name in
 * line with the configured naming rule without recreating it.
 */
async function patchForm(client, destinationFormId, patchBody, { logger, sourceFormId, maxRetries }) {
  const res = await requestWithRetry(client, {
    method: 'PATCH',
    url: `${FORMS_PATH}/${destinationFormId}`,
    data: patchBody,
    operation: 'PATCH_FORM',
    formId: sourceFormId,
    logger,
    maxRetries,
  });
  return res.data;
}

module.exports = { fetchAllForms, getFormById, createForm, patchForm };
