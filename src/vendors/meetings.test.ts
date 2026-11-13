import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import worker from "../worker.ts";

const meetings = (search: string, connectionString: string, slug = "joe") =>
	worker.request(
		`https://app.example.test/api/engine/vendor-meetings${search}`,
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

async function run(url: string, statements: string) {
	const db = new pg.Client({ connectionString: url });
	await db.connect();
	try {
		await db.query(statements);
	} finally {
		await db.end();
	}
}

const at = (hours: number) =>
	new Date(Date.now() + hours * 3_600_000).toISOString();
const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000101";
const PAT = "00000000-0000-4000-8000-000000000102";
const SAM = "00000000-0000-4000-8000-000000000103";
const finding = (status: string) =>
	JSON.stringify({
		found: true,
		epistemic_status: status,
		location_type: "office",
		street_address: "1 Example St",
		city: "Austin",
		state: "TX",
	});
// The schema copy's check names made-up partners; the read serves joe and dell.
const SEED = `alter table board_snapshot drop constraint board_snapshot_sponsoring_human_slug_check;
	set session_replication_role = replica;
	insert into actor (id, slug, kind, display_name) values
		('${ACTOR}', 'joe', 'human', 'Example'), (gen_random_uuid(), 'claude', 'human', 'Example');
	insert into vendor_category (slug, label, sort) values ('lender', 'Example Lender', 1);
	insert into vendor_disposition (slug, label, workable, sort) values ('active', 'Active', true, 1);
	insert into party (id, kind, name, org_id, email, created_by, updated_by) values
		('${ORG}', 'org', 'Example Lending Co', null, null, '${ACTOR}', '${ACTOR}'),
		('${PAT}', 'person', 'Pat Example', '${ORG}', ' Pat@Example.TEST ', '${ACTOR}', '${ACTOR}'),
		('${SAM}', 'person', 'Sam Example', '${ORG}', 'sam@example.test', '${ACTOR}', '${ACTOR}');
	insert into vendor (vendor_ref, party_id, category, category_slug, offers, created_by, updated_by)
		values ('V-1', '${ORG}', 'lender', 'lender', 'Construction loans', '${ACTOR}', '${ACTOR}');
	insert into record_flag (subject_type, subject_id, kind, value, source, observed_at, created_by) values
		('party', '${PAT}', 'address', '${finding("source_backed")}', 'https://example.test/a', now() - interval '1 day', '${ACTOR}'),
		('party', '${SAM}', 'address', '${finding("inferred")}', 'https://example.test/b', now() - interval '1 day', '${ACTOR}');`;
const SNAPSHOT = JSON.stringify({
	schema: "carr-calendar-agenda.v1",
	observed_at: at(-1),
	items: ["pat@example.test", "nobody@example.test"].map((email, i) => ({
		start: at(2 + i),
		end: at(3 + i),
		title: `Example ${i}`,
		attendees: [{ email }],
	})),
});
const withMeeting = `insert into board_snapshot (organization_tenant_id, sponsoring_human_slug,
	board_id, snapshot_json, updated_by_actor_id)
	values ('carr-internal', 'joe', 'calendar-agenda', '${SNAPSHOT}', '${ACTOR}')`;

type Answer = {
	total: number;
	has_more: boolean;
	next_cursor: string | null;
	items: {
		contact: { name: string };
		missing: string[];
		possible_meetings: { title: string }[];
	}[];
	calendar: { state: string; scheduling: { state: string; reason?: string } };
};
const ready = async (response: Response) => {
	assert.equal(response.status, 200);
	return (await response.json()) as Answer;
};
const people = (answer: Answer) =>
	answer.items.map((item) => [
		item.contact.name,
		item.missing,
		item.possible_meetings.map((m) => m.title),
	]);

test("suggested people come with the partner's meetings their email attends", () =>
	withSnapshot(async (url) => {
		await run(url, SEED);
		const unplanned = await ready(
			await meetings("?view=research&q=AUSTIN", url),
		);
		assert.deepEqual(people(unplanned), [
			["Sam Example", ["verified_office"], []],
		]);
		assert.equal(unplanned.calendar.scheduling.reason, "source_unavailable");

		await run(url, withMeeting);
		const suggested = await ready(await meetings("", url));
		assert.deepEqual(people(suggested), [["Pat Example", [], ["Example 0"]]]);
		assert.equal(suggested.calendar.state, "ready");
		assert.equal(suggested.calendar.scheduling.state, "ready");
	}));

test("pages follow their cursor", () =>
	withSnapshot(async (url) => {
		await run(
			url,
			`${SEED};
			update record_flag set value = value || '{"epistemic_status": "source_backed"}'`,
		);
		const first = await ready(await meetings("?limit=1", url));
		assert.equal(first.has_more, true);
		const cursor = encodeURIComponent(first.next_cursor ?? "");
		const second = await ready(
			await meetings(`?limit=1&cursor=${cursor}`, url),
		);
		assert.deepEqual(
			people(first)
				.concat(people(second))
				.map(([name]) => name),
			["Pat Example", "Sam Example"],
		);
	}));

async function refused(response: Response, status: number, error: string) {
	assert.equal(response.status, status);
	const { correlation_id, hint, ...body } = (await response.json()) as Record<
		string,
		unknown
	>;
	assert.equal(typeof correlation_id, "string");
	assert.equal(typeof hint, "string");
	assert.deepEqual(body, { error });
}

test("the read refuses a caller who is not a partner, a bad query and a failed read", () =>
	withSnapshot(async (url) => {
		await run(url, SEED);
		await refused(
			await meetings("?q=x", url, "claude"),
			403,
			"AUTHORIZATION_REFUSED",
		);
		for (const search of [
			`?q=${"x".repeat(81)}`,
			"?q=a&q=b",
			"?limit=0",
			"?limit=51",
			"?limit=1.5",
			"?cursor=",
			"?cursor=!!!",
			`?cursor=${btoa("null")}`,
			`?view=research&cursor=${btoa(encodeURIComponent(JSON.stringify({ v: 1, view: "suggested", q: "", after: [ORG, PAT] })))}`,
		])
			await refused(
				await meetings(search, url),
				400,
				"vendor_meetings_query_invalid",
			);
		await run(url, "alter view v_vendor_assignment_context rename to v_hidden");
		await refused(await meetings("", url), 500, "vendor_meetings_unavailable");
	}));
