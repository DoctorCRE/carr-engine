import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import worker from "../worker.ts";
import type { readMeetingPrep } from "./meeting-prep.ts";

type Prepared = Extract<
	Awaited<ReturnType<typeof readMeetingPrep>>,
	{ match_basis: string }
>;

const prep = (slug: string, search: string, connectionString: string) =>
	worker.request(
		`https://app.example.test/api/engine/calendar-meeting-prep${search}`,
		{ headers: { Cookie: "__Host-dealroom_session=made-up-session" } },
		{
			CARR: {
				fetch: async () =>
					Response.json({
						actor: { slug, display: "Example Partner" },
						csrf_token: "made-up-csrf",
					}),
			},
			DATABASE: { connectionString },
		},
	);

test("any field is refused before the read, a caller's authority field first", async () => {
	const refused = async (search: string) => {
		const response = await prep(
			"partner_one",
			search,
			"postgres://made-up@127.0.0.1:1/none",
		);
		const { correlation_id: _, ...body } = (await response.json()) as {
			correlation_id: string;
		};
		return [response.status, body];
	};
	assert.deepEqual(await refused("?date=today&sponsor=partner_two"), [
		403,
		{
			error: "caller_authority_field_forbidden",
			hint: "Remove caller-supplied authority fields.",
			fields: ["sponsor"],
		},
	]);
	assert.deepEqual(await refused("?date=today"), [
		400,
		{
			error: "unregistered_operation_fields",
			hint: "Remove fields outside the documented input.",
			fields: ["date"],
		},
	]);
});

const at = (hours: number) =>
	new Date(Date.now() + hours * 3_600_000).toISOString();
const open = "50000000-0000-4000-8000-000000000001";
const closing = "50000000-0000-4000-8000-000000000002";

// The trigger rows behind a deal are not what this tests. Client C-2 has
// 1,001 open deals.
const seed = `set session_replication_role = replica;
	insert into actor (slug, kind, display_name) values
		('partner_one', 'human', 'Example'), ('partner_two', 'human', 'Example');
	insert into deal_phase (slug, label) values ('example-open', 'Example Open');
	with p as (insert into party (kind, name, email, created_by, updated_by)
		select 'org', 'Example Clinic ' || e.email, e.email, a.id, a.id
		from unnest(array[' Client@Example.TEST ', 'many@example.test']) e(email), actor a
		where a.slug = 'partner_one' returning id, email, created_by)
	insert into client (party_id, roster_ref, created_by, updated_by)
		select id, case when email like 'many%' then 'C-2' else 'C-1' end, created_by, created_by
		from p;
	with d as (insert into deal (id, client_id, name, deal_type, phase, owner, outcome,
			closed_on, next_date, created_by, updated_by)
		select v.id, c.id, v.name, 'lease', 'example-open', v.owner, v.outcome,
			v.closed_on::date, v.next_date::date, a.id, a.id
		from (values ('${open}'::uuid, 'Example Open', 'partner_one', null, null, '2030-01-15', 'C-1'),
			('${closing}', 'Example Closing', 'partner_one', null, '2026-01-02', null, 'C-1'),
			(gen_random_uuid(), 'Example Won', 'partner_one', 'won', null, null, 'C-1'),
			(gen_random_uuid(), 'Example Other', 'partner_two', null, null, null, 'C-1'))
			v(id, name, owner, outcome, closed_on, next_date, ref)
		join actor a on a.slug = v.owner join client c on c.roster_ref = v.ref
		union all
		select gen_random_uuid(), c.id, 'Example ' || n, 'lease', 'example-open',
			'partner_one', null, null, null, a.id, a.id
		from generate_series(1, 1001) n, client c, actor a
		where c.roster_ref = 'C-2' and a.slug = 'partner_one'
		returning id, created_by)
	insert into deal_participant (deal_id, actor_id, role, set_by)
		select id, created_by, 'lead', created_by from d`;
const snapshot = {
	schema: "carr-calendar-agenda.v1",
	observed_at: at(-1),
	items: ["client@example.test", null, "many@example.test"].map((email, i) => ({
		start: at(2 + i),
		end: at(3 + i),
		title: `Example meeting ${i}`,
		attendees: email ? [{ name: "Example", email }] : [],
	})),
};

test("attendee emails suggest the partner's first thousand open deals with their preparation", () =>
	withSnapshot(async (url) => {
		const db = new pg.Client({ connectionString: url });
		await db.connect();
		try {
			await db.query(seed);
			await db.query(
				`insert into board_snapshot (organization_tenant_id, sponsoring_human_slug,
					board_id, snapshot_json, updated_by_actor_id)
				select 'carr-internal', 'partner_one', 'calendar-agenda', $1, id
				from actor where slug = 'partner_one'`,
				[snapshot],
			);
		} finally {
			await db.end();
		}
		const response = await prep("partner_one", "", url);
		const body = (await response.json()) as Prepared;
		assert.deepEqual(
			[response.status, body.state, body.notes, body.sources],
			[
				200,
				"partial",
				[
					"Some possible meeting deals were omitted. Search the record for more.",
					"Preparation is unavailable for some possible deals. Check the deal record.",
				],
				{
					outlook_calendar: { state: "ready" },
					deal_suggestions: { state: "partial" },
					meeting_prep: { state: "partial" },
				},
			],
		);
		const [client, none, many] = body.items.map((item) => item.possible_deals);
		assert.deepEqual(client, [
			{
				id: open,
				name: "Example Open",
				client_ref: "C-1",
				prep: {
					state: "ready",
					phase: "example-open",
					next_step: null,
					next_date: "2030-01-15",
					last_touch: null,
					market: null,
				},
			},
			{
				id: closing,
				name: "Example Closing",
				client_ref: "C-1",
				prep: { state: "unavailable" },
			},
		]);
		assert.deepEqual(
			[none, many?.length, Object.keys(body).at(-1), body.match_basis],
			[[], 998, "match_basis", "attendee_email_possible_match"],
		);
		assert.equal(
			await (await prep("partner_two", "", url)).text(),
			'{"state":"unavailable","reason":"source_unavailable","items":[]}',
		);
	}));
