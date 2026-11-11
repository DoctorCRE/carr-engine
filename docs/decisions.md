# Decisions

1. **New code, same data (2026-11-11).** The engine runs against the existing database while the old system keeps running. Features move one screen or job at a time. This repo applies no schema changes until the old system has stopped applying its own, so the database never has two owners.

2. **Public repo in the organization (2026-11-11).** Public gives us the merge queue and free CI minutes. The cost is that nothing real about the business may appear here, which is why tests use made-up data.

3. **GitHub is the engineering dashboard (2026-11-11).** Issues, pull requests and a Projects board track all work. Work is not tracked in the database.

4. **One check (2026-11-11).** Pull requests and the merge queue run the identical command, `npm run check`, with no secrets and no network, capped at 5 minutes. A change that passes on its pull request cannot meet a different test in the queue.

5. **Stack (2026-11-11).** TypeScript on one Cloudflare Worker with Hono for routing. Node's built-in test runner, so tests need no framework. Biome for lint and format, knip to fail the check on unused code, `tsc` for types.

6. **Real SQL in disposable PostgreSQL (2026-11-11).** Use the GitHub Actions PostgreSQL 18 service and the same server version locally. Both PostgreSQL 18.6 and PGlite 0.5.16 loaded the reviewed business snapshot with pgcrypto and pg_trgm in five alternating runs. Restore medians were 0.269 seconds for PostgreSQL and 0.805 seconds for PGlite, with ranges of 0.205–0.408 and 0.671–1.243 seconds. PGlite includes instance startup; PostgreSQL excludes cluster provisioning, which Actions owns. Both fit the budget, so the existing platform feature wins. Each check creates and drops its own database and generates Kysely types from its restored catalog before TypeScript runs. The separate drift command reads only the target catalog and compares selected objects, including intentional differences from privacy scrubbing. The snapshot includes only public structure and constraints and its public-function triggers. Side effects of old CARR's triggers on writes are checked by the old-versus-new comparison (#6) against staging, not here. The engine never applies this snapshot to the shared database.
