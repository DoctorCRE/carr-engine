# Decisions

1. **New code, same data (2026-11-11).** The engine runs against the existing database while the old system keeps running. Features move one screen or job at a time. This repo applies no schema changes until the old system has stopped applying its own, so the database never has two owners.

2. **Public repo in the organization (2026-11-11).** Public gives us the merge queue and free CI minutes. The cost is that nothing real about the business may appear here, which is why tests use made-up data.

3. **GitHub is the engineering dashboard (2026-11-11).** Issues, pull requests and a Projects board track all work. Work is not tracked in the database.

4. **One check (2026-11-11).** Pull requests and the merge queue run the identical command, `npm run check`, with no secrets and no network, capped at 5 minutes. A change that passes on its pull request cannot meet a different test in the queue.

5. **Stack (2026-11-11).** TypeScript on one Cloudflare Worker with Hono for routing. Node's built-in test runner, so tests need no framework. Biome for lint and format, knip to fail the check on unused code, `tsc` for types.

6. **Reuse browser sessions (2026-11-11).** The engine validates the existing host-only session cookie through CARR’s `/auth/session`, preserving the browser origin and host. CARR remains responsible for session storage and renewal until sign-in moves in a later issue. Engine writes always require the returned CSRF token, same-origin Origin and fetch metadata. Authentication outages fail closed with 503. Node compatibility enables the platform’s native `timingSafeEqual` on SHA-256 token digests, so unequal token lengths also receive a constant-time comparison without a new dependency.
