import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import worker from "../worker.ts";

const signedIn = {
	fetch: async () =>
		Response.json({
			actor: { slug: "leads-route-partner", display: "Example Partner" },
			csrf_token: "made-up-csrf",
		}),
};
const request = (path: string) => (search: string, connectionString: string) =>
	worker.request(
		`https://app.example.test/api/engine/${path}${search}`,
		{ headers: { Cookie: "__Host-dealroom_session=made-up-session" } },
		{ CARR: signedIn, DATABASE: { connectionString } },
	);
const board = request("leads");
const quiet = request("quiet-follow-ups");
const territory = request("territory-state-board");

async function refusal(response: Response) {
	const { correlation_id, ...body } = (await response.json()) as {
		correlation_id: string;
	};
	assert.match(correlation_id, /^[0-9a-f-]{36}$/);
	return [response.status, body];
}

const generic = {
	error: "unhandled_verb_failure",
	hint: "The operation failed. Quote the correlation_id when reporting it.",
};

test("quiet follow-ups refuse unknown fields, then bad numbers, then a bad owner, before any read", async () => {
	const unread = "postgres://made-up@127.0.0.1:1/none";
	const refused = async (search: string) =>
		refusal(await quiet(search, unread));
	const unknown = {
		error: "unregistered_operation_fields",
		hint: "Remove fields outside the documented input.",
	};
	assert.deepEqual(await refused("?lead_days=x&b=1&a=2&a=3&%24bad=4"), [
		400,
		{ ...unknown, fields: ["a", "b"] },
	]);
	const number = (field: string) => [
		400,
		{
			error: "invalid_number",
			hint: "Supply a numeric value for the named fields.",
			fields: [field],
		},
	];
	assert.deepEqual(
		await refused("?vendor_days=x&lead_days=x"),
		number("lead_days"),
	);
	assert.deepEqual(await refused("?lead_days="), number("lead_days"));
	assert.deepEqual(await refused("?lead_days=Infinity"), number("lead_days"));
	assert.deepEqual(await refused("?vendor_days=%20"), number("vendor_days"));
	assert.deepEqual(await refused("?vendor_days=1&owner_slug=%20"), [
		422,
		generic,
	]);
	assert.deepEqual(await refused(`?owner_slug=${"a".repeat(101)}`), [
		422,
		generic,
	]);
});

test("quiet follow-ups answer with the old cadence, date text and refusals", () =>
	withSnapshot(async (url) => {
		const db = new pg.Client({ connectionString: url });
		await db.connect();
		const leads = (from: number, to: number) =>
			db.query(
				`with g as (select ('00000000-0000-4000-9000-' || lpad(n::text, 12, '0'))::uuid as id
					from generate_series($1::int, $2::int) n),
				p as (insert into party (id, kind, name, created_by, updated_by)
					select g.id, 'person', 'Example', a.id, a.id from g, actor a)
				insert into lead (party_id, stage, next_action_date, created_by, updated_by)
				select g.id, 'new', '2026-01-05', a.id, a.id from g, actor a`,
				[from, to],
			);
		try {
			await db.query(`insert into actor (slug, kind, display_name)
				values ('leads-route-partner', 'human', 'Example');
				insert into contact_state (slug, label, contactable, sort)
				values ('active', 'Example', true, 1);
				insert into lead_stage (slug, label) values ('new', 'Example')`);
			await leads(1, 1);
			const answered = async (search: string) => {
				const response = await quiet(search, url);
				assert.equal(response.status, 200);
				return (await response.json()) as {
					cadence: unknown;
					proposals: { next_action_date: string; due_on: string }[];
				};
			};
			const plain = await answered("");
			assert.deepEqual(plain.cadence, { lead_days: 45, vendor_days: 90 });
			assert.deepEqual(
				plain.proposals.map((p) => [p.next_action_date, p.due_on]),
				[["2026-01-05", "2026-01-05"]],
			);
			// The old system checked neither whole numbers nor the 1 to 365 range.
			assert.deepEqual(
				(await answered("?lead_days=%2030%20&vendor_days=0&owner_slug=nobody"))
					.cadence,
				{ lead_days: 30, vendor_days: 0 },
			);
			assert.deepEqual(await refusal(await quiet("?lead_days=2.5", url)), [
				400,
				{
					error: "database_refused_the_statement",
					hint: "The operation could not be completed. Quote the correlation_id when reporting it.",
				},
			]);
			assert.deepEqual(
				await refusal(await quiet("?lead_days=99999999999", url)),
				[500, { ...generic, verb: "quiet-follow-ups" }],
			);
			await leads(2, 1001);
			assert.deepEqual(await refusal(await quiet("", url)), [422, generic]);
		} finally {
			await db.end();
		}
	}));

test("the board refuses a bad workspace, then unknown fields, then a malformed or leadless cursor, before any read", async () => {
	const unread = "postgres://made-up@127.0.0.1:1/none";
	const refused = async (search: string) =>
		refusal(await board(search, unread));
	assert.deepEqual(await refused("?workspace=deals&b=1"), [
		400,
		{
			error: "value_not_in_declared_vocabulary",
			hint: "Use a value from the field's documented vocabulary.",
			allowed_values: ["leads"],
			fields: ["workspace"],
		},
	]);
	assert.deepEqual(await refused("?workspace=leads&b=1&a=2&%24bad=3"), [
		400,
		{
			error: "unregistered_operation_fields",
			hint: "Remove fields outside the documented input.",
			fields: ["a", "b"],
		},
	]);
	assert.deepEqual(await refused("?stage_history_cursor=12"), [400, generic]);
	assert.deepEqual(await refused("?correspondence_cursor="), [400, generic]);
	const lead = "workspace=leads&lead_id=00000000-0000-4000-8000-000000000001";
	const id = "00000000-0000-4000-8000-000000000002";
	for (const cursor of [
		"not-json",
		"12",
		JSON.stringify([id, "2026-03-01T12:00:00Z"]),
		JSON.stringify({ id, occurred_at: "2026-03-01T12:00:00Z", extra: 1 }),
		JSON.stringify({ id: "not-a-uuid", occurred_at: "2026-03-01T12:00:00Z" }),
		JSON.stringify({ id, occurred_at: "2026-02-30T12:00:00Z" }),
		JSON.stringify({ id, occurred_at: "2026-03-01 12:00:00Z" }),
		JSON.stringify({ id, occurred_at: "2026-03-01T12:00:00.1234567Z" }),
	])
		assert.deepEqual(
			await refused(
				`?${lead}&correspondence_cursor=${encodeURIComponent(cursor)}`,
			),
			[400, generic],
			cursor,
		);
	for (const cursor of ["", "-1", "9223372036854775808", `{"id":"${id}"}`])
		assert.deepEqual(
			await refused(
				`?${lead}&stage_history_cursor=${encodeURIComponent(cursor)}`,
			),
			[400, generic],
			cursor,
		);
	assert.deepEqual(await refused(`?lead_id=${id}&stage_history_cursor=12`), [
		400,
		generic,
	]);
	assert.deepEqual(
		await refused("?workspace=leads&lead_id=&stage_history_cursor=12"),
		[400, generic],
	);
});

test("one lead opens with the board, pages by the returned cursor, and refuses a malformed id", () =>
	withSnapshot(async (url) => {
		const db = new pg.Client({ connectionString: url });
		await db.connect();
		try {
			const {
				rows: [seeded],
			} = await db.query<{
				id: string;
			}>(`with a as (insert into actor (slug, kind, display_name)
					values ('leads-route-partner', 'human', 'Example') returning id),
				k as (insert into contact_state (slug, label, contactable, sort)
					values ('active', 'Example', true, 1)),
				s as (insert into lead_stage (slug, label, sort) values ('new', 'New', 1)),
				c as (insert into activity_kind (slug, label, is_contact) values ('call', 'Call', true)),
				p as (insert into party (kind, name, created_by, updated_by)
					select 'org', 'Example Route Lead', id, id from a returning id, created_by),
				l as (insert into lead (party_id, stage, created_by, updated_by)
					select id, 'new', created_by, created_by from p returning id, created_by),
				x as (insert into activity (occurred_at, actor_id, kind, summary, lead_id)
					select '2026-03-01 12:00:00.5+00'::timestamptz - n * interval '1 minute',
					created_by, 'call', 'Example call', id from l, generate_series(1, 101) n)
				select id from l`);
			assert.ok(seeded);
			type Opened = {
				leads: { id: string }[];
				detail: {
					id: string;
					correspondence: { id: string }[];
					correspondence_page: { next_cursor: object | null };
				} | null;
			};
			const open = async (search: string) => {
				const response = await board(`?workspace=leads${search}`, url);
				assert.equal(response.status, 200);
				return (await response.json()) as Opened;
			};
			const first = await open(`&lead_id=${seeded.id.toUpperCase()}`);
			assert.equal(first.detail?.id, seeded.id);
			assert.equal(first.detail?.correspondence.length, 100);
			const cursor = first.detail?.correspondence_page.next_cursor;
			assert.deepEqual(cursor, {
				occurred_at: "2026-03-01T10:20:00.5+00:00",
				id: first.detail?.correspondence.at(-1)?.id,
			});
			const last = await open(
				`&lead_id=${seeded.id}&correspondence_cursor=${encodeURIComponent(JSON.stringify(cursor))}`,
			);
			assert.deepEqual(
				[
					last.detail?.correspondence.length,
					last.detail?.correspondence_page.next_cursor,
				],
				[1, null],
			);
			const unknown = await open(
				"&lead_id=00000000-0000-4000-8000-000000000099",
			);
			assert.deepEqual(
				[unknown.leads.map((l) => l.id), unknown.detail],
				[[seeded.id], null],
			);
			assert.equal("detail" in (await open("&lead_id=")), false);
			assert.deepEqual(
				await refusal(
					await board(`?workspace=leads&lead_id=${"x".repeat(36)}`, url),
				),
				[
					400,
					{
						error: "database_refused_the_statement",
						hint: "The operation could not be completed. Quote the correlation_id when reporting it.",
					},
				],
			);
		} finally {
			await db.end();
		}
	}));

test("a lead that is suppressed, or whose party is merged or deleted, opens as null", () =>
	withSnapshot(async (url) => {
		const db = new pg.Client({ connectionString: url });
		await db.connect();
		try {
			const { rows } = await db.query<{
				id: string;
				name: string;
			}>(`with a as (insert into actor (slug, kind, display_name)
					values ('leads-route-partner', 'human', 'Example') returning id),
				k as (insert into contact_state (slug, label, contactable, sort)
					values ('active', 'Example', true, 1)),
				s as (insert into lead_stage (slug, label, sort) values ('new', 'New', 1)),
				p as (insert into party (kind, name, created_by, updated_by)
					select 'org', n, id, id from a,
					unnest(array['live', 'suppressed', 'merged', 'deleted']) n
					returning id, name, created_by),
				l as (insert into lead (party_id, stage, suppressed, created_by, updated_by)
					select id, 'new', name = 'suppressed', created_by, created_by from p
					returning id, party_id)
				select l.id, p.name from l join p on p.id = l.party_id`);
			const lead = Object.fromEntries(rows.map((r) => [r.name, r.id]));
			await db.query(`update party set merged_into = (select id from party
				where name = 'live') where name = 'merged'`);
			await db.query(
				"update party set deleted_at = now() where name = 'deleted'",
			);
			for (const off of ["suppressed", "merged", "deleted"]) {
				const response = await board(`?lead_id=${lead[off]}`, url);
				const opened = (await response.json()) as {
					leads: { id: string }[];
					detail: unknown;
				};
				assert.deepEqual(
					[response.status, opened.leads.map((l) => l.id), opened.detail],
					[200, [lead.live], null],
					off,
				);
			}
		} finally {
			await db.end();
		}
	}));

test("the board answers, and refuses whole on bad timing or past the finding limit", () =>
	withSnapshot(async (url) => {
		const db = new pg.Client({ connectionString: url });
		await db.connect();
		const seed = `with a as (insert into actor (slug, kind, display_name)
				values ('leads-route-partner', 'human', 'Example') returning id),
			k as (insert into contact_state (slug, label, contactable, sort)
				values ('active', 'Example', true, 1)),
			s as (insert into lead_stage (slug, label, sort) values ('new', 'New', 1)),
			p as (insert into party (kind, name, npi, created_by, updated_by)
				select 'org', 'Example Route Lead', '1000000001', id, id from a
				returning id, created_by)
			insert into lead (party_id, stage, created_by, updated_by)
			select id, 'new', created_by, created_by from p`;
		const badTiming = `with f as (insert into practice_origination_feed (source, status)
				values ('pecos', 'available'))
			insert into practice_origination_event (source, record_key, fingerprint, npi, name,
				city, state, kind, evidence_date, date_basis, source_url, facts, published_on,
				recorded_by)
			select 'pecos', 'R-1', repeat('a', 64), '1000000001', 'Example', 'Springfield', 'AL',
				'pecos_observation', '2025-06-01', 'enumeration', 'https://registry.example',
				'{}', '2025-07-01', id from actor`;
		const flood = `insert into record_flag (subject_type, subject_id, kind, value, source, created_by)
			select 'party', party_id, 'note', '{}', 'Example', created_by
			from lead, generate_series(1, 501)`;
		try {
			await db.query(seed);
			const response = await board("?workspace=leads", url);
			assert.equal(response.status, 200);
			const answered = (await response.json()) as {
				leads: { name: string; reachability: { classification: string } }[];
			};
			assert.deepEqual(
				answered.leads.map((l) => [l.name, l.reachability.classification]),
				[["Example Route Lead", "research"]],
			);
			await db.query(badTiming);
			assert.deepEqual(await refusal(await board("", url)), [422, generic]);
			await db.query("delete from practice_origination_event");
			await db.query(flood);
			assert.deepEqual(await refusal(await board("", url)), [422, generic]);
		} finally {
			await db.end();
		}
	}));

test("territory refuses unknown fields before any read", async () => {
	const unread = "postgres://made-up@127.0.0.1:1/none";
	const unknown = {
		error: "unregistered_operation_fields",
		hint: "Remove fields outside the documented input.",
	};
	assert.deepEqual(
		await refusal(await territory("?city=A&b=1&a=2&a=3&%24bad=4", unread)),
		[400, { ...unknown, fields: ["a", "b"] }],
	);
	assert.deepEqual(await refusal(await territory("?%24bad=1", unread)), [
		400,
		{ ...unknown, fields: [] },
	]);
});

test("territory filters as the old system did and refuses past 1000 markets", () =>
	withSnapshot(async (url) => {
		const db = new pg.Client({ connectionString: url });
		await db.connect();
		const places = (count: number) =>
			db.query(
				`insert into party (kind, name, city, state, specialty, created_by, updated_by)
				select 'person', 'Example Person', 'City ' || i, 'ZZ', 'Dental', id, id
				from actor, generate_series(1, $1::int) i`,
				[count],
			);
		const markets = async (search: string) => {
			const response = await territory(search, url);
			assert.equal(response.status, 200);
			const answered = (await response.json()) as {
				submarkets: { city: string }[];
			};
			return answered.submarkets.map((m) => m.city);
		};
		try {
			await db.query(`insert into actor (slug, kind, display_name)
				values ('leads-route-partner', 'human', 'Example');
				insert into contact_state (slug, label, contactable, sort)
				values ('active', 'Example', true, 1)`);
			await places(2);
			assert.deepEqual(await markets(""), ["City 1", "City 2"]);
			assert.deepEqual(await markets("?city=&state=&vertical="), [
				"City 1",
				"City 2",
			]);
			assert.deepEqual(await markets("?city=City%202&state=ZZ"), ["City 2"]);
			assert.deepEqual(await markets("?vertical=Dental"), ["City 1", "City 2"]);
			// The declared state pattern and lengths were never checked.
			assert.deepEqual(await markets("?state=zz"), []);
			assert.deepEqual(await markets(`?city=${"x".repeat(201)}`), []);
			await db.query("delete from party");
			await places(1001);
			assert.deepEqual(await refusal(await territory("", url)), [422, generic]);
		} finally {
			await db.end();
		}
	}));
