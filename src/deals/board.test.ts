import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { type Insertable, Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { DB } from "../database.d.ts";
import { readBoard, shortName } from "./board.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url)
	throw new Error("Run npm run check to restore the test database first");
const db = new Kysely<DB>({
	dialect: new PostgresDialect({
		pool: new pg.Pool({ connectionString: url }),
	}),
});
after(() => db.destroy());

async function withRows(
	run: (rows: Awaited<ReturnType<typeof seed>>) => Promise<void>,
) {
	const tx = await db.startTransaction().execute();
	try {
		await sql`set local time zone 'UTC'`.execute(tx);
		await run(await seed(tx));
	} finally {
		await tx.rollback().execute();
	}
}

async function seed(tx: Kysely<DB>) {
	const tag = randomUUID().slice(0, 8);
	const actor = (slug: string) =>
		tx
			.insertInto("actor")
			.values({
				slug: `${slug}-${tag}`,
				kind: "human",
				display_name: "Example",
			})
			.returning(["id", "slug"])
			.executeTakeFirstOrThrow();
	const partner = await actor("partner");
	const audit = { created_by: partner.id, updated_by: partner.id };
	await tx
		.insertInto("contact_state")
		.values({ slug: "active", label: "Example", contactable: true, sort: 1 })
		.onConflict((c) => c.doNothing())
		.execute();
	const type = `lease-${tag}`;
	const phase = `tour-${tag}`;
	await tx
		.insertInto("deal_type_ref")
		.values({ slug: type, label: "Example", sort: 1 })
		.execute();
	await tx
		.insertInto("deal_phase")
		.values({ slug: phase, label: "Example" })
		.execute();
	const party = (name: string, values: Partial<Insertable<DB["party"]>> = {}) =>
		tx
			.insertInto("party")
			.values({ kind: "org", name, ...audit, ...values })
			.returning("id")
			.executeTakeFirstOrThrow();
	const client = async (
		name: string,
		values: Partial<Insertable<DB["client"]>> = {},
		org_id?: string,
	) => {
		const owner = await party(name, org_id ? { org_id } : {});
		const row = await tx
			.insertInto("client")
			.values({ party_id: owner.id, ...audit, ...values })
			.returning("id")
			.executeTakeFirstOrThrow();
		return { ...row, party_id: owner.id };
	};
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
					deal_type: type,
					phase,
					...audit,
					...values,
				})
				.returning("id")
				.executeTakeFirstOrThrow()
		).id;
	return { tx, tag, partner, audit, actor, party, client, deal, phase };
}

test("an open deal carries its cards, steps and field bases in wire formats", () =>
	withRows(
		async ({ tx, tag, partner, audit, actor, party, client, deal, phase }) => {
			const owner = await client("Dr. Jane Example (Example Clinic)");
			const id = await deal(owner.id, "Example Deal", {
				attention: true,
				owner: partner.slug,
				city: "Example City",
				next_date: "2026-05-01",
			});
			await tx
				.insertInto("vendor_category")
				.values({ slug: `bank-${tag}`, label: "Example", sort: 1 })
				.execute();
			await tx
				.insertInto("activity_kind")
				.values({ slug: `call-${tag}`, label: "Example", is_contact: true })
				.execute();
			const company = await party("Example Lender");
			const contact = await party("Pat Example", {
				kind: "person",
				email: "pat@example.com",
				phone: "555-0100",
			});
			await tx
				.insertInto("vendor_disposition")
				.values({
					slug: `ready-${tag}`,
					label: "Example",
					workable: true,
					sort: 1,
				})
				.execute();
			await tx
				.insertInto("vendor")
				.values({
					party_id: company.id,
					category: `bank-${tag}`,
					disposition: `ready-${tag}`,
					...audit,
				})
				.execute();
			await tx
				.insertInto("deal_vendor_assignment")
				.values({
					deal_id: id,
					party_id: company.id,
					role: "lender",
					company_party_id: company.id,
					contact_party_id: contact.id,
					updated_by: partner.id,
					updated_at: "2026-01-02T03:04:05Z",
				})
				.execute();
			const action = {
				subject_type: "deal",
				subject_id: id,
				owner_id: partner.id,
				created_by: partner.id,
			};
			const helpers = [await actor("a"), await actor("b"), await actor("c")];
			const [item, ...open] = await tx
				.insertInto("next_action")
				.values([
					{
						...action,
						description: "Example intro",
						item_title: "Example lender intro",
						due_on: "2026-03-20",
						source_ref: "example:1",
						item_bullets: JSON.stringify([
							{ date: null, kind: "status", text: "Example" },
						]),
						created_at: "2026-01-01T00:00:00Z",
					},
					{
						...action,
						description: "Call the example lender",
						due_on: "2026-04-01",
					},
					{
						...action,
						description: "Dropped",
						item_title: "Example dropped item",
						source_ref: "example:2",
						item_bullets: "[]",
						status: "dropped",
					},
					...["2026-04-02", "2026-04-03", null].map((due_on, i) => ({
						...action,
						owner_id: helpers[i]?.id ?? partner.id,
						description: "Call the example lender",
						due_on,
					})),
					{
						...action,
						description: "Done",
						due_on: "2026-03-15",
						status: "done",
					},
				])
				.returning(["id", "updated_at"])
				.execute();
			await tx
				.insertInto("activity")
				.values({
					deal_id: id,
					actor_id: partner.id,
					kind: `call-${tag}`,
					summary: "Example call",
					occurred_at: "2026-03-01T10:00:00Z",
				})
				.execute();
			const event = {
				actor_id: partner.id,
				subject_type: "deal",
				subject_id: id,
				cause: "human_stated",
			};
			const [phaseEvent] = await tx
				.insertInto("event")
				.values([
					{
						...event,
						verb: "patch-deal-field",
						field: "phase",
						old_value: JSON.stringify({ phase: "intro" }),
						new_value: JSON.stringify({ phase }),
						occurred_at: "2026-02-01T03:00:00Z",
						recorded_at: "2026-02-01T03:00:00.5Z",
					},
					{
						...event,
						verb: "complete-action",
						new_value: JSON.stringify({
							status: "done",
							outcome: "Example outcome",
						}),
						occurred_at: "2026-03-02T10:00:00Z",
						recorded_at: "2026-03-02T10:00:00Z",
					},
					{
						...event,
						verb: "complete-action",
						new_value: JSON.stringify({ status: "open", outcome: "Not done" }),
						occurred_at: "2026-03-03T10:00:00Z",
						recorded_at: "2026-03-03T10:00:00Z",
					},
					{
						...event,
						verb: "patch-deal-field",
						field: "phase",
						old_value: JSON.stringify({ phase: "lead" }),
						new_value: JSON.stringify({ phase: "intro" }),
						occurred_at: "2026-01-20T12:00:00Z",
						recorded_at: "2026-01-20T12:00:00Z",
					},
				])
				.returning("id")
				.execute();
			const board = await readBoard(tx, {
				actor: partner.slug,
				workspace: "team",
			});
			assert.equal(board.schema_version, "local-deals-board.v2");
			assert.equal(board.actor, partner.slug);
			const row = board.deals.find((d) => d.id === id);
			assert.ok(row && item && phaseEvent);
			assert.deepEqual(row, {
				id,
				name: "Example Deal",
				type: `lease-${tag}`,
				phase,
				owner: partner.slug,
				attention: true,
				base_version: 1,
				vendors: [
					{
						party_id: company.id,
						role: "lender",
						company: { id: company.id, name: "Example Lender" },
						contact: {
							id: contact.id,
							name: "Pat Example",
							email: "pat@example.com",
							phone: "555-0100",
						},
						note: null,
						updated_at: "2026-01-02T03:04:05+00:00",
					},
				],
				next_date: "2026-05-01",
				next_step: "Call the example lender",
				item_schema_version: "deal-items.v1",
				items: [
					{
						id: item.id,
						title: "Example lender intro",
						due_on: "2026-03-20",
						status: "open",
						bullets: [{ date: null, kind: "status", text: "Example" }],
						source_ref: "example:1",
					},
				],
				open_actions: ["2026-04-01", "2026-04-02", "2026-04-03"].map(
					(due_on, i) => ({
						id: open[i === 0 ? 0 : i + 1]?.id,
						item_id: `next_action:${open[i === 0 ? 0 : i + 1]?.id}`,
						owner: i === 0 ? partner.slug : helpers[i - 1]?.slug,
						description: "Call the example lender",
						due_on,
					}),
				),
				last_step: {
					kind: "completed_action",
					summary: "Example outcome",
					occurred_at: "2026-03-02T10:00:00+00:00",
				},
				next_step_required: false,
				market: "Example City",
				segment: null,
				client_id: owner.id,
				client_ref: null,
				client_name: "Dr. Jane Example (Example Clinic)",
				client_status: null,
				client_version: 1,
				prospect_engagement_status: "active",
				account_client_id: null,
				account_client_ref: null,
				account_name: null,
				account_owner: null,
				market_agent: null,
				last_touch: "2026-03-01",
				last_review_at: null,
				workspace_kind: "team",
				operating_state: "active",
				parking_reason: null,
				parking_note: null,
				invoiced_on: null,
				closed_on: null,
				lane: null,
				outcome: null,
				phase_change: {
					deal_id: id,
					event_id: phaseEvent.id,
					prior_phase: "intro",
					phase,
					automatic: false,
					reason: "phase changed",
					evidence_date: "2026-02-01T03:00:00+00:00",
					recorded_at: "2026-02-01T03:00:00.5+00:00",
				},
				phase_started_on: { intro: "2026-01-20", [phase]: "2026-01-31" },
				parked_at: null,
				parked_by: null,
				field_base: {
					phase: {
						id: phaseEvent.id,
						recorded_at: "2026-02-01T03:00:00.5+00:00",
					},
				},
				short_name: "Dr. Example's Example City Deal",
			});
		},
	));

test("open deals leave out closed and lost ones, sort, and filter", () =>
	withRows(async ({ tx, partner, client, deal }) => {
		const team = await client("Example Team Client");
		const later = await deal(team.id, "Example A", { next_date: "2026-06-01" });
		const flagged = await deal(team.id, "Example Z", { attention: true });
		const undated = await deal(team.id, "Example B");
		const parked = await deal(team.id, "Example C", {
			next_date: "2026-07-01",
			operating_state: "parked",
			parking_reason: "other",
			parked_at: "2026-01-05T00:00:00Z",
			parked_by: partner.id,
		});
		const won = await deal(team.id, "Example Won", {
			outcome: "won",
			closed_on: "2026-01-15",
		});
		const lost = await deal(team.id, "Example Lost", { outcome: "lost" });
		await tx
			.insertInto("client_type")
			.values({ slug: "national_account", label: "Example" })
			.onConflict((c) => c.doNothing())
			.execute();
		const account = await client("Example National", {
			client_type: "national_account",
		});
		const member = await client("Example Member", {}, account.party_id);
		const national = await deal(member.id, "Example National Deal");
		const mine = [later, flagged, undated, parked, won, lost, national];
		const read = async (
			workspace?: "team" | "national_account",
			account_client_id?: string,
		) => {
			const board = await readBoard(tx, {
				actor: partner.slug,
				...(workspace && { workspace }),
				...(account_client_id !== undefined && { account_client_id }),
			});
			return board.deals.filter((d) => d.id && mine.includes(d.id));
		};
		const all = await read();
		assert.deepEqual(
			all.map((d) => d.id),
			[flagged, later, parked, undated, national],
		);
		assert.deepEqual(
			all.map((d) => [d.workspace_kind, d.account_client_id]).slice(3),
			[
				["team", null],
				["national_account", account.id],
			],
		);
		assert.equal(all[2]?.parked_at, "2026-01-05T00:00:00+00:00");
		assert.equal(all[1]?.next_step_required, true);
		assert.equal(all[3]?.next_step_required, true);
		for (const workspace of [null, ""] as const) {
			const board = await readBoard(tx, { actor: partner.slug, workspace });
			assert.deepEqual(
				board.deals.filter((d) => d.id && mine.includes(d.id)),
				all,
			);
		}
		assert.deepEqual(
			(await read("team")).map((d) => d.id),
			[flagged, later, parked, undated],
		);
		assert.deepEqual(
			(await read("national_account")).map((d) => d.id),
			[national],
		);
		assert.deepEqual(
			(await read(undefined, account.id)).map((d) => d.id),
			[national],
		);
		assert.deepEqual(
			(await read(undefined, "")).map((d) => d.id),
			all.map((d) => d.id),
		);
	}));

test("closed and lost deals split, sort and filter by workspace", () =>
	withRows(async ({ tx, partner, client, deal, phase }) => {
		const team = await client("Example Team Client");
		const early = await deal(team.id, "Example Early", {
			outcome: "won",
			closed_on: "2026-01-15",
		});
		const late = await deal(team.id, "Example Late", {
			closed_on: "2026-02-01",
			invoiced_on: "2026-02-03",
		});
		const lost = await deal(team.id, "Example Lost", { outcome: "lost" });
		const open = await deal(team.id, "Example Open");
		await tx
			.insertInto("client_type")
			.values({ slug: "national_account", label: "Example" })
			.onConflict((c) => c.doNothing())
			.execute();
		const account = await client("Example National", {
			client_type: "national_account",
		});
		const member = await client("Example Member", {}, account.party_id);
		const national = await deal(member.id, "Example National Won", {
			outcome: "won",
		});
		await tx
			.updateTable("party")
			.set({ org_id: account.party_id })
			.where("id", "=", account.party_id)
			.execute();
		const direct = await deal(account.id, "Example Direct Won", {
			outcome: "won",
		});
		const mine = [early, late, lost, open, national, direct];
		const read = async (
			workspace?: "team" | "national_account",
			account_client_id?: string,
		) => {
			const board = await readBoard(tx, {
				actor: partner.slug,
				...(workspace && { workspace }),
				...(account_client_id && { account_client_id }),
			});
			const pick = (rows: { id: string | null }[]) =>
				rows.map((r) => r.id).filter((id) => id && mine.includes(id));
			return {
				closed: pick(board.closed_deals),
				lost: pick(board.lost_deals),
				board,
			};
		};
		const all = await read();
		assert.deepEqual(all.closed, [late, early, direct, national]);
		assert.deepEqual(all.lost, [lost]);
		assert.deepEqual(
			all.board.closed_deals.find((d) => d.id === late),
			{
				id: late,
				name: "Example Late",
				client_ref: null,
				client_name: "Example Team Client",
				type: all.board.closed_deals[0]?.type,
				vendors: [],
				phase,
				outcome: null,
				owner: null,
				closed_on: "2026-02-01",
				invoiced_on: "2026-02-03",
				account_client_id: null,
				workspace_kind: "team",
			},
		);
		assert.deepEqual(
			all.board.closed_deals
				.filter((d) => d.id === national)
				.map((d) => [d.account_client_id, d.workspace_kind]),
			[[account.id, "national_account"]],
		);
		assert.deepEqual((await read("team")).closed, [late, early, direct]);
		assert.deepEqual((await read("national_account")).closed, [national]);
		assert.deepEqual((await read(undefined, account.id)).closed, [national]);
	}));

test("accounts summarize national accounts and skip inactive prospects", () =>
	withRows(async ({ tx, tag, partner, client, deal }) => {
		await tx
			.insertInto("client_type")
			.values({ slug: "national_account", label: "Example" })
			.onConflict((c) => c.doNothing())
			.execute();
		const account = await client("Example National", {
			client_type: "national_account",
		});
		const member = await client("Example Member", {}, account.party_id);
		await deal(member.id, "Example Overdue", {
			attention: true,
			next_date: "2020-01-01",
		});
		await deal(member.id, "Example Parked", {
			operating_state: "parked",
			parking_reason: "other",
			parked_at: "2026-01-05T00:00:00Z",
			parked_by: partner.id,
		});
		await tx
			.insertInto("national_account_owner")
			.values({
				account_client_id: account.id,
				owner_actor_id: partner.id,
				set_by: partner.id,
			})
			.execute();
		await tx
			.insertInto("deal_review_session")
			.values({
				workspace_kind: "national_account",
				account_client_id: account.id,
				started_by: partner.id,
				started_at: "2026-02-01T00:00:00Z",
				ended_at: "2026-02-02T00:00:00Z",
				status: "completed",
			})
			.execute();
		const board = await readBoard(tx, {
			actor: partner.slug,
			workspace: "team",
		});
		assert.deepEqual(
			board.accounts.find((a) => a.account_client_id === account.id),
			{
				account_client_id: account.id,
				account_client_ref: null,
				account_name: "Example National",
				account_owner: partner.slug,
				base_version: 1,
				open_deals: "1",
				attention_deals: "1",
				overdue_deals: "1",
				stale_deals: "1",
				last_review_at: "2026-02-02T00:00:00+00:00",
				parked_deals: "1",
				client_status: null,
				client_version: 1,
				prospect_engagement_status: "active",
			},
		);
		await tx
			.insertInto("client_status")
			.values({ slug: "prospect", label: "Example" })
			.onConflict((c) => c.doNothing())
			.execute();
		await tx
			.updateTable("client")
			.set({ status: "prospect" })
			.where("id", "=", account.id)
			.execute();
		const active = await readBoard(tx, { actor: partner.slug });
		assert.equal(
			active.accounts.find((a) => a.account_client_id === account.id)
				?.client_status,
			"prospect",
		);
		await tx
			.updateTable("client")
			.set({ prospect_engagement_status: "inactive" })
			.where("id", "=", account.id)
			.execute();
		const quiet = await readBoard(tx, { actor: partner.slug });
		assert.equal(
			quiet.accounts.some((a) => a.account_client_id === account.id),
			false,
		);
		const current = `current-${tag}`;
		await tx
			.insertInto("client_status")
			.values({ slug: current, label: "Example" })
			.execute();
		await tx
			.updateTable("client")
			.set({ status: current })
			.where("id", "=", account.id)
			.execute();
		const kept = await readBoard(tx, { actor: partner.slug });
		assert.equal(
			kept.accounts.some((a) => a.account_client_id === account.id),
			true,
		);
	}));

test("open_session is the signed-in actor's open review", () =>
	withRows(async ({ tx, partner, actor }) => {
		const other = await actor("other");
		const session = (started_by: string, started_at: string, status = "open") =>
			tx
				.insertInto("deal_review_session")
				.values({
					workspace_kind: "team",
					started_by,
					started_at,
					status,
					ended_at: status === "open" ? null : started_at,
				})
				.returning("id")
				.executeTakeFirstOrThrow();
		await session(partner.id, "2026-02-01T00:00:00Z", "completed");
		const mine = await session(partner.id, "2026-02-03T00:00:00Z");
		await session(partner.id, "2026-02-04T00:00:00Z", "completed");
		await session(other.id, "2026-02-05T00:00:00Z");
		assert.deepEqual(
			(await readBoard(tx, { actor: partner.slug, workspace: "team" }))
				.open_session,
			{
				session_id: mine.id,
				workspace_kind: "team",
				account_client_id: null,
				started_at: "2026-02-03T00:00:00+00:00",
			},
		);
		assert.equal(
			(
				await readBoard(tx, {
					actor: partner.slug,
					workspace: "national_account",
				})
			).open_session,
			null,
		);
		assert.equal((await readBoard(tx, { actor: "nobody" })).open_session, null);
	}));

test("short_name uses the doctor's last name and market, else the deal name", () => {
	const deal = { name: "Example Deal", market: "Example City" };
	assert.equal(
		shortName({
			...deal,
			client_name: "Dr. Mary Ann Example (Example Clinic)",
		}),
		"Dr. Example's Example City Deal",
	);
	assert.equal(
		shortName({ ...deal, client_name: "Dr Jo O'Example" }),
		"Dr. O'Example's Example City Deal",
	);
	assert.equal(
		shortName({ ...deal, client_name: "Example Clinic" }),
		"Example Deal",
	);
	assert.equal(
		shortName({ ...deal, market: null, client_name: "Dr. Jo Example" }),
		"Example Deal",
	);
});
