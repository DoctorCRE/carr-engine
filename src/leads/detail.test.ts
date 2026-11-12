import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "kysely";
import type { Reader } from "../reader.ts";
import { withRollback } from "../test-rollback.ts";
import { type HistoryCursors, readLeadDetail } from "./detail.ts";

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const first: HistoryCursors = { correspondence: null, stageHistory: null };

// Every seeded name, phone and address is made up.
async function seed(tx: Reader) {
	for (const statement of [
		sql`insert into actor (id, slug, kind, display_name)
			values (${uuid(1)}::uuid, 'detail-partner', 'human', 'Example')`,
		sql`insert into contact_state (slug, label, contactable, sort)
			values ('active', 'Example', true, 1) on conflict do nothing`,
		sql`insert into lead_stage (slug, label, sort) values ('new', 'New', 1)
			on conflict do nothing`,
		sql`insert into activity_kind (slug, label, is_contact)
			values ('call', 'Call', true) on conflict do nothing`,
	])
		await statement.execute(tx);
	for (const n of [2, 3]) {
		await sql`insert into party (id, kind, name, phone, email, created_by, updated_by)
			values (${uuid(n)}::uuid, 'org', ${`Example Practice ${n}`}, '555-0100',
			'office@example.test', ${uuid(1)}::uuid, ${uuid(1)}::uuid)`.execute(tx);
		await sql`insert into lead (id, party_id, stage, notes, created_by, updated_by)
			values (${uuid(n + 10)}::uuid, ${uuid(n)}::uuid, 'new', 'Example note',
			${uuid(1)}::uuid, ${uuid(1)}::uuid)`.execute(tx);
	}
}

// Pairs of calls share a time, so the id breaks the tie.
const calls = (tx: Reader, lead: number, count: number) =>
	sql`insert into activity (id, occurred_at, actor_id, kind, summary, lead_id, source, connected)
		select ('00000000-0000-4000-9000-' || lpad((${lead * 1000} + n)::text, 12, '0'))::uuid,
		'2026-03-01 12:00:00.123456+00'::timestamptz + (n / 2) * interval '1 second',
		${uuid(1)}::uuid, 'call', 'Example call', ${uuid(lead)}::uuid, 'stated', true
		from generate_series(1, ${count}::int) n`.execute(tx);
const stageChanges = (tx: Reader, lead: number, count: number) =>
	sql`insert into event (occurred_at, actor_id, verb, subject_type, subject_id,
		old_value, new_value, cause, agent_rationale, idempotency_key)
		select '2026-02-03 14:05:06.5+00', ${uuid(1)}::uuid, 'update-lead', 'lead',
		${uuid(lead)}::uuid, '{"stage":"new"}', '{"stage":"new"}', 'human_stated',
		'Example reason', 'example-key-' || n from generate_series(1, ${count}::int) n`.execute(
		tx,
	);

async function opened(tx: Reader, lead: string, cursors = first) {
	const answer = await readLeadDetail(tx, lead, cursors);
	assert.ok("detail" in answer);
	return answer;
}

test("an opened lead merges the board row and detail in jsonb key order", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await calls(tx, 12, 1);
		await stageChanges(tx, 12, 1);
		const answer = await opened(tx, uuid(12).toUpperCase());
		const lead = answer.leads.find((l) => l.id === uuid(12));
		const { detail } = answer;
		assert.ok(lead && detail);
		const keys = Object.keys(detail);
		assert.deepEqual(keys.slice(-4), [
			"handling_advice",
			"strategy",
			"reachability",
			"research",
		]);
		const merged = keys.slice(0, -4);
		const printed = await sql<{ keys: string[] }>`select array(
			select jsonb_object_keys(${JSON.stringify(Object.fromEntries(merged.map((k) => [k, 0])))}::jsonb)
		) as keys`.execute(tx);
		assert.deepEqual(merged, printed.rows[0]?.keys);
		const {
			phone,
			email,
			notes,
			correspondence_coverage,
			history_limit,
			correspondence,
			stage_history,
			correspondence_page,
			stage_history_page,
			research,
			...row
		} = detail;
		assert.deepEqual(row, lead);
		assert.deepEqual(
			[phone, email, notes, correspondence_coverage, history_limit],
			[
				"555-0100",
				"office@example.test",
				"Example note",
				"captured_entries_only",
				100,
			],
		);
		assert.deepEqual(
			[correspondence_page, stage_history_page],
			[
				{ total: 1, has_more: false, next_cursor: null },
				{ total: 1, has_more: false, next_cursor: null },
			],
		);
		assert.equal(
			JSON.stringify(correspondence),
			`[{"id":"00000000-0000-4000-9000-000000012001","kind":"call","detail":null,"source":"stated","summary":"Example call","connected":true,"occurred_at":"2026-03-01T12:00:00.123456+00:00"}]`,
		);
		const [change] = stage_history;
		assert.ok(change);
		assert.deepEqual(Object.keys(change), [
			"cause",
			"stage",
			"reason",
			"actor_id",
			"event_id",
			"automatic",
			"actor_slug",
			"occurred_at",
			"prior_stage",
			"stage_review",
			"after_version",
			"before_version",
			"mutation_order",
			"idempotency_key",
		]);
		assert.match(change.mutation_order, /^\d+$/);
		assert.equal(change.occurred_at, "2026-02-03T14:05:06.5+00:00");
		assert.deepEqual(research, {
			state: "needs_research",
			evidence: [],
			coverage: "recorded_findings_only",
			external_search_performed: false,
			next_step:
				"Check practice website, professional registry and public filings; record sourced findings with record-finding, including nothing found.",
		});
	}));

test("history pages walk 100 at a time to a null cursor", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await calls(tx, 12, 201);
		await stageChanges(tx, 12, 201);
		await calls(tx, 13, 3);
		let cursors = first;
		const pages = [];
		for (let page = 0; page < 3; page++) {
			const { detail } = await opened(tx, uuid(12), cursors);
			assert.ok(detail);
			pages.push([
				detail.correspondence.length,
				detail.correspondence_page,
				detail.stage_history.length,
				detail.stage_history_page.has_more,
			]);
			const oldest = detail.correspondence.at(-1);
			const next = detail.correspondence_page.next_cursor;
			if (next)
				assert.deepEqual(next, {
					occurred_at: oldest?.occurred_at,
					id: oldest?.id,
				});
			cursors = {
				correspondence: next,
				stageHistory: detail.stage_history_page.next_cursor,
			};
		}
		const cursor = (n: number, at: string) => ({
			occurred_at: `2026-03-01T12:${at}.123456+00:00`,
			id: `00000000-0000-4000-9000-${String(12000 + n).padStart(12, "0")}`,
		});
		const page = (next: object | null) => ({
			total: 201,
			has_more: next !== null,
			next_cursor: next,
		});
		assert.deepEqual(pages, [
			[100, page(cursor(102, "00:51")), 100, true],
			[100, page(cursor(2, "00:01")), 100, true],
			[1, page(null), 1, false],
		]);
		assert.deepEqual(cursors, { correspondence: null, stageHistory: null });
		// Another lead's cursor is only a position, as it was in the old read.
		const { detail } = await opened(tx, uuid(13), {
			correspondence: cursor(102, "00:51"),
			stageHistory: "1",
		});
		assert.deepEqual(
			[detail?.correspondence.length, detail?.correspondence_page.total],
			[3, 3],
		);
	}));

test("a lead off the board opens as null, and the board still answers", () =>
	withRollback(async (tx) => {
		await seed(tx);
		const answer = await opened(tx, uuid(99));
		assert.equal(answer.detail, null);
		assert.equal(answer.leads.length, 2);
	}));
