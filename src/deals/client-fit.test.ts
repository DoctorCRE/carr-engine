import assert from "node:assert/strict";
import { test } from "node:test";
import { type Insertable, type Kysely, sql } from "kysely";
import type { DB } from "../database.d.ts";
import { withRollback } from "../test-rollback.ts";
import { type ClientFitFilters, readClientFit } from "./client-fit.ts";

const everything = { vertical: null, city: null, state: null };

async function seed(tx: Kysely<DB>) {
	const actor = await tx
		.insertInto("actor")
		.values({ slug: "fit-partner", kind: "human", display_name: "Example" })
		.returning("id")
		.executeTakeFirstOrThrow();
	const audit = { created_by: actor.id, updated_by: actor.id };
	await tx
		.insertInto("contact_state")
		.values({ slug: "active", label: "Example", contactable: true, sort: 1 })
		.onConflict((c) => c.doNothing())
		.execute();
	await tx
		.insertInto("deal_type_ref")
		.values([
			{ slug: "fit-lease", label: "Example lease", sort: 1 },
			{ slug: "fit-purchase", label: "Example purchase", sort: 2 },
		])
		.execute();
	await tx
		.insertInto("deal_phase")
		.values([
			{ slug: "closed", label: "Example closed" },
			{ slug: "fit-open", label: "Example open" },
		])
		.onConflict((c) => c.doNothing())
		.execute();
	const dates = await tx
		.selectNoFrom([
			sql<string>`current_date::text`.as("today"),
			sql<string>`(current_date + 1)::text`.as("tomorrow"),
		])
		.executeTakeFirstOrThrow();
	const party = async (values: Partial<Insertable<DB["party"]>> = {}) =>
		(
			await tx
				.insertInto("party")
				.values({ kind: "person", name: "Example Person", ...audit, ...values })
				.returning("id")
				.executeTakeFirstOrThrow()
		).id;
	const client = async (
		owner: Partial<Insertable<DB["party"]>>,
		values: Partial<Insertable<DB["client"]>> = {},
	) =>
		(
			await tx
				.insertInto("client")
				.values({ party_id: await party(owner), ...audit, ...values })
				.returning("id")
				.executeTakeFirstOrThrow()
		).id;
	const deal = async (
		client_id: string,
		name: string,
		values: Partial<Insertable<DB["deal"]>> = {},
	) =>
		(
			await tx
				.insertInto("deal")
				.values({
					client_id,
					name,
					deal_type: "fit-lease",
					phase: "closed",
					outcome: "won",
					closed_on: "2024-05-01",
					city: "Springfield",
					...audit,
					...values,
				})
				.returning("id")
				.executeTakeFirstOrThrow()
		).id;
	return { ...dates, party, client, deal };
}

async function profiles(
	tx: Kysely<DB>,
	filters: Partial<ClientFitFilters> = {},
) {
	const fit = await readClientFit(tx, { ...everything, ...filters });
	assert.ok(!("error" in fit));
	return fit.profiles;
}
const dealNames = async (tx: Kysely<DB>, filters = {}) =>
	(await profiles(tx, filters)).flatMap((p) =>
		p.evidence.map((e) => e.deal_name),
	);

test("won deals group by vertical, deal type, city and state with dated evidence", () =>
	withRollback(async (tx) => {
		const { client, deal } = await seed(tx);
		const dental = await client({ state: "IL" }, { vertical: "dental" });
		const other = await client({ state: "IL", specialty: "dental" });
		const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
		// The ids run against both the dates and the names.
		await deal(dental, "Example A Later", {
			id: id(1),
			closed_on: "2024-06-01",
		});
		await deal(other, "Example B Early", { id: id(3) });
		await deal(dental, "Example C Early", { id: id(2) });
		const evidence = (n: number, closed_on: string, deal_name: string) => ({
			deal_id: id(n),
			closed_on,
			deal_name,
		});
		assert.equal(
			JSON.stringify(await readClientFit(tx, everything)),
			JSON.stringify({
				schema_version: "ideal-client-profile.v1",
				coverage: "recorded_closed_won_only",
				profiles: [
					{
						vertical: "dental",
						deal_type: "fit-lease",
						city: "Springfield",
						state: "IL",
						won_deals: 3,
						clients: 2,
						evidence: [
							evidence(2, "2024-05-01", "Example C Early"),
							evidence(3, "2024-05-01", "Example B Early"),
							evidence(1, "2024-06-01", "Example A Later"),
						],
						hypothesis:
							"Historical fit, not a prediction or qualification rule.",
					},
				],
			}),
		);
	}));

test("only recorded wins closed by today count, from live unmerged clients", () =>
	withRollback(async (tx) => {
		const { today, tomorrow, party, client, deal } = await seed(tx);
		const live = await client({});
		await deal(live, "Example Today Deal", { closed_on: today });
		await deal(live, "Example Future Deal", { closed_on: tomorrow });
		await deal(live, "Example Undated Deal", { closed_on: null });
		await deal(live, "Example Lost Deal", { outcome: "lost" });
		await deal(live, "Example Unsettled Deal", { outcome: null });
		await deal(live, "Example Open Deal", { phase: "fit-open" });
		await deal(
			await client({}, { merged_into: live }),
			"Example Merged Client Deal",
		);
		await deal(
			await client({ merged_into: await party() }),
			"Example Merged Party Deal",
		);
		await deal(
			await client({ deleted_at: "2024-01-01 00:00:00+00" }),
			"Example Deleted Party Deal",
		);
		assert.deepEqual(await dealNames(tx), ["Example Today Deal"]);
	}));

test("vertical falls back from client to segment to specialty, blanks stay, and the most wins lead", () =>
	withRollback(async (tx) => {
		const { client, deal } = await seed(tx);
		const a = await client({ state: "IL" }, { vertical: "dental" });
		await deal(a, "Example A1", { city: "Alton" });
		await deal(a, "Example A2", { city: "Alton" });
		await deal(a, "Example A3", { deal_type: "fit-purchase" });
		await deal(a, "Example A4");
		await deal(
			await client({ state: "MO" }, { vertical: "dental" }),
			"Example B",
		);
		await deal(
			await client({ state: "IL" }, { vertical: "chiropractic" }),
			"Example C",
		);
		await deal(await client({ state: "IL" }), "Example D");
		const blank = await client(
			{ specialty: "optometry", state: "" },
			{ vertical: "" },
		);
		await deal(blank, "Example Segment Deal", { segment: "dental", city: "" });
		await deal(blank, "Example Specialty Deal", { segment: "" });
		await deal(await client({}), "Example Unrecorded Deal", { city: null });
		const groups = (await profiles(tx)).map((p) => [
			p.won_deals,
			p.vertical,
			p.deal_type,
			p.city,
			p.state,
		]);
		assert.deepEqual(groups, [
			[2, "dental", "fit-lease", "Alton", "IL"],
			[1, "chiropractic", "fit-lease", "Springfield", "IL"],
			[1, "dental", "fit-lease", "", ""],
			[1, "dental", "fit-lease", "Springfield", "IL"],
			[1, "dental", "fit-lease", "Springfield", "MO"],
			[1, "dental", "fit-purchase", "Springfield", "IL"],
			[1, "optometry", "fit-lease", "Springfield", ""],
			[1, null, "fit-lease", "Springfield", "IL"],
			[1, null, "fit-lease", null, null],
		]);
	}));

test("each filter matches exactly and narrows the groups", () =>
	withRollback(async (tx) => {
		const { client, deal } = await seed(tx);
		const il = await client({ state: "IL" }, { vertical: "dental" });
		const mo = await client({ state: "MO" }, { vertical: "optometry" });
		await deal(il, "Example IL Deal", { city: "Alton" });
		await deal(mo, "Example MO Deal");
		const names = (filters: Partial<ClientFitFilters>) =>
			dealNames(tx, filters);
		assert.deepEqual(await names({ vertical: "dental" }), ["Example IL Deal"]);
		assert.deepEqual(await names({ city: "Springfield" }), ["Example MO Deal"]);
		assert.deepEqual(await names({ state: "MO" }), ["Example MO Deal"]);
		assert.deepEqual(await names({ state: "mo" }), []);
		assert.deepEqual(await names({ vertical: "dental", state: "MO" }), []);
	}));
