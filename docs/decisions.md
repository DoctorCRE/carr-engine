# Decisions

1. **New code, same data (2026-11-11).** The engine runs against the existing database while the old system keeps running. Features move one screen or job at a time. This repo applies no schema changes until the old system has stopped applying its own, so the database never has two owners.

2. **Public repo in the organization (2026-11-11).** Public gives us the merge queue and free CI minutes. The cost is that nothing real about the business may appear here, which is why tests use made-up data.

3. **GitHub is the engineering dashboard (2026-11-11).** Issues, pull requests and a Projects board track all work. Work is not tracked in the database.

4. **One check (2026-11-11).** Pull requests and the merge queue run the identical command, `npm run check`, with no secrets and no network, capped at 5 minutes. A change that passes on its pull request cannot meet a different test in the queue.

5. **Stack (2026-11-11).** TypeScript on one Cloudflare Worker with Hono for routing. Node's built-in test runner, so tests need no framework. Biome for lint and format, knip to fail the check on unused code, `tsc` for types.

6. **A feature moves when three things are true (2026-11-11).** Someone used it in the last 30 days, and it is business, not build process (#2). Its reads move first, and a write moves only after its read has run in production. The engine's answers matched the old system's on real requests (#6). The Deals board and deal detail move first (#17). One screen goes end to end before a second starts, because the first sets the pattern the rest copy. Until a feature moves, the old system keeps serving it and keeps taking business features and fixes, but no new build-process work.

7. **Only the owner changes the rules (2026-11-11).** `.github/CODEOWNERS` gives the owner every file except `src/`, `wrangler.jsonc` and `package-lock.json`. The ruleset requires code-owner review, so a pull request that touches an owned file cannot merge by itself. The old system grew because any agent could add a rule, a gate or a script while doing something else. Here that takes the owner's click. Agents and the owner share one GitHub login today, so no one can approve such a pull request, and the owner merges it with a bypass from the pull request page. A bypass also skips the check, so the owner uses it only on a green pull request. A separate login for agents would make this a normal approval.
