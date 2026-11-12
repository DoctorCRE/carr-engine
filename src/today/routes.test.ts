import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import worker from "../worker.ts";

const signedIn = {
	fetch: async () =>
		Response.json({
			actor: { slug: "joe", display: "Example Partner" },
			csrf_token: "made-up-csrf",
		}),
};
const triage = (search: string, connectionString: string) =>
	worker.request(
		`https://app.example.test/api/engine/today-triage${search}`,
		{ headers: { Cookie: "__Host-dealroom_session=made-up-session" } },
		{ CARR: signedIn, DATABASE: { connectionString } },
	);
const cursor = (fields: Record<string, unknown>) =>
	encodeURIComponent(
		btoa(
			JSON.stringify({
				v: 2,
				owners: "all",
				on: "2026-01-05",
				rank: 2,
				due_on: null,
				item_kind: "ingest",
				id: "00000000-0000-4000-8000-000000000001",
				...fields,
			}),
		),
	);

test("bad input is refused before any read, a bad page or cursor generically", async () => {
	const refused = async (search: string) => {
		const response = await triage(
			search,
			"postgres://made-up@127.0.0.1:1/none",
		);
		const { correlation_id: _, ...body } = (await response.json()) as {
			correlation_id: string;
		};
		return [response.status, body];
	};
	assert.deepEqual(await refused("?owners=mine"), [
		400,
		{
			error: "value_not_in_declared_vocabulary",
			hint: "Use a value from the field's documented vocabulary.",
			allowed_values: ["all", "partners"],
			fields: ["owners"],
		},
	]);
	assert.deepEqual(await refused("?page=2"), [
		400,
		{
			error: "unregistered_operation_fields",
			hint: "Remove fields outside the documented input.",
			fields: ["page"],
		},
	]);
	assert.deepEqual(await refused("?limit=x"), [
		400,
		{
			error: "invalid_number",
			hint: "Supply a numeric value for the named fields.",
			fields: ["limit"],
		},
	]);
	const generic = [
		422,
		{
			error: "unhandled_verb_failure",
			hint: "The operation failed. Quote the correlation_id when reporting it.",
		},
	];
	for (const search of [
		"?limit=0",
		"?limit=51",
		"?limit=2.5",
		"?cursor=",
		"?cursor=%25%25",
		`?cursor=${cursor({ pad: "x".repeat(650) })}`,
		`?cursor=${btoa("[]")}`,
		`?cursor=${cursor({ v: 1 })}`,
		`?owners=partners&cursor=${cursor({})}`,
		`?cursor=${cursor({ on: "2026-02-30" })}`,
		`?cursor=${cursor({ on: "0000-12-31" })}`,
		`?cursor=${cursor({ rank: 3 })}`,
		`?cursor=${cursor({ due_on: "2026-1-5" })}`,
		`?cursor=${cursor({ item_kind: "loop" })}`,
		`?cursor=${cursor({ id: "not-a-uuid" })}`,
		`?cursor=${cursor({})}&cursor=${cursor({})}`,
	])
		assert.deepEqual(await refused(search), generic, search);
});

const ids = {
	partnerAction: "10000000-0000-4000-8000-000000000001",
	machineAction: "10000000-0000-4000-8000-000000000002",
	postCall: "10000000-0000-4000-8000-000000000003",
	soonDate: "10000000-0000-4000-8000-000000000004",
	laterDate: "10000000-0000-4000-8000-000000000005",
	passedDate: "10000000-0000-4000-8000-000000000006",
	inbox: "10000000-0000-4000-8000-000000000007",
};

test("due actions lead, then near critical dates, then the rest, a page at a time", () =>
	withSnapshot(async (url) => {
		const db = new pg.Client({ connectionString: url });
		await db.connect();
		try {
			// The capture rows behind a post-call action are not what this tests.
			await db.query(`set session_replication_role = replica;
			insert into actor (id, slug, kind, display_name) values
				('20000000-0000-4000-8000-000000000001', 'joe', 'human', 'Example'),
				('20000000-0000-4000-8000-000000000002', 'dell-local', 'automation', 'Example'),
				('20000000-0000-4000-8000-000000000003', 'example-bot', 'automation', 'Example');
			insert into next_action (id, subject_type, subject_id, owner_id, due_on, description, created_by) values
				('${ids.partnerAction}', 'deal', gen_random_uuid(), '20000000-0000-4000-8000-000000000001', current_date - 1, 'Example', '20000000-0000-4000-8000-000000000001'),
				('${ids.machineAction}', 'deal', gen_random_uuid(), '20000000-0000-4000-8000-000000000003', current_date - 3, 'Example', '20000000-0000-4000-8000-000000000001');
			insert into capture_post_call_action (id, candidate_id, deal_id, owner_id, due_on, description, accepted_by) values
				('${ids.postCall}', gen_random_uuid(), gen_random_uuid(), '20000000-0000-4000-8000-000000000002', current_date - 2, 'Example', '20000000-0000-4000-8000-000000000001');
			insert into critical_date (id, deal_id, kind, due_on, source, created_by) values
				('${ids.laterDate}', gen_random_uuid(), 'notice', current_date + 9, 'manual', '20000000-0000-4000-8000-000000000001'),
				('${ids.soonDate}', gen_random_uuid(), 'option', current_date + 2, 'manual', '20000000-0000-4000-8000-000000000001'),
				('${ids.passedDate}', gen_random_uuid(), 'renewal', current_date - 4, 'manual', '20000000-0000-4000-8000-000000000001');
			insert into ingest_inbox (id, received_at, source, payload) values
				('${ids.inbox}', now() - interval '2 days', 'email', '{}');`);
		} finally {
			await db.end();
		}
		type Page = {
			items: Record<string, unknown>[];
			total: number;
			has_more: boolean;
			next_cursor: string | null;
		};
		const read = async (search: string) => {
			const response = await triage(search, url);
			assert.equal(response.status, 200, search);
			return (await response.json()) as Page;
		};
		const all = await read("");
		assert.deepEqual(
			all.items.map((item) => item.id),
			[
				ids.partnerAction,
				ids.postCall,
				ids.machineAction,
				ids.soonDate,
				ids.laterDate,
				ids.inbox,
				ids.passedDate,
			],
		);
		assert.deepEqual(Object.keys(all.items[0] ?? {}), [
			"item_kind",
			"id",
			"subject_type",
			"subject_id",
			"owner",
			"what",
			"due_on",
			"subject_name",
			"subject_ref",
			"business_days_overdue",
		]);
		assert.deepEqual(
			[all.total, all.has_more, all.next_cursor],
			[7, false, null],
		);

		const pages: Page[] = [];
		const partners = "?owners=partners&limit=2";
		for (let next: string | null = ""; next !== null; ) {
			const page = await read(
				next ? `${partners}&cursor=${encodeURIComponent(next)}` : partners,
			);
			pages.push(page);
			next = page.next_cursor;
		}
		assert.deepEqual(
			pages.map((page) => [
				page.items.map((item) => item.id),
				page.total,
				page.has_more,
			]),
			[
				[[ids.partnerAction, ids.postCall], 6, true],
				[[ids.soonDate, ids.laterDate], 6, true],
				[[ids.inbox, ids.passedDate], 6, false],
			],
		);
		const partnersCursor = encodeURIComponent(pages[0]?.next_cursor ?? "");
		assert.equal((await triage(`?cursor=${partnersCursor}`, url)).status, 422);
	}));
