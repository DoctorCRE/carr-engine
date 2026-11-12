import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "kysely";
import type { Reader } from "../reader.ts";
import { withRollback } from "../test-rollback.ts";
import { readQuietFollowUps } from "./quiet-follow-ups.ts";

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEFAULT = { lead_days: 45, vendor_days: 90 };

// Every seeded name is made up.
async function seed(tx: Reader) {
	await sql`insert into actor (id, slug, kind, display_name) values
		(${uuid(1)}, 'quiet-partner', 'human', 'Example'),
		(${uuid(2)}, 'quiet-other', 'human', 'Example')`.execute(tx);
	for (const statement of [
		sql`insert into contact_state (slug, label, contactable, sort) values
			('active', 'Example', true, 1), ('nurture', 'Example', true, 2),
			('paused', 'Example', false, 3) on conflict do nothing`,
		sql`insert into lead_stage (slug, label) values ('new', 'Example'),
			('qualified', 'Example'), ('outreach_active', 'Example'), ('engaged', 'Example'),
			('nurture_drip', 'Example'), ('closed_won', 'Example') on conflict do nothing`,
		sql`insert into client_status (slug, label) values ('active', 'Example'),
			('cold', 'Example'), ('paused', 'Example') on conflict do nothing`,
		sql`insert into vendor_disposition (slug, label, workable, sort) values
			('active', 'Example', true, 1), ('archived', 'Example', false, 2)
			on conflict do nothing`,
		sql`insert into activity_kind (slug, label, is_contact) values
			('call', 'Example', true), ('memo', 'Example', false) on conflict do nothing`,
	])
		await statement.execute(tx);
}

type Party = { contact_state?: string; merged?: boolean; deleted?: boolean };
const party = (tx: Reader, n: number, p: Party = {}) =>
	sql`insert into party (id, kind, name, contact_state, merged_into, deleted_at,
		created_by, updated_by)
		values (${uuid(n)}, 'person', ${`Example Person ${n}`}, ${p.contact_state ?? "active"},
		${p.merged ? uuid(n) : null}::uuid, ${p.deleted ? "2026-01-01T00:00:00Z" : null}::timestamptz,
		${uuid(1)}, ${uuid(1)})`.execute(tx);

type Lead = {
	stage?: string;
	suppressed?: boolean;
	client?: number;
	owner?: number;
	last_touch?: string;
	next_action_date?: string;
	created_at?: string;
};
// A lead is its own party: lead n sits on party n.
async function lead(tx: Reader, n: number, l: Lead = {}, p: Party = {}) {
	await party(tx, n, p);
	await sql`insert into lead (id, party_id, registry_ref, stage, suppressed, client_id,
		owner_id, last_touch, next_action_date, created_at, created_by, updated_by)
		values (${uuid(n)}, ${uuid(n)}, ${`L-${n}`}, ${l.stage ?? "new"}, ${l.suppressed ?? false},
		${l.client ? uuid(l.client) : null}::uuid, ${l.owner ? uuid(l.owner) : null}::uuid,
		${l.last_touch ?? null}::date, ${l.next_action_date ?? null}::date,
		${l.created_at ?? "2020-01-01 12:00:00+00"}, ${uuid(1)}, ${uuid(1)})`.execute(
		tx,
	);
}

type Vendor = {
	disposition?: string;
	merged?: boolean;
	owner?: number;
	last_touch?: string;
	created_at?: string;
};
async function vendor(tx: Reader, n: number, v: Vendor = {}) {
	await party(tx, n);
	await sql`insert into vendor (id, party_id, vendor_ref, category, disposition, merged_into,
		owner_id, last_touch, created_at, created_by, updated_by)
		values (${uuid(n)}, ${uuid(n)}, ${`V-${n}`}, 'example', ${v.disposition ?? "active"},
		${v.merged ? uuid(n) : null}::uuid, ${v.owner ? uuid(v.owner) : null}::uuid,
		${v.last_touch ?? null}::date, ${v.created_at ?? "2020-01-01 12:00:00+00"},
		${uuid(1)}, ${uuid(1)})`.execute(tx);
}

const client = (tx: Reader, n: number, status: string | null, merged = false) =>
	party(tx, n).then(() =>
		sql`insert into client (id, party_id, status, merged_into, created_by, updated_by)
			values (${uuid(n)}, ${uuid(n)}, ${status}, ${merged ? uuid(n) : null}::uuid,
			${uuid(1)}, ${uuid(1)})`.execute(tx),
	);

const nextAction = (
	tx: Reader,
	subject_type: string,
	subject: number,
	status = "open",
) =>
	sql`insert into next_action (subject_type, subject_id, owner_id, description, status,
		created_by) values (${subject_type}, ${uuid(subject)}, ${uuid(1)}, 'Example step',
		${status}, ${uuid(1)})`.execute(tx);

const touch = (
	tx: Reader,
	column: "lead_id" | "vendor_id",
	n: number,
	at: string,
	kind = "call",
) =>
	sql`insert into activity (occurred_at, actor_id, kind, summary, ${sql.ref(column)})
		values (${at}, ${uuid(1)}, ${kind}, 'Example touch', ${uuid(n)})`.execute(
		tx,
	);

async function read(
	tx: Reader,
	cadence = DEFAULT,
	owner: string | null = null,
) {
	const quiet = await readQuietFollowUps(tx, cadence, owner);
	assert.ok(!("error" in quiet), JSON.stringify(quiet));
	return quiet;
}
const ids = async (
	tx: Reader,
	cadence = DEFAULT,
	owner: string | null = null,
) => (await read(tx, cadence, owner)).proposals.map((p) => p.subject_id);
const daysSince = async (tx: Reader, date: string) =>
	(
		await sql<{
			n: number;
		}>`select carr_business_date() - ${date}::date as n`.execute(tx)
	).rows[0]?.n;

test("an answer has the old keys, key order, nulls and formats", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await lead(tx, 10, {
			owner: 1,
			last_touch: "2026-01-02",
			created_at: "2019-05-05 12:00:00+00",
		});
		await vendor(tx, 20);
		const quiet = await read(tx);
		const expected = {
			schema_version: "quiet-follow-ups.v1",
			cadence: { lead_days: 45, vendor_days: 90 },
			proposals: [
				{
					subject_type: "vendor",
					subject_id: uuid(20),
					party_id: uuid(20),
					ref: "V-20",
					name: "Example Person 20",
					owner_id: null,
					anchor_on: "2020-01-01",
					basis: "created_at",
					next_action_date: null,
					client_id: null,
					interval_days: 90,
					due_on: "2020-03-31",
					owner: null,
					days_overdue: await daysSince(tx, "2020-03-31"),
				},
				{
					subject_type: "lead",
					subject_id: uuid(10),
					party_id: uuid(10),
					ref: "L-10",
					name: "Example Person 10",
					owner_id: uuid(1),
					anchor_on: "2026-01-02",
					basis: "last_contact",
					next_action_date: null,
					client_id: null,
					interval_days: 45,
					due_on: "2026-02-16",
					owner: "quiet-partner",
					days_overdue: await daysSince(tx, "2026-02-16"),
				},
			],
			sent: false,
			tasks_created: false,
		};
		assert.equal(JSON.stringify(quiet), JSON.stringify(expected));
	}));

test("leads count only when open, unsuppressed and on a live, contactable party", () =>
	withRollback(async (tx) => {
		await seed(tx);
		const open = [
			"new",
			"qualified",
			"outreach_active",
			"engaged",
			"nurture_drip",
		];
		for (const [i, stage] of open.entries()) await lead(tx, 10 + i, { stage });
		await lead(tx, 20, {}, { contact_state: "nurture" });
		await lead(tx, 30, { stage: "closed_won" });
		await lead(tx, 31, { suppressed: true });
		await lead(tx, 32, {}, { contact_state: "paused" });
		await lead(tx, 33, {}, { merged: true });
		await lead(tx, 34, {}, { deleted: true });
		assert.deepEqual(await ids(tx), [10, 11, 12, 13, 14, 20].map(uuid));
	}));

test("vendors count only when live and active, on their own cadence", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await vendor(tx, 10, { created_at: "2026-01-01 12:00:00+00" });
		await vendor(tx, 11, { disposition: "archived" });
		await vendor(tx, 12, { merged: true });
		const quiet = await read(tx, { lead_days: 45, vendor_days: 7 });
		assert.deepEqual(
			quiet.proposals.map((p) => [p.subject_id, p.interval_days, p.due_on]),
			[[uuid(10), 7, "2026-01-08"]],
		);
	}));

test("a lead linked to a cold, paused or merged client is left out", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await client(tx, 1000, "active");
		await client(tx, 1001, null);
		await client(tx, 1002, "cold");
		await client(tx, 1003, "paused");
		await client(tx, 1004, "active", true);
		for (const n of [0, 1, 2, 3, 4])
			await lead(tx, 10 + n, { client: 1000 + n });
		const quiet = await read(tx);
		assert.deepEqual(
			quiet.proposals.map((p) => [p.subject_id, p.client_id]),
			[
				[uuid(10), uuid(1000)],
				[uuid(11), uuid(1001)],
			],
		);
	}));

test("an open next action on the record or its client leaves it out", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await client(tx, 1000, "active");
		await lead(tx, 10);
		await lead(tx, 11);
		await lead(tx, 12, { client: 1000 });
		await vendor(tx, 13);
		await vendor(tx, 14);
		await nextAction(tx, "lead", 11);
		await nextAction(tx, "client", 1000);
		await nextAction(tx, "vendor", 14);
		await nextAction(tx, "lead", 10, "done");
		await nextAction(tx, "vendor", 13, "dropped");
		assert.deepEqual(await ids(tx), [10, 13].map(uuid));
	}));

test("dates are America/Chicago days, and only rows due by today count", () =>
	withRollback(async (tx) => {
		await seed(tx);
		// 03:00 UTC is still the day before in Chicago.
		await lead(tx, 10, { created_at: "2026-01-10 03:00:00+00" }, {});
		await lead(tx, 11, { last_touch: "2026-01-01" });
		await touch(tx, "lead_id", 11, "2026-01-05 03:00:00+00");
		await touch(tx, "lead_id", 11, "2026-01-07 03:00:00+00", "memo");
		await lead(tx, 12, { last_touch: "2026-01-20" });
		await touch(tx, "lead_id", 12, "2026-01-05 03:00:00+00");
		await vendor(tx, 13);
		await touch(tx, "vendor_id", 13, "2026-02-01 05:59:00+00");
		await sql`insert into party (id, kind, name, created_by, updated_by)
			values (${uuid(14)}, 'person', 'Example', ${uuid(1)}, ${uuid(1)}),
			(${uuid(15)}, 'person', 'Example', ${uuid(1)}, ${uuid(1)})`.execute(tx);
		await sql`insert into lead (id, party_id, registry_ref, stage, next_action_date,
			created_at, created_by, updated_by) values
			(${uuid(14)}, ${uuid(14)}, 'L-14', 'new', carr_business_date(), now(), ${uuid(1)}, ${uuid(1)}),
			(${uuid(15)}, ${uuid(15)}, 'L-15', 'new', carr_business_date() + 1, '2020-01-01', ${uuid(1)}, ${uuid(1)})`.execute(
			tx,
		);
		const quiet = await read(tx, { lead_days: 1, vendor_days: 1 });
		const today = (
			await sql<{
				d: string;
			}>`select to_char(carr_business_date(), 'YYYY-MM-DD') as d`.execute(tx)
		).rows[0]?.d;
		assert.deepEqual(
			quiet.proposals.map((p) => [
				p.subject_id,
				p.basis,
				p.anchor_on,
				p.due_on,
			]),
			[
				[uuid(11), "last_contact", "2026-01-04", "2026-01-05"],
				[uuid(10), "created_at", "2026-01-09", "2026-01-10"],
				[uuid(12), "last_contact", "2026-01-20", "2026-01-21"],
				[uuid(13), "last_contact", "2026-01-31", "2026-02-01"],
				[uuid(14), "created_at", today, today],
			],
		);
		assert.equal(quiet.proposals.at(-1)?.days_overdue, 0);
	}));

test("rows sort by due day, then kind, then id, and filter by owner", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await vendor(tx, 10, { owner: 2 });
		await lead(tx, 12, { owner: 1 });
		await lead(tx, 11);
		await lead(tx, 13, { owner: 2, created_at: "2019-01-01 12:00:00+00" });
		// The vendor falls due the same day as leads 11 and 12 and sorts after them.
		const even = { lead_days: 45, vendor_days: 45 };
		assert.deepEqual(await ids(tx, even), [13, 11, 12, 10].map(uuid));
		assert.deepEqual(await ids(tx, even, "quiet-other"), [13, 10].map(uuid));
		assert.deepEqual(await ids(tx, even, "nobody"), []);
	}));

test("more than 1000 due rows refuse the whole list", () =>
	withRollback(async (tx) => {
		await seed(tx);
		const many = (from: number, to: number) => [
			sql`insert into party (id, kind, name, created_by, updated_by)
				select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, 'person',
				'Example', ${uuid(1)}, ${uuid(1)} from generate_series(${from}::int, ${to}::int) g`,
			sql`insert into lead (party_id, stage, created_at, created_by, updated_by)
				select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, 'new',
				'2020-01-01', ${uuid(1)}, ${uuid(1)} from generate_series(${from}::int, ${to}::int) g`,
		];
		for (const statement of many(1, 1000)) await statement.execute(tx);
		assert.equal((await read(tx)).proposals.length, 1000);
		for (const statement of many(1001, 1001)) await statement.execute(tx);
		assert.deepEqual(await readQuietFollowUps(tx, DEFAULT, null), {
			error: "limit_exceeded",
		});
	}));
