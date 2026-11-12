import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "kysely";
import type { Reader } from "../reader.ts";
import { withRollback } from "../test-rollback.ts";
import { readTerritory, type TerritoryFilters } from "./territory.ts";

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NO_FILTER: TerritoryFilters = { vertical: null, city: null, state: null };

// Every seeded name and place is made up.
async function seed(tx: Reader) {
	await sql`insert into actor (slug, kind, display_name)
		values ('territory-partner', 'human', 'Example')`.execute(tx);
	await sql`insert into contact_state (slug, label, contactable, sort)
		values ('active', 'Example', true, 1) on conflict do nothing`.execute(tx);
	await sql`create temp table fixture on commit drop as
		select id as actor from actor where slug = 'territory-partner'`.execute(tx);
}

type Party = {
	city?: string | null;
	state?: string | null;
	specialty?: string | null;
	merged_into?: number;
	deleted?: boolean;
};
const party = (tx: Reader, n: number, p: Party = {}) =>
	sql`insert into party (id, kind, name, city, state, specialty, merged_into,
		deleted_at, created_by, updated_by)
		select ${uuid(n)}::uuid, 'person', 'Example Person',
		${p.city === undefined ? "Springfield" : p.city},
		${p.state === undefined ? "ZZ" : p.state},
		${p.specialty === undefined ? "Dental" : p.specialty},
		${p.merged_into ? uuid(p.merged_into) : null}::uuid,
		${p.deleted ? "2026-01-01T00:00:00Z" : null}::timestamptz, actor, actor
		from fixture`.execute(tx);

type Finding = {
	condition?: string;
	city?: string;
	state?: string;
	found?: boolean;
	kind?: string;
	observed_at?: string;
	expires_on?: string | null;
};
const finding = (tx: Reader, n: number, f: Finding = {}) =>
	sql`insert into record_flag (id, subject_type, subject_id, kind, value, source,
		observed_at, expires_on, created_by)
		select ${uuid(n)}::uuid, 'party', ${uuid(1)}::uuid, ${f.kind ?? "submarket_state"},
		${JSON.stringify({
			condition: f.condition ?? "soft",
			city: f.city ?? "Springfield",
			state: f.state ?? "ZZ",
			...(f.found === undefined ? {} : { found: f.found }),
		})}::jsonb, ${`https://example.test/market/${n}`},
		${f.observed_at ?? "2026-01-02 03:04:05+00"}::timestamptz,
		${f.expires_on === undefined ? "2999-01-01" : f.expires_on}::date, actor
		from fixture`.execute(tx);

async function territory(tx: Reader, filters = NO_FILTER) {
	const answer = await readTerritory(tx, filters);
	assert.ok("submarkets" in answer, JSON.stringify(answer));
	return answer.submarkets;
}

const markets = async (tx: Reader, filters = NO_FILTER) =>
	(await territory(tx, filters)).map((m) => `${m.city}, ${m.state}`);

const condition = async (tx: Reader) => {
	const [market] = await territory(tx, { ...NO_FILTER, city: "Springfield" });
	return market?.condition;
};

test("the answer keeps the old keys, order and text forms", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1);
		await finding(tx, 10, {
			observed_at: "2026-03-08 07:30:00.120+00",
			expires_on: null,
			condition: "tight",
		});
		await finding(tx, 11, { observed_at: "2026-03-09 01:02:03.456789-05" });
		assert.equal(
			JSON.stringify(await readTerritory(tx, NO_FILTER)),
			JSON.stringify({
				schema_version: "territory-state-board.v1",
				coverage: "recorded_geographies_only",
				submarkets: [
					{
						city: "Springfield",
						state: "ZZ",
						evidence: [
							{
								source: "https://example.test/market/11",
								current: true,
								expired: false,
								flag_id: uuid(11),
								condition: "soft",
								expires_on: "2999-01-01",
								observed_at: "2026-03-09T06:02:03.456789+00:00",
							},
							{
								source: "https://example.test/market/10",
								current: false,
								expired: false,
								flag_id: uuid(10),
								condition: "tight",
								expires_on: null,
								observed_at: "2026-03-08T07:30:00.12+00:00",
							},
						],
						condition: "soft",
					},
				],
			}),
		);
	}));

test("markets are the distinct places of live parties with a specialty, by state then city", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, { city: "Beta", state: "AA" });
		await party(tx, 2, { city: "Beta", state: "AA" });
		await party(tx, 3, { city: "Alpha", state: "BB" });
		await party(tx, 4, { city: "Alpha", state: "AA" });
		await party(tx, 5, { city: "Gamma", specialty: null });
		await party(tx, 6, { city: null });
		await party(tx, 7, { city: "Delta", state: null });
		await party(tx, 8, { city: "Merged", merged_into: 1 });
		await party(tx, 9, { city: "Deleted", deleted: true });
		assert.deepEqual(await markets(tx), ["Alpha, AA", "Beta, AA", "Alpha, BB"]);
	}));

test("each filter matches exactly", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, { city: "Alpha", state: "AA", specialty: "Dental" });
		await party(tx, 2, { city: "Beta", state: "AA", specialty: "Vision" });
		await party(tx, 3, { city: "Alpha", state: "BB", specialty: "Vision" });
		const only = (filter: Partial<TerritoryFilters>) =>
			markets(tx, { ...NO_FILTER, ...filter });
		assert.deepEqual(await only({ vertical: "Vision" }), [
			"Beta, AA",
			"Alpha, BB",
		]);
		assert.deepEqual(await only({ city: "Alpha" }), ["Alpha, AA", "Alpha, BB"]);
		assert.deepEqual(await only({ state: "AA" }), ["Alpha, AA", "Beta, AA"]);
		assert.deepEqual(await only({ city: "alpha" }), []);
		assert.deepEqual(await only({ vertical: "Vision", state: "BB" }), [
			"Alpha, BB",
		]);
	}));

test("evidence is the place's submarket findings, newest first then by id", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1);
		await finding(tx, 15, { observed_at: "2026-01-01 00:00:00+00" });
		await finding(tx, 14, { observed_at: "2026-02-01 00:00:00+00" });
		await finding(tx, 13, { observed_at: "2026-01-01 00:00:00+00" });
		await finding(tx, 20, { kind: "market_note" });
		await finding(tx, 21, { condition: "hot" });
		await finding(tx, 22, { city: "Shelbyville" });
		await finding(tx, 23, { state: "YY" });
		const [market] = await territory(tx);
		assert.deepEqual(
			market?.evidence.map((e) => e.flag_id),
			[uuid(14), uuid(13), uuid(15)],
		);
	}));

test("the condition is the one current finding's, unknown without one, conflicting when they disagree", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1);
		assert.equal(await condition(tx), "unknown");
		await finding(tx, 10, { condition: "tight", expires_on: "2000-01-01" });
		await finding(tx, 11, { condition: "tight", expires_on: null });
		await finding(tx, 12, { condition: "tight", found: false });
		await finding(tx, 13, {
			condition: "tight",
			observed_at: "2999-01-01 00:00:00+00",
		});
		const [stale] = await territory(tx);
		assert.equal(stale?.condition, "unknown");
		assert.deepEqual(
			stale?.evidence.map((e) => [e.flag_id, e.expired, e.current]),
			[
				[uuid(13), false, false],
				[uuid(10), true, false],
				[uuid(11), false, false],
				[uuid(12), false, false],
			],
		);
		await finding(tx, 14, { condition: "balanced" });
		await finding(tx, 15, { condition: "balanced", found: true });
		assert.equal(await condition(tx), "balanced");
		await finding(tx, 16, { condition: "soft" });
		assert.equal(await condition(tx), "conflicting");
	}));

test("1000 markets are answered and 1001 refused", () =>
	withRollback(async (tx) => {
		await seed(tx);
		const places = (from: number, to: number) =>
			sql`insert into party (kind, name, city, state, specialty, created_by, updated_by)
				select 'person', 'Example Person', 'City ' || i, 'ZZ', 'Dental', actor, actor
				from fixture, generate_series(${from}::int, ${to}::int) i`.execute(tx);
		await places(1, 1000);
		assert.equal((await territory(tx)).length, 1000);
		await places(1001, 1001);
		assert.deepEqual(await readTerritory(tx, NO_FILTER), {
			error: "limit_exceeded",
		});
	}));
