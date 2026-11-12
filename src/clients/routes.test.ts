import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import worker from "../worker.ts";

const CORRELATION = "0b3c2a6e-1d4f-4a5b-9c8d-7e6f5a4b3c2d";
const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const unread = "postgres://made-up@127.0.0.1:1/none";

const list = (
	search: string,
	{ slug = "joe", database = unread as string | null } = {},
) =>
	worker.request(
		`https://app.example.test/api/engine/clients${search}`,
		{
			headers: {
				Cookie: "__Host-dealroom_session=made-up-session",
				"x-correlation-id": ` ${CORRELATION.toUpperCase()} `,
			},
		},
		{
			CARR: {
				fetch: async () =>
					Response.json({
						actor: { slug, display: "Example Partner" },
						csrf_token: "made-up-csrf",
					}),
			},
			...(database ? { DATABASE: { connectionString: database } } : {}),
		},
	);

async function body(response: Response) {
	const text = await response.text();
	return { status: response.status, text, json: JSON.parse(text) };
}

test("the client list refuses bad inputs with the old bodies, in the old order", async () => {
	const invalid = (detail: object) => ({ error: "QUERY_INVALID", detail });
	const cases: [string, number, object, object?][] = [
		["?b=1&scope=x", 400, invalid({ parameter: "b", reason: "unsupported" })],
		[
			"?territory=x",
			400,
			invalid({ parameter: "territory", reason: "unsupported" }),
		],
		["?viewer=dell&scope=x", 403, { error: "AUTHORIZATION_REFUSED" }],
		[
			"?contract=vendor-directory.v3",
			400,
			invalid({ parameter: "contract", reason: "unsupported_value" }),
		],
		[
			"?page=0&scope=all",
			400,
			invalid({ parameter: "scope", reason: "unsupported_value" }),
		],
		[
			`?q=${"x".repeat(81)}`,
			400,
			invalid({ parameter: "q", reason: "too_long", limit: 80 }),
		],
		["?q=a%01b", 400, invalid({ parameter: "q", reason: "malformed" })],
		[
			"?owner=example",
			400,
			invalid({ parameter: "owner", reason: "unsupported_value" }),
		],
		[
			"?sort=territory",
			400,
			invalid({ parameter: "sort", reason: "unsupported_value" }),
		],
		["?page=01", 400, invalid({ parameter: "page", reason: "malformed" })],
		[
			"?page=201",
			400,
			invalid({ parameter: "page", reason: "out_of_bounds", limit: 200 }),
		],
		[
			"?status=-x&type=any",
			400,
			invalid({ parameter: "status", reason: "malformed" }),
		],
		["?type=a%20b", 400, invalid({ parameter: "type", reason: "malformed" })],
		[
			"?pipeline=none",
			400,
			invalid({ parameter: "pipeline", reason: "unsupported_value" }),
		],
		["?scope=x", 503, { error: "DEPENDENCY_UNAVAILABLE" }, { database: null }],
		[
			"?scope=x",
			400,
			invalid({ parameter: "scope", reason: "unsupported_value" }),
			{ slug: "example" },
		],
		["", 403, { error: "AUTHORIZATION_REFUSED" }, { slug: "example" }],
		["?viewer=joe&q=%20&page=", 503, { error: "DEPENDENCY_UNAVAILABLE" }],
	];
	for (const [search, status, expected, options] of cases) {
		const answer = await body(await list(search, options));
		assert.deepEqual(
			[answer.status, answer.text],
			[status, JSON.stringify(expected)],
			search,
		);
	}
});

const SEED = `
insert into actor (id, slug, kind, display_name) values
	('${id(901)}', 'joe', 'human', 'Example'), ('${id(902)}', 'dell', 'human', 'Example'),
	('${id(903)}', 'example-owner', 'human', 'Example');
insert into contact_state (slug, label, contactable, sort) values ('active', 'Example', true, 1);
insert into client_status (slug, label, sort, is_active_pipeline, note) values
	('example-prospect', 'Example prospect', 2, true, 'Example note'),
	('example-past', 'Example past', 1, false, null);
insert into client_type (slug, label) values ('b-type', 'Example A'), ('a-type', 'Example B');
insert into deal_type_ref (slug, label, sort) values ('example-lease', 'Example', 1);
insert into deal_phase (slug, label) values ('example-open', 'Example');
insert into party (id, kind, name, created_by, updated_by)
	select ('00000000-0000-4000-8000-' || lpad((100 + n)::text, 12, '0'))::uuid,
	case when n in (25, 26) then 'person' else 'org' end,
	case n when 25 then 'example tie' when 26 then 'Example Tie' when 27 then 'Example Zeta Rich'
	when 28 then 'Example Ups 50%_off' else 'Example ' || lpad(n::text, 2, '0') end,
	'${id(903)}', '${id(903)}' from generate_series(1, 31) n;
insert into client (id, party_id, owner_id, status, created_by, updated_by, updated_at)
	select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
	('00000000-0000-4000-8000-' || lpad((100 + n)::text, 12, '0'))::uuid,
	case n % 3 when 0 then '${id(901)}'::uuid when 1 then '${id(902)}'::uuid end,
	case when n in (2, 3) then 'example-past' end,
	'${id(903)}', '${id(903)}', '2026-01-01 00:00:00+00'::timestamptz + n * interval '1 minute'
	from generate_series(1, 31) n;
alter table client disable trigger client_touch;
update client set roster_ref = 'C-27', client_type = 'a-type', status = 'example-prospect',
	etl_status = 'example-etl', vertical = 'Dental', deal_type_label = 'Lease',
	owner_id = '${id(903)}', owner_label = 'Example Owner',
	updated_at = '2026-02-03 04:05:06.123456+00' where id = '${id(27)}';
update party set ref = 'P-28', kind = 'person', city = 'Springfield', state = 'IL'
	where id = '${id(128)}';
alter table client enable trigger client_touch;
update client set merged_into = '${id(27)}' where id = '${id(29)}';
update party set merged_into = '${id(127)}' where id = '${id(130)}';
update party set deleted_at = now() where id = '${id(131)}';
insert into deal (client_id, name, deal_type, phase, closed_on, created_by, updated_by)
	select '${id(27)}', 'Example Deal', 'example-lease', 'example-open', d, '${id(903)}', '${id(903)}'
	from unnest(array['2025-03-04', '2025-06-07', null]::date[]) d;
`;

const row = (n: number, name: string, fields: object = {}) => ({
	id: id(n),
	ref: null,
	name,
	party_kind: "org",
	city: null,
	state: null,
	recorded_status: null,
	recorded_status_label: null,
	recorded_status_active_pipeline: null,
	recorded_etl_status: null,
	recorded_client_type: null,
	recorded_client_type_label: null,
	vertical: null,
	last_deal_at: null,
	deal_type: null,
	owner_label: null,
	owned_by_viewer: false,
	updated_at: `2026-01-01T00:${String(n).padStart(2, "0")}:00+00:00`,
	...fields,
});

test("the client list answers the old JSON across pages, searches, sorts and filters", () =>
	withSnapshot(async (database) => {
		const admin = new pg.Client({ connectionString: database });
		await admin.connect();
		try {
			await admin.query(SEED);
			const ask = async (search: string, slug = "joe") => {
				const answer = await body(await list(search, { slug, database }));
				assert.equal(answer.status, 200, answer.text);
				return answer.json;
			};
			const ids = async (search: string, slug = "joe") =>
				(await ask(search, slug)).rows.map((r: { id: string }) => r.id);

			const page2 = await body(
				await list("?contract=vendor-directory.v1&page=2&viewer=joe", {
					database,
				}),
			);
			const { observed_at, valid_until } = page2.json.source;
			assert.equal(Date.parse(valid_until) - Date.parse(observed_at), 60_000);
			assert.match(observed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
			assert.equal(
				page2.text,
				JSON.stringify({
					viewer: "joe",
					dataset: "clients",
					query: {
						dataset: "clients",
						contract: "vendor-directory.v1",
						scope: "team",
						q: null,
						owner: "all",
						territory: null,
						sort: "name",
						page: 2,
						page_size: 25,
						status: null,
						type: null,
						pipeline: "any",
					},
					total: 28,
					page: 2,
					page_size: 25,
					page_count: 2,
					out_of_range: false,
					rows: [
						row(26, "Example Tie", { party_kind: "person" }),
						row(28, "Example Ups 50%_off", {
							ref: null,
							party_kind: "person",
							city: "Springfield",
							state: "IL",
						}),
						row(27, "Example Zeta Rich", {
							ref: "C-27",
							recorded_status: "example-prospect",
							recorded_status_label: "Example prospect",
							recorded_status_active_pipeline: true,
							recorded_etl_status: "example-etl",
							recorded_client_type: "a-type",
							recorded_client_type_label: "Example B",
							vertical: "Dental",
							last_deal_at: "2025-06-07",
							deal_type: "Lease",
							owner_label: "Example Owner",
							updated_at: "2026-02-03T04:05:06.123456+00:00",
						}),
					],
					facets: {
						statuses: [
							{
								slug: "example-past",
								label: "Example past",
								is_active_pipeline: false,
							},
							{
								slug: "example-prospect",
								label: "Example prospect",
								is_active_pipeline: true,
							},
						],
						types: [
							{ slug: "b-type", label: "Example A" },
							{ slug: "a-type", label: "Example B" },
						],
					},
					partial: null,
					recorded_field_note:
						"Status and ETL are what someone entered on this record. They are shown as entered, and they are not proof that an agreement was signed or that anyone was put on the work.",
					source: {
						source: "client",
						source_ref: "client+party+client_status+client_type",
						observed_at,
						valid_until,
						freshness: "fresh",
						correlation_id: CORRELATION,
						safe_explanation:
							"Fresh because this is a no-store request-time canonical database read of live business records; valid for 60 seconds.",
					},
				}),
			);

			// Names that tie ignoring case keep id order across the page boundary.
			const first = await ids("");
			assert.deepEqual(
				first,
				Array.from({ length: 25 }, (_, n) => id(n + 1)),
			);
			const past = await ask("?page=3");
			assert.deepEqual(
				[past.total, past.page_count, past.out_of_range, past.rows],
				[28, 2, true, []],
			);
			assert.deepEqual(
				Object.keys(past.query),
				Object.keys(page2.json.query).filter((k) => k !== "contract"),
			);
			assert.deepEqual(
				Object.keys((await ask("?q=Zeta")).rows[0]),
				Object.keys(row(0, "")).filter(
					(k) => k !== "last_deal_at" && k !== "deal_type",
				),
			);

			for (const [q, expected] of [
				["%25", [id(28)]],
				["_", [id(28)]],
				["c-27", [id(27)]],
				["p-28", [id(28)]],
				["%20%20TIE%20", [id(25), id(26)]],
			] as const)
				assert.deepEqual(await ids(`?q=${q}`), expected, q);
			assert.equal((await ask("?q=%20%20Tie")).query.q, "Tie");

			const owned = (owner: number) =>
				Array.from({ length: 28 }, (_, n) => n + 1)
					.filter(
						(n) => n !== 27 && (owner === 901 ? n % 3 === 0 : n % 3 === 1),
					)
					.map(id);
			assert.deepEqual(await ids("?scope=mine"), owned(901).slice(0, 25));
			assert.deepEqual(await ids("?scope=mine", "dell"), owned(902));
			assert.deepEqual(await ids("?owner=dell&q=0"), [1, 4, 7, 10, 28].map(id));
			const mine = await ask("?scope=mine&q=03", "joe");
			assert.deepEqual([mine.total, mine.rows[0].owned_by_viewer], [1, true]);

			assert.deepEqual((await ids("?sort=recent")).slice(0, 3), [
				id(27),
				id(28),
				id(26),
			]);
			assert.deepEqual((await ids("?sort=last_deal_desc")).slice(0, 2), [
				id(27),
				id(1),
			]);
			assert.deepEqual(
				(await ids("?sort=last_deal_asc&page=2")).at(-1),
				id(28),
			);
			assert.deepEqual((await ids("?sort=vertical")).slice(0, 2), [
				id(27),
				id(1),
			]);
			assert.deepEqual((await ids("?sort=deal_type")).slice(0, 2), [
				id(27),
				id(1),
			]);

			assert.deepEqual(await ids("?pipeline=active"), [id(27)]);
			assert.deepEqual(await ids("?pipeline=other"), [id(2), id(3)]);
			assert.equal((await ask("?pipeline=unknown")).total, 25);
			assert.deepEqual(await ids("?status=example-past"), [id(2), id(3)]);
			assert.deepEqual(await ids("?type=a-type"), [id(27)]);

			// A partner without an actor row: "My work" is refused, ownership unknown.
			await admin.query(
				"update actor set slug = 'example-gone' where slug = 'dell'",
			);
			const refused = await body(
				await list("?scope=mine", { slug: "dell", database }),
			);
			assert.deepEqual(
				[refused.status, refused.text],
				[409, '{"error":"VIEWER_OWNER_UNKNOWN"}'],
			);
			const unknown = await ask("?q=Example%2001", "dell");
			assert.equal(unknown.rows[0].owned_by_viewer, null);
			assert.equal(
				(await ask("?q=Example%2002", "dell")).rows[0].owned_by_viewer,
				false,
			);
		} finally {
			await admin.end();
		}
	}));
