'use strict';

const axios = require('axios');
const { withRetry } = require('./retry');

/**
 * Creates an axios instance for a HubSpot portal. `validateStatus` always
 * returns true so that HTTP error responses (4xx/5xx) come back as normal
 * responses rather than thrown exceptions - this lets us log the full
 * response body and decide retry behavior ourselves in `requestWithRetry`.
 */
function createClient(baseURL, token) {
  return axios.create({
    baseURL,
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    validateStatus: () => true,
  });
}

/**
 * Performs a single logical API operation (with retry + full request
 * logging). `client` must be an axios instance created via `createClient`.
 */
async function requestWithRetry(
  client,
  { method, url, data, params, operation, formId, logger, maxRetries }
) {
  return withRetry(
    async (attempt) => {
      let response;
      try {
        response = await client.request({ method, url, data, params });
      } catch (networkErr) {
        logger.logApiRequest({
          method,
          endpoint: url,
          formId,
          operation,
          attempt,
          status: null,
          result: 'FAILED',
          error: networkErr.message,
        });
        throw networkErr;
      }

      const success = response.status >= 200 && response.status < 300;
      logger.logApiRequest({
        method,
        endpoint: url,
        formId,
        operation,
        attempt,
        status: response.status,
        result: success ? 'SUCCESS' : 'FAILED',
        error: success ? undefined : response.data,
      });

      if (!success) {
        const err = new Error(`HTTP ${response.status} on ${method} ${url}`);
        err.response = response;
        throw err;
      }

      return response;
    },
    {
      maxRetries,
      onRetry: ({ attempt, delay, err }) => {
        logger.logInfo(
          `Retrying ${operation} (form ${formId || 'n/a'}), attempt ${attempt + 1}, waiting ${delay}ms. Reason: ${
            err.message
          }`
        );
      },
    }
  );
}

module.exports = { createClient, requestWithRetry };
