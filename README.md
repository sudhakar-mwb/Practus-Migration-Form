# HubSpot Form Migration

Migrates HubSpot Forms (Forms API v3) from a **source** HubSpot portal to a
**destination** HubSpot portal. Built to be re-run safely: it never modifies
the source portal, never creates duplicate forms in the destination, and can
be stopped/restarted at any point without losing progress.

## What it does

1. Fetches every form from the source portal (paginated) and saves the full
   definition for each one locally.
2. Fetches every form currently in the destination portal (paginated).
3. For each source form, decides whether it already exists in the
   destination (via a persistent mapping file, then name+type, then a full
   normalized-definition compare). Only creates a form if it's genuinely new.
4. Creates the form via `POST /marketing/v3/forms`, using the source
   definition as-is (only portal-generated fields like `id` are stripped).
5. Re-fetches the created form and verifies it field-by-field against the
   source (field order, labels, validation, settings, etc.) - not a naive
   `JSON.stringify` compare.
6. Writes detailed logs, a source→destination mapping, a differences report
   for anything that didn't verify cleanly, and a final summary report.

## Setup

```bash
npm install
cp .env.example .env
# edit .env with your two Private App tokens
npm run migrate
```

### Required environment variables

```env
SOURCE_ACCESS_TOKEN=
DESTINATION_ACCESS_TOKEN=
```

### Optional environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SOURCE_PORTAL_ID` / `DESTINATION_PORTAL_ID` | _(none)_ | Written into `form-mapping.json` and logs for traceability. Not required for API calls. |
| `HUBSPOT_BASE_URL` | `https://api.hubapi.com` | Base URL for both portals. |
| `SOURCE_BASE_URL` / `DESTINATION_BASE_URL` | value of `HUBSPOT_BASE_URL` | Override per portal - needed if source and destination are in different HubSpot data-residency regions (e.g. `https://api-eu1.hubapi.com`). |
| `MAX_RETRIES` | `5` | Max attempts per API call before giving up. |
| `PAGE_LIMIT` | `100` | Page size for the forms-list pagination. |
| `MIGRATION_DIR` | `./migration` | Where all output (logs, JSON, reports) is written. |

If either token is missing, the script prints which one and exits immediately
(exit code 1) without making any API calls.

## Required Private App scopes

Confirmed against HubSpot's current Forms v3 API reference (both the `GET`
and `POST` endpoints):

```
forms
```

Create one Private App per portal (source and destination) with this scope,
and use its access token for the corresponding `*_ACCESS_TOKEN` variable.

## Example API requests

```bash
# List forms (source), paginated
curl -s "https://api.hubapi.com/marketing/v3/forms?limit=100" \
  -H "Authorization: Bearer $SOURCE_ACCESS_TOKEN"

# Get one form's full definition
curl -s "https://api.hubapi.com/marketing/v3/forms/<formId>" \
  -H "Authorization: Bearer $SOURCE_ACCESS_TOKEN"

# Create a form in the destination
curl -s -X POST "https://api.hubapi.com/marketing/v3/forms" \
  -H "Authorization: Bearer $DESTINATION_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d @payload.json
```

## Project structure

```
migrate-forms.js              entry point / orchestrator
lib/
  config.js                   env loading + validation
  logger.js                   the 4 required log files + console output
  retry.js                    exponential backoff + Retry-After handling
  httpClient.js                axios client + retrying/logging request wrapper
  formsApi.js                 GET (list/paginate), GET by id, POST wrappers
  normalize.js                strips portal-generated fields for comparison
  diff.js                     recursive path-level deep diff
  verify.js                   normalize + diff -> matched/differences
  formPayload.js               builds the POST payload from a source form
  mapping.js                  form-mapping.json load/save/upsert
  fileStore.js                JSON read/write helpers
  report.js                   migration-report.json + console summary

migration/                    generated on every run (gitignored by default)
  source-forms.json
  destination-forms-before.json
  form-mapping.json
  migration-report.json
  verification-differences.json
  issues.json / issues.txt      every problem across all categories, in one place
  migration.log / success.log / errors.log / api-requests.log
  source-form-definitions/{sourceFormId}.json
  destination-form-definitions/{destinationFormId}.json
```

## Duplicate handling

Three priorities are checked, in order, for every source form:

1. **Mapping file** (`form-mapping.json`) - if a prior run already recorded
   this source form as `CREATED_AND_VERIFIED` or `SKIPPED_ALREADY_EXISTS`,
   and the referenced destination form still exists, it's skipped
   immediately. No network calls are wasted re-checking it.
2. **Name + form type** - if no mapping entry, the live destination forms
   list is searched for forms with the exact same `name` and `formType`.
   - **Zero matches** → safe to create.
   - **Exactly one match** → its full definition is fetched and compared
     (see Verification below). If it matches, it's adopted into the mapping
     as `SKIPPED_ALREADY_EXISTS` (no new form is created). If it doesn't
     match, the form is **not** created - it's marked
     `SKIPPED_NAME_CONFLICT` and logged as a warning requiring manual
     review, since blindly creating a second form with the same name would
     itself be a duplicate-name problem.
   - **More than one match** → nothing is created. Logged as
     `WARNING: Multiple destination forms found with the same name...` and
     marked `SKIPPED_MULTIPLE_NAME_MATCHES` for manual review.
3. **Normalized full-definition compare** - used inside step 2 above (not a
   separate blind pass), comparing everything except portal-generated
   fields (`id`, timestamps).

This means the script is safe to run any number of times: nothing is ever
created twice, and anything ambiguous is surfaced for a human rather than
guessed at.

Every terminal outcome is recorded per source form in `form-mapping.json`
with one of these statuses: `CREATED_AND_VERIFIED`, `SKIPPED_ALREADY_EXISTS`,
`CREATE_FAILED`, `VERIFICATION_FAILED`, `FETCH_SOURCE_FAILED`,
`UNSUPPORTED_FORM_TYPE`, `SKIPPED_MULTIPLE_NAME_MATCHES`,
`SKIPPED_NAME_CONFLICT`, `FAILED_DUPLICATE_CHECK`. Only the first two are
treated as "done" on a re-run; every other status is retried on the next run
since the underlying condition (a transient API error, a since-resolved name
conflict, etc.) may have changed.

## Scoping to specific forms + a destination naming rule

Two optional, independent features, both off by default:

- **`allowed-forms.txt`** (path configurable via `ALLOWED_FORMS_FILE`) - a
  plain text file, one source form name per line. When it exists, only
  source forms whose name (trimmed) appears in it are considered at all -
  everything else is left completely untouched (not fetched into
  `source-form-definitions/`, not created, not renamed). Any listed name
  that doesn't match a source form is logged as a warning and recorded in
  `issues.json` as `ALLOWED_NAME_NOT_FOUND` - useful for catching typos, or
  a name that refers to something that isn't a native HubSpot form (see
  Known limitations below).
- **`DESTINATION_NAME_PREFIX`** - when set, every destination form's name
  becomes `<prefix><source name>` instead of a plain copy of the source
  name. This is threaded through everywhere name is used: duplicate
  detection matches against the prefixed name, verification compares the
  destination against the *expected* prefixed name (not the raw source
  name, which would otherwise show up as a false-positive mismatch on every
  single form), and the create payload uses the prefixed name.

If a source form was already migrated *before* this naming rule was turned
on (or before the rule changed), its destination form exists with the old
name - this is corrected automatically the same way as any other drift; see
the next section.

## Keeping already-migrated forms in sync

By default, once a form reaches `CREATED_AND_VERIFIED` or
`SKIPPED_ALREADY_EXISTS`, **every subsequent run re-checks it against the
current source definition and pushes any difference to the destination.**
This covers:

- Fields added, removed, reordered, or edited on the source form after the
  initial migration
- Changed settings (`configuration`, `displayOptions`, `legalConsentOptions`,
  `archived`)
- A naming rule that was turned on, changed, or newly matches this form

The mechanism is the same `PATCH /marketing/v3/forms/{id}` used for
renaming - a partial update containing only `name`, `fieldGroups`,
`configuration`, `displayOptions`, `legalConsentOptions`, and `archived`.
The destination form's id and submission history are never touched, and it
is **not** recreated. After the patch, the result is re-verified the same
way a fresh creation is (see Verification below); if it still doesn't
match, it's marked `VERIFICATION_FAILED` instead of silently reporting
success. A form with no drift is left completely alone - no API call is
made for it beyond the read used to check for drift.

**This means a manual edit made directly on a destination form (e.g. fixing
a submit-button label for local branding) will be overwritten back to match
source on the next run.** If you need destination-only customizations to
survive, don't run the script again for that form, or make the same edit on
the source form instead.

Sync outcomes are counted separately in `migration-report.json` as `synced`
(and printed as `Synced (drift-fixed)`) - a form can be both `Created` (or
`Already Existing`) *and* counted in `synced` in the same run if it needed
an update. A sync that fails (e.g. HubSpot rejects the patch) is logged like
any other error, recorded in `issues.json` as `SYNC_FAILED`, and retried
automatically on the next run - the destination form is left in its
previous (still valid) state, never partially updated.

## Retry handling

`lib/retry.js` wraps every API call. It retries on:

- HTTP `429`, `500`, `502`, `503`, `504`
- Network/timeout errors (connection reset, timeout, DNS failure, etc.)

using exponential backoff (1s, 2s, 4s, 8s, 16s for attempts 1-5 by default,
configurable via `MAX_RETRIES`). If the response includes a `Retry-After`
header (seconds or an HTTP date), that value is used instead of the computed
backoff delay. Non-retryable statuses (e.g. `400`, `401`, `403`, `404`) fail
immediately - retrying a validation error wastes time and quota. Once
retries are exhausted, the error is logged in full and the script moves on
to the next form; it never aborts the whole migration for one bad form.

## Verification

After a form is created (or matched as a pre-existing duplicate), the
destination form is re-fetched via `GET /marketing/v3/forms/{id}` and
compared against the source definition using `lib/verify.js`:

1. Both definitions are passed through `normalizeForComparison`, which
   removes only fields HubSpot generates per-portal (`id`, `createdAt`,
   `updatedAt`, `archivedAt`, `guid`, `portalId` - the last two aren't
   present in the current API but are stripped defensively).
2. Everything else - `name`, `formType`, `fieldGroups` (and every field's
   `fieldType`, `label`, `required`, `hidden`, `validation`, `defaultValue`,
   ordering, etc.), `configuration`, `displayOptions`, and
   `legalConsentOptions` - is deep-compared field by field via
   `lib/diff.js`, which walks both objects/arrays recursively and records
   every path where the values differ (added, removed, or changed),
   including array length and order.

If there are zero differences, the form is `CREATED_AND_VERIFIED`. Any
difference marks it `VERIFICATION_FAILED` and appends an entry to
`migration/verification-differences.json` in this shape:

```json
{
  "sourceFormId": "123",
  "destinationFormId": "456",
  "status": "VERIFICATION_FAILED",
  "differences": [
    { "path": "fieldGroups[0].fields[2].required", "source": true, "destination": false }
  ]
}
```

## Issues requiring manual review

Every non-clean outcome - across *all* categories (fetch failures, creation
failures, verification mismatches, unsupported form types, and ambiguous
duplicates) - is also collected into one consolidated list, so you don't
have to cross-reference four separate log files to know what needs
attention:

- **Console output** - if anything needs review, an `ISSUES REQUIRING
  MANUAL REVIEW` block is printed after the summary, numbered, each entry
  showing the source form, its status, why it needs review, and what to do
  about it.
- **`migration/issues.json`** - the same list as structured data (status,
  source/destination form IDs, reason, HTTP status/response where relevant,
  differences, or candidate duplicate IDs).
- **`migration/issues.txt`** - the same list as plain text, for a quick read
  without parsing JSON.

If the run was completely clean, `issues.json` is an empty array and no
console block is printed.

## Known HubSpot Forms API limitations

- **`formType` support** - the `POST /marketing/v3/forms` create endpoint
  only accepts `formType: "hubspot"` (confirmed against the live OpenAPI
  schema). The forms *list* endpoint can also return `captured`, `flow`, and
  `blog_comment` forms (non-native/bot/blog-comment forms), none of which
  can be recreated through this API. These are detected up front and marked
  `UNSUPPORTED_FORM_TYPE` for manual review rather than attempted and
  silently failing.
- **User IDs are not portable** - `configuration.notifyRecipients` is a list
  of source-portal HubSpot user IDs. User IDs are not shared across portals,
  so copying them verbatim will not notify the intended people (and may
  notify no one, or error). The script preserves the value (it does not
  silently strip it) but logs a warning on every affected form so recipients
  can be corrected manually.
- **Subscription type IDs are not portable** - `legalConsentOptions.subscriptionTypeIds`
  references subscription type definitions that are portal-specific. Same
  handling: preserved, warned, not silently dropped.
- **Lifecycle stages** - `configuration.lifecycleStages` may reference custom
  (non-default) lifecycle stages that don't exist with the same identifiers
  in the destination portal. Flagged for review when non-empty.
- **No cross-portal object linking** - anything a form ties to indirectly
  (workflows, custom properties referenced by field `name`, embedded page
  associations, GDPR-specific legal basis records) is outside the Forms API
  and outside this script's scope. If a field references a custom contact
  property that doesn't exist in the destination portal, HubSpot's create
  call will reject it - this shows up as a normal `CREATE_FAILED` with the
  full HubSpot error response in `errors.log`.
- **Rate limits** - forms are processed sequentially (not in parallel) to
  stay well under HubSpot's per-10-second rate limits; the retry/backoff
  logic handles the occasional `429` reactively.

## Output / example report

Console summary (also written to `migration/migration-report.json`):

```
========================================
HUBSPOT FORM MIGRATION SUMMARY
========================================

Source Forms          : 250
Created               : 230
Already Existing      : 15
Creation Failed       : 3
Verification Failed   : 2
Needs Manual Review   : 0

Migration Completed
========================================
```

`migration-report.json`:

```json
{
  "sourceFormCount": 250,
  "created": 230,
  "skipped": 15,
  "failed": 3,
  "verificationFailed": 2,
  "needsManualReview": 0,
  "completed": 230,
  "startedAt": "2026-09-10T10:00:00.000Z",
  "completedAt": "2026-09-10T10:14:32.000Z"
}
```

## Safety guarantees

- The source portal is only ever read (`GET`). Nothing is written, updated,
  or archived there.
- The destination portal is only ever read and created into (`GET`, `POST`).
  Nothing is updated or deleted there.
- No access token is ever written to a log file.
- Every log write is synchronous, so `migration.log` / `success.log` /
  `errors.log` / `api-requests.log` / `form-mapping.json` all reflect
  progress even if the process is killed mid-run.
