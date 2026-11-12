# doctorcre-engine

Engine for the DoctorCRE app. See `AGENTS.md` for how work happens here.

Run `npm ci` once, then `npm run check` before every push. CI runs the same command.

Database checks need a local, disposable PostgreSQL 18 server with `pgcrypto` and
`pg_trgm`. The test user needs permission to create databases and extensions. For example, start `docker run --rm -p 5432:5432 -e
POSTGRES_HOST_AUTH_METHOD=trust postgres:18`, then run `npm run check`.
`TEST_DATABASE_URL` defaults to `postgres://postgres@127.0.0.1:5432/postgres`.
The loader accepts only loopback hosts without URL query parameters, creates a
random database, and drops it in `finally`. Never point it at a shared server.

Each check restores `schema/business.sql`, generates ignored `src/database.d.ts`
with `kysely-codegen`, and runs TypeScript and tests against that database.
Use `Kysely<DB>` with the generated `DB` for business queries. Raw SQL bypasses
query typing and is reserved here for catalog inspection, trigger controls and
test rows in `ops` tables, which the generated types leave out.
The snapshot contains 106 empty tables, 53 views, 6 sequences and 32 triggers.
Its reviewed literals use fictional partners, tenants and domains. SQL comments
and psql transport directives are removed. Of the old process schema it keeps
only the four tables behind the client portal link and the document checklist,
without their triggers. The rest of that schema, its triggers on public tables and two
dependent public views are excluded.

To compare a catalog outside CI, set `SCHEMA_DATABASE_URL` in the environment and
run `npm run schema:drift`. It also needs the local throwaway server above.
The target connection starts read-only, uses a read-only transaction, and queries
only PostgreSQL catalogs. It prints differing or missing object names, never
values or definitions. Exit codes are 0 for a match, 1 for drift and 2 for failure.
It compares public and ops columns, defaults, constraints, indexes, public-function
triggers, policies, views, sequences and functions belonging to the snapshot.
Unrelated extra relations and functions are outside this selected snapshot.
Before comparison, both catalogs replace every quoted SQL string literal in each
definition with the same placeholder. Literal-only changes, including privacy
scrubbing, do not report drift. This also excludes changes to literal values in
function bodies, defaults and constraints from drift detection. This command does
not update the snapshot or apply any schema change to its target.

To compare the old system's and the engine's Deals answers outside CI, set
`COMPARE_TARGET` to `staging` or `production`, `COMPARE_APP_URL` to the app's
https base URL and `COMPARE_SESSION` to a signed-in partner's session cookie
value, then run `npm run compare`. Both systems are read through the app's host,
because sign-in works only there. Production also needs
`COMPARE_CONFIRM_PRODUCTION=read-only`. It only reads and waits 1.5 seconds
between requests. It asks the engine before and after the old system and sets a
request aside as unsettled when the engine's two answers differ. Boards are asked
by workspace only, not by national account. A refused deal is compared as its
refusal; a refused board or invoices read counts as failed. A network or sign-in
failure stops the run. It prints counts, field paths and record IDs, never values, bodies or the
cookie. Exit codes are 0 for a match, 1 for differences or unsettled requests and
2 for failure.
