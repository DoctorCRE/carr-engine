import assert from "node:assert/strict";
import { test } from "node:test";
import { type Kysely, sql } from "kysely";
import type { DB } from "../database.d.ts";
import type { Reader } from "../reader.ts";
import { withRollback } from "../test-rollback.ts";
import { readRecentActivity } from "./read.ts";

// Every seeded name is made up.
async function seed(tx: Kysely<DB>) {
	for (const statement of [
		sql`insert into actor (id, slug, kind, display_name) values
			(${uuid(900)}, 'activity-partner', 'human', 'Example'),
			(${uuid(901)}, 'activity-other', 'human', 'Example')`,
		sql`insert into contact_state (slug, label, contactable, sort) values ('active', 'Example', true, 1) on conflict do nothing`,
		sql`insert into lead_stage (slug, label) values ('activity-new', 'Example')`,
		sql`insert into vendor_disposition (slug, label, workable, sort) values ('active', 'Example', true, 1) on conflict do nothing`,
		sql`insert into deal_type_ref (slug, label, sort) values ('activity-lease', 'Example', 1)`,
		sql`insert into deal_phase (slug, label) values ('activity-open', 'Example')`,
		sql`insert into activity_kind (slug, label, is_contact) values ('activity-call', 'Example', true)`,
	])
		await statement.execute(tx);
}

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const party = (
	tx: Kysely<DB>,
	n: number,
	kind: "person" | "org",
	name: string,
	extra: { ref?: string; email?: string; merged_into?: number } = {},
) =>
	sql`insert into party (id, kind, name, ref, email, merged_into, created_by, updated_by)
		values (${uuid(n)}, ${kind}, ${name}, ${extra.ref ?? `P-${n}`}, ${extra.email ?? null},
		${extra.merged_into ? uuid(extra.merged_into) : null}, ${uuid(900)}, ${uuid(900)})`.execute(
		tx,
	);
const lead = (tx: Kysely<DB>, n: number, ref: string) =>
	sql`insert into lead (id, party_id, registry_ref, stage, created_by, updated_by)
		values (${uuid(n)}, ${uuid(n)}, ${ref}, 'activity-new', ${uuid(900)}, ${uuid(900)})`.execute(
		tx,
	);
const client = (tx: Kysely<DB>, n: number, ref: string) =>
	sql`insert into client (id, party_id, roster_ref, created_by, updated_by)
		values (${uuid(n)}, ${uuid(n)}, ${ref}, ${uuid(900)}, ${uuid(900)})`.execute(
		tx,
	);
const deal = (tx: Kysely<DB>, n: number, client: number, name: string) =>
	sql`insert into deal (id, client_id, name, deal_type, phase, created_by, updated_by)
		values (${uuid(n)}, ${uuid(client)}, ${name}, 'activity-lease', 'activity-open',
		${uuid(900)}, ${uuid(900)})`.execute(tx);
const activity = (tx: Kysely<DB>, n: number, lead: number, at: string) =>
	sql`insert into activity (id, occurred_at, actor_id, kind, summary, owed, lead_id)
		values (${uuid(n)}, ${at}, ${uuid(900)}, 'activity-call', ${`Example call ${n}`},
		'Example owed', ${uuid(lead)})`.execute(tx);
const captured = (
	tx: Kysely<DB>,
	key: string,
	activityN: number,
	extra: { actor?: number; verb?: string } = {},
) =>
	sql`insert into tool_call (idempotency_key, verb, actor_id, request_hash, response)
		values (${key}, ${extra.verb ?? "log-activity"}, ${uuid(extra.actor ?? 900)}, 'example',
		${JSON.stringify({ activity_id: uuid(activityN) })})`.execute(tx);

const read = async (tx: Reader, query: string, limit = 20) =>
	JSON.stringify(
		await readRecentActivity(tx, "activity-partner", query, limit),
	);

test("one match answers its timeline and this partner's calendar captures", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "person", "Quillon Ardent", {
			email: " Q.Ardent@Example.TEST ",
		});
		await lead(tx, 1, "L-1");
		await activity(tx, 102, 1, "2026-02-01 08:30:00.123999+00");
		await activity(tx, 101, 1, "2026-02-01 08:30:00.123999+00");
		await activity(tx, 103, 1, "2025-12-31 23:59:59.999999-06");
		await sql`insert into event (id, occurred_at, actor_id, verb, subject_type, subject_id,
			new_value, cause, human_quote)
			values (${uuid(201)}, '2026-03-08 07:30:00.5-06', ${uuid(901)}, 'update', 'lead',
			${uuid(1)}, '{"summary": " Example summary "}', 'human_stated', 'Example quote')`.execute(
			tx,
		);
		await captured(tx, "calcap-2", 102);
		await captured(tx, "calcap-1", 101);
		await captured(tx, "other-1", 101);
		await captured(tx, "calcap-3", 101, { actor: 901 });
		await captured(tx, "calcap-4", 101, { verb: "other-verb" });
		const row = (n: number, at: string) =>
			`{"entry_kind":"activity","occurred_at":"${at}","actor":"activity-partner","verb":"activity-call","summary":"Example call ${n}","detail":null,"owed":"Example owed"}`;
		const head = `{"state":"completed","query":"q.ardent@example.test","match":{"kind":"lead","name":"Quillon Ardent","target":"L-1"},"catch_up":{"subject":{"type":"lead","id":"${uuid(1)}"},"timeline":[{"entry_kind":"event","occurred_at":"2026-03-08T13:30:00.500Z","actor":"activity-other","verb":"update","summary":"Example summary","detail":"Example quote","owed":null}`;
		const calendar = `"calendar_history":[{"key":"calcap-1","activity_id":"${uuid(101)}","summary":"Example call 101"},{"key":"calcap-2","activity_id":"${uuid(102)}","summary":"Example call 102"}]}}`;
		assert.equal(
			await read(tx, "q.ardent@example.test"),
			`${head},${row(101, "2026-02-01T08:30:00.123Z")},${row(102, "2026-02-01T08:30:00.123Z")},${row(103, "2026-01-01T05:59:59.999Z")}],${calendar}`,
		);
		assert.equal(
			await read(tx, "q.ardent@example.test", 2),
			`${head},${row(101, "2026-02-01T08:30:00.123Z")}],${calendar}`,
		);
	}));

test("a deal, an organization's party ref and a merged survivor are the targets", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "org", "Example Client Org");
		await client(tx, 1, "C-1");
		await deal(tx, 2, 1, " Example Brindlecove Lease ");
		await party(tx, 3, "org", "Harrowgate Example");
		await party(tx, 4, "person", "Harrowgate Example Old", {
			merged_into: 3,
		});
		const match = async (query: string) =>
			JSON.parse(await read(tx, query)) as {
				match: unknown;
				catch_up: { subject: unknown };
			};
		assert.deepEqual(await match("Brindlecove Lease"), {
			state: "completed",
			query: "Brindlecove Lease",
			match: {
				kind: "deal",
				name: "Example Brindlecove Lease",
				target: "Example Brindlecove Lease",
			},
			catch_up: {
				subject: { type: "deal", id: uuid(2) },
				timeline: [],
				calendar_history: [],
			},
		});
		const org = await match("Harrowgate Example");
		assert.deepEqual(
			[org.match, org.catch_up.subject],
			[
				{ kind: "party", name: "Harrowgate Example", target: "P-3" },
				{ type: "party", id: uuid(3) },
			],
		);
	}));

test("no live match counts the retired ones", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 11, "org", "Survivor Holdings");
		await party(tx, 10, "org", "Gone Example Org", { merged_into: 11 });
		await party(tx, 12, "person", "Gone Example Person", { merged_into: 11 });
		await lead(tx, 12, "L-12");
		assert.equal(
			await read(tx, "Gone Example"),
			`{"state":"not_found","query":"Gone Example","candidates":[],"retired_matches":2,"hint":"Only retired aliases matched; search the survivor name or call catch-me-up with a known retired ref."}`,
		);
		assert.equal(
			await read(tx, "Nothing Here"),
			`{"state":"not_found","query":"Nothing Here","candidates":[],"retired_matches":0,"hint":"No live record matched this name."}`,
		);
	}));

test("several matches list each live ref once, in locale order, at most 25", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "org", "Vantor Wells");
		await client(tx, 1, "C-1");
		await party(tx, 2, "person", "Vantor Wells");
		assert.equal(
			await read(tx, "Vantor Wells"),
			`{"state":"needs_disambiguation","query":"Vantor Wells","candidate_count":2,"candidates":[{"kind":"client","name":"Vantor Wells","target":"C-1"},{"kind":"party","name":"Vantor Wells","target":"P-2"}],"candidates_truncated":false,"hint":"Choose one exact target and call catch-me-up; this verb never guesses."}`,
		);
		for (let n = 10; n < 40; n++)
			await party(tx, n, "person", "Crowd Example", {
				ref: n === 13 ? "p-13" : `P-${n}`,
			});
		const crowd = JSON.parse(await read(tx, "Crowd Example")) as {
			candidate_count: number;
			candidates: { target: string }[];
			candidates_truncated: boolean;
		};
		assert.deepEqual(
			[crowd.candidate_count, crowd.candidates_truncated],
			[30, true],
		);
		assert.deepEqual(
			crowd.candidates.map((c) => c.target),
			[
				"P-10",
				"P-11",
				"P-12",
				"p-13",
				...Array.from({ length: 21 }, (_, i) => `P-${i + 14}`),
			],
		);
	}));

test("more than 5000 calendar captures is refused", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "person", "Quillon Ardent");
		await lead(tx, 1, "L-1");
		await activity(tx, 101, 1, "2026-02-01 08:30:00+00");
		// Its per-row cleanup scan would make 5001 inserts slow.
		await sql`alter table tool_call disable trigger tool_call_expire`.execute(
			tx,
		);
		const capture = (from: number, to: number) =>
			sql`insert into tool_call (idempotency_key, verb, actor_id, request_hash, response)
				select 'calcap-' || n, 'log-activity', ${uuid(900)}, 'example',
				${JSON.stringify({ activity_id: uuid(101) })}
				from generate_series(${from}::int, ${to}::int) n`.execute(tx);
		await capture(1, 5000);
		const full = JSON.parse(await read(tx, "Quillon Ardent")) as {
			catch_up: { calendar_history: unknown[] };
		};
		assert.equal(full.catch_up.calendar_history.length, 5000);
		await capture(5001, 5001);
		assert.deepEqual(JSON.parse(await read(tx, "Quillon Ardent")), {
			error: "calendar_history_too_large",
		});
	}));
