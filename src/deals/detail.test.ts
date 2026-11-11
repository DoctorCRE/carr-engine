import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { DB } from "../database.d.ts";
import { readDealDetail } from "./detail.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url)
	throw new Error("Run npm run check to restore the test database first");
const db = new Kysely<DB>({
	dialect: new PostgresDialect({
		pool: new pg.Pool({ connectionString: url }),
	}),
});
after(() => db.destroy());

class Rollback extends Error {}

async function rolledBack(run: (tx: Transaction<DB>) => Promise<void>) {
	await assert.rejects(
		db.transaction().execute(async (tx) => {
			await sql`set local time zone 'UTC'`.execute(tx);
			await run(tx);
			throw new Rollback();
		}),
		Rollback,
	);
}

async function seed(tx: Transaction<DB>, deal: { invoiced_on?: string } = {}) {
	const actor = await tx
		.insertInto("actor")
		.values({ slug: "detail-agent", kind: "human", display_name: "Example A" })
		.returning("id")
		.executeTakeFirstOrThrow();
	const audit = { created_by: actor.id, updated_by: actor.id };
	await tx
		.insertInto("contact_state")
		.values({ slug: "active", label: "Example", contactable: true, sort: 1 })
		.onConflict((c) => c.doNothing())
		.execute();
	await tx
		.insertInto("client_status")
		.values({ slug: "detail-active", label: "Example active" })
		.execute();
	await tx
		.insertInto("deal_type_ref")
		.values({ slug: "detail-lease", label: "Example lease", sort: 1 })
		.execute();
	await tx
		.insertInto("deal_phase")
		.values({ slug: "detail-open", label: "Example open" })
		.execute();
	const party = (name: string) =>
		tx
			.insertInto("party")
			.values({ kind: "person", name, ...audit })
			.returning("id")
			.executeTakeFirstOrThrow();
	const client = await tx
		.insertInto("client")
		.values({
			party_id: (await party("Dr. Ada Example (Example Clinic)")).id,
			status: "detail-active",
			roster_ref: "C-9001",
			...audit,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	const row = await tx
		.insertInto("deal")
		.values({
			client_id: client.id,
			name: "Example Detail Deal",
			deal_type: "detail-lease",
			phase: "detail-open",
			city: "Exampleton",
			next_date: "2030-01-15",
			...deal,
			...audit,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return { actor: actor.id, audit, party, client: client.id, deal: row.id };
}

test("an open deal reads with text dates, decimal strings and capped notes", async () => {
	await rolledBack(async (tx) => {
		const { actor, audit, party, deal } = await seed(tx);
		await tx
			.insertInto("deal_note")
			.values(
				Array.from({ length: 501 }, (_, i) => ({
					actor_id: actor,
					deal_id: deal,
					kind: "note",
					text: `Example note ${i}`,
					created_at: new Date(Date.UTC(2030, 0, 1, 0, 0, i)).toISOString(),
				})),
			)
			.execute();
		await tx
			.insertInto("negotiation_round")
			.values({
				deal_id: deal,
				round_no: 1,
				side: "landlord",
				proposed_on: "2030-02-01",
				rate_amount: "12.50",
				rate_basis: "usd_sf_yr",
				term_months: 60,
				created_by: actor,
			})
			.execute();
		await tx
			.insertInto("next_action")
			.values(
				[
					["Example open item", "open"],
					["Example dropped item", "dropped"],
					[null, "open"],
				].map(([title, status], i) => ({
					subject_type: "deal",
					subject_id: deal,
					owner_id: actor,
					description: `Example action ${i}`,
					item_title: title,
					source_ref: title && "example-source",
					item_bullets: JSON.stringify([]),
					status: String(status),
					due_on: "2030-03-01",
					created_at: `2030-01-0${i + 1}T00:00:00Z`,
					...audit,
				})),
			)
			.execute();
		await tx
			.insertInto("event")
			.values({
				subject_type: "deal",
				subject_id: deal,
				verb: "example-verb",
				cause: "system",
				actor_id: actor,
				occurred_at: "2030-01-02T03:04:05.678Z",
				new_value: {
					kept: { phase: "detail-open", sf_close_date_placeholder: "x" },
				},
			})
			.execute();
		const company = await party("Example Title Co");
		const contact = await party("Example Closer");
		await tx
			.insertInto("vendor_disposition")
			.values({ slug: "detail-ok", label: "Example", workable: true, sort: 1 })
			.execute();
		await tx
			.insertInto("vendor")
			.values({
				party_id: contact.id,
				category: "title",
				disposition: "detail-ok",
				...audit,
			})
			.execute();
		await tx
			.insertInto("deal_vendor_assignment")
			.values({
				deal_id: deal,
				party_id: contact.id,
				role: "title",
				company_party_id: company.id,
				contact_party_id: contact.id,
				updated_by: actor,
			})
			.execute();

		const detail = await readDealDetail(tx, deal, "detail-agent");
		assert.ok("operating_state" in detail);
		assert.equal(detail.schema_version, "deal-timeline.v1");
		assert.equal(detail.deal_id, deal);
		assert.equal(detail.next_date, "2030-01-15");
		assert.match(String(detail.next_step), /^Example action/);
		assert.equal(detail.next_step_required, false);
		assert.equal(detail.workspace_kind, "team");
		assert.equal(detail.short_name, "Dr. Example's Exampleton Deal");
		assert.equal(detail.base_version, 1);
		assert.equal(detail.thread.length, 500);
		assert.equal(detail.thread_truncated, true);
		assert.equal(detail.thread[0]?.text, "Example note 500");
		assert.equal(detail.thread[0]?.created_at, "2030-01-01T00:08:20+00:00");
		assert.deepEqual(
			detail.negotiation_rounds.map((r) => [r.rate_amount, r.term_months]),
			[["12.50", 60]],
		);
		assert.deepEqual(
			detail.next_actions.map((a) => a.status),
			["open", "dropped", "open"],
		);
		assert.deepEqual(
			detail.items.map((i) => [i.title, i.due_on]),
			[["Example open item", "2030-03-01"]],
		);
		assert.deepEqual(detail.events[0]?.new_value, {
			kept: { phase: "detail-open" },
		});
		assert.equal(detail.events[0]?.recorded_at?.endsWith("+00:00"), true);
		assert.deepEqual(
			detail.vendors.map((v) => [v.role, v.company, v.contact]),
			[
				[
					"title",
					{ id: company.id, name: "Example Title Co" },
					{ id: contact.id, name: "Example Closer", email: null, phone: null },
				],
			],
		);
		assert.deepEqual(detail.phase_change, null);
		assert.deepEqual(detail.lease, null);
	});
});

test("email threads keep the newest message per conversation", async () => {
	await rolledBack(async (tx) => {
		const { actor, deal } = await seed(tx);
		await tx
			.insertInto("activity_kind")
			.values(
				["email_in", "email_out"].map((slug) => ({
					slug,
					label: slug,
					is_contact: true,
				})),
			)
			.onConflict((c) => c.doNothing())
			.execute();
		await tx
			.insertInto("activity")
			.values(
				[
					["email_in", "t-1", "Old", "2030-01-01T00:00:00Z"],
					["email_out", "t-1", "New", "2030-01-03T00:00:00Z"],
					["email_in", "", "Loose one", "2030-01-02T00:00:00Z"],
					["email_in", null, "Loose two", "2030-01-02T12:00:00Z"],
				].map(([kind, thread, subject, at]) => ({
					kind: String(kind),
					summary: "Example email",
					occurred_at: String(at),
					actor_id: actor,
					deal_id: deal,
					email_context: { conversation_id: thread, subject },
				})),
			)
			.execute();
		const detail = await readDealDetail(tx, deal, "detail-agent");
		assert.ok(!("error" in detail));
		assert.deepEqual(
			detail.email_threads.map((t) => [t.conversation_id, t.subject]),
			[
				["t-1", "New"],
				[null, "Loose two"],
				[null, "Loose one"],
			],
		);
		assert.equal(detail.activities.length, 4);
		assert.equal(
			detail.email_threads[0]?.latest_message_at,
			"2030-01-03T00:00:00+00:00",
		);
	});
});

test("an invoiced deal reads through the archived shape", async () => {
	await rolledBack(async (tx) => {
		const { deal, client } = await seed(tx, { invoiced_on: "2030-04-30" });
		const detail = await readDealDetail(tx, deal, "detail-agent");
		assert.ok(!("error" in detail));
		assert.equal(detail.invoiced_on, "2030-04-30");
		assert.equal(detail.client_id, client);
		assert.equal(detail.workspace_kind, "team");
		assert.equal(detail.short_name, "Example Detail Deal");
		assert.equal("next_step" in detail, false);
		assert.equal("phase_change" in detail, false);
		assert.deepEqual(detail.vendors, []);
	});
});

test("refusals name what went wrong", async () => {
	await rolledBack(async (tx) => {
		const { deal, client, audit, party } = await seed(tx);
		assert.deepEqual(await readDealDetail(tx, deal, "nobody"), {
			error: "unauthenticated",
		});
		assert.deepEqual(await readDealDetail(tx, "C-9001", "detail-agent"), {
			error: "not_a_deal",
			resolved: { type: "client", id: client },
		});
		const byName = await readDealDetail(tx, "Example Detail", "detail-agent");
		assert.ok(!("error" in byName));
		assert.equal(byName.deal_id, deal);
		const missing = await readDealDetail(tx, "No Such Example", "detail-agent");
		assert.equal("error" in missing && missing.error, "subject_not_found");
		await tx
			.insertInto("deal")
			.values({
				client_id: client,
				name: "Example Detail Deal Two",
				deal_type: "detail-lease",
				phase: "detail-open",
				...audit,
			})
			.execute();
		const twice = await readDealDetail(tx, "Example Detail", "detail-agent");
		assert.equal("error" in twice && twice.error, "needs_disambiguation");
		const survivor = await tx
			.insertInto("client")
			.values({ party_id: (await party("Example Survivor")).id, ...audit })
			.returning("id")
			.executeTakeFirstOrThrow();
		await tx
			.updateTable("client")
			.set({ merged_into: survivor.id })
			.where("id", "=", client)
			.execute();
		assert.deepEqual(await readDealDetail(tx, deal, "detail-agent"), {
			error: "not_found",
			table: "deal",
			id: deal,
		});
	});
});
