import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import worker from "../worker.ts";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// No server listens there, so a query that parses is refused as unavailable.
const get = (
	search: string,
	database = "postgres://made-up@127.0.0.1:1/none",
) =>
	worker.request(
		`https://app.example.test/api/engine/vendors${search}`,
		{ headers: { Cookie: "__Host-dealroom_session=made-up-session" } },
		{
			CARR: {
				fetch: async () =>
					Response.json({
						actor: { slug: "joe", display: "Example Partner" },
						csrf_token: "made-up-csrf",
					}),
			},
			DATABASE: { connectionString: database },
		},
	);

test("the vendor list refuses client keys and bad vendor filters with the old bodies", async () => {
	const invalid = (detail: object) => ({ error: "QUERY_INVALID", detail });
	const cases: [string, number, object][] = [
		["?status=x", 400, invalid({ parameter: "status", reason: "unsupported" })],
		[
			"?pipeline=any",
			400,
			invalid({ parameter: "pipeline", reason: "unsupported" }),
		],
		[`?territory=${"x".repeat(81)}`, 400, invalid({ parameter: "territory" })],
		["?territory=a%01b&sort=x", 400, invalid({ parameter: "territory" })],
		[
			"?category=-x",
			400,
			invalid({ parameter: "category", reason: "malformed" }),
		],
		["?stage=a%20b", 400, invalid({ parameter: "stage", reason: "malformed" })],
		[
			"?disposition=a/b",
			400,
			invalid({ parameter: "disposition", reason: "malformed" }),
		],
		[
			"?contract=vendor-directory.v2",
			400,
			invalid({ parameter: "contract", reason: "unsupported_value" }),
		],
		[
			`?sort=territory&territory=${" x".repeat(40)}`,
			503,
			{ error: "DEPENDENCY_UNAVAILABLE" },
		],
	];
	for (const [search, status, expected] of cases) {
		const response = await get(search);
		assert.deepEqual(
			[response.status, await response.text()],
			[status, JSON.stringify(expected)],
			search,
		);
	}
});

const SEED = `
insert into actor (id, slug, kind, display_name) values
	('${id(901)}', 'joe', 'human', 'Example'), ('${id(902)}', 'dell', 'human', 'Example');
insert into contact_state (slug, label, contactable, sort) values ('active', 'Example', true, 1);
insert into vendor_category values ('lender', 'Example lender', 2), ('architect', 'Example architect', 1);
insert into vendor_stage values ('warm', 'Example warm', 1);
insert into vendor_disposition values ('active', 'Example active', true, 1);
insert into vendor_relationship_level values (1, 'Example one', 'Example note');
insert into party (id, kind, name, ref, created_by, updated_by)
	select n::uuid, 'person', name, ref, '${id(901)}', '${id(901)}' from (values
		('${id(101)}', 'Example Beta', 'P-1'), ('${id(102)}', 'example alpha', null),
		('${id(103)}', 'Example Gamma', null), ('${id(104)}', 'Example Merged', null)) v(n, name, ref);
insert into vendor (id, vendor_ref, party_id, category, category_slug, territory, owner_id,
	verticals, stage, relationship_level, deal_history_verified_at, created_by, updated_by, updated_at)
	values
	('${id(1)}', 'V-1', '${id(101)}', 'lender', null, 'Austin', '${id(901)}', '{Dental,Ortho}',
		'warm', 1, '2024-01-01', '${id(901)}', '${id(901)}', '2026-01-02 03:04:05.123456+00'),
	('${id(2)}', null, '${id(102)}', 'legacy-x', null, null, null, null,
		null, null, null, '${id(901)}', '${id(901)}', '2026-01-01 00:00:00+00'),
	('${id(3)}', null, '${id(103)}', 'Lender', 'architect', 'Boston', '${id(902)}', '{}',
		null, null, null, '${id(901)}', '${id(901)}', '2026-01-01 00:00:00+00'),
	('${id(4)}', null, '${id(104)}', 'lender', null, 'Zed', null, null,
		null, null, null, '${id(901)}', '${id(901)}', '2026-01-01 00:00:00+00');
update vendor set merged_into = '${id(1)}' where id = '${id(4)}';
`;

const unrated = {
	coverage_verified_at: null,
	deals_referred: null,
	deals_worked: null,
	won: null,
	lost: null,
	first_worked_at: null,
	last_contacted_at: null,
	last_contact_note: null,
	override: null,
	recent_entries: [],
	introductions: [],
	computed_tier: "Unrated",
	win_rate: null,
	formula_version: "vendor-trust.v1",
};

const row = (n: number, name: string, fields: object) => ({
	id: id(n),
	ref: null,
	name,
	party_kind: "person",
	city: null,
	state: null,
	recorded_category: "lender",
	recorded_category_label: "Example lender",
	recorded_stage: null,
	recorded_stage_label: null,
	recorded_disposition: "active",
	recorded_disposition_label: "Example active",
	recorded_disposition_workable: true,
	relationship_level: null,
	relationship_level_label: null,
	referral_active: null,
	is_target: false,
	out_of_market: false,
	last_touch: null,
	relationship: unrated,
	vertical: null,
	deal_type: "Example lender",
	last_deal_at: null,
	territory: null,
	owner_label: null,
	owned_by_viewer: false,
	updated_at: "2026-01-01T00:00:00+00:00",
	...fields,
});

test("the vendor list answers the old JSON for its rows, facets, filters and legacy shape", () =>
	withSnapshot(async (database) => {
		const admin = new pg.Client({ connectionString: database });
		await admin.connect();
		try {
			await admin.query(SEED);
		} finally {
			await admin.end();
		}
		const ask = async (search: string) => {
			const response = await get(search, database);
			const text = await response.text();
			assert.equal(response.status, 200, text);
			return { text, json: JSON.parse(text) };
		};
		const ids = async (search: string) =>
			(await ask(`?contract=vendor-directory.v1&${search}`)).json.rows.map(
				(r: { id: string }) => r.id,
			);

		const { text, json } = await ask("?contract=vendor-directory.v1");
		assert.equal(
			text,
			JSON.stringify({
				viewer: "joe",
				dataset: "vendors",
				query: {
					dataset: "vendors",
					contract: "vendor-directory.v1",
					scope: "team",
					q: null,
					owner: "all",
					territory: null,
					sort: "name",
					page: 1,
					page_size: 25,
					category: null,
					stage: null,
					disposition: null,
				},
				total: 3,
				page: 1,
				page_size: 25,
				page_count: 1,
				out_of_range: false,
				rows: [
					row(2, "example alpha", {
						recorded_category: "legacy-x",
						recorded_category_label: null,
						deal_type: null,
					}),
					row(1, "Example Beta", {
						ref: "V-1",
						recorded_stage: "warm",
						recorded_stage_label: "Example warm",
						relationship_level: 1,
						relationship_level_label: "Example one",
						relationship: {
							...unrated,
							coverage_verified_at: "2024-01-01T00:00:00+00:00",
							deals_referred: 0,
							deals_worked: 0,
							won: 0,
							lost: 0,
							computed_tier: "Trial",
						},
						vertical: "Dental, Ortho",
						territory: "Austin",
						owned_by_viewer: true,
						updated_at: "2026-01-02T03:04:05.123456+00:00",
					}),
					row(3, "Example Gamma", {
						recorded_category: "architect",
						recorded_category_label: "Example architect",
						deal_type: "Example architect",
						territory: "Boston",
					}),
				],
				facets: {
					categories: [
						{ slug: "architect", label: "Example architect" },
						{ slug: "lender", label: "Example lender" },
					],
					stages: [{ slug: "warm", label: "Example warm" }],
					dispositions: [
						{ slug: "active", label: "Example active", workable: true },
					],
					territories: [
						{ slug: "Austin", label: "Austin" },
						{ slug: "Boston", label: "Boston" },
					],
				},
				partial: {
					kind: "unlabelled_recorded_codes",
					count: 1,
					fields: ["recorded_category"],
					note: "Some entries use a code that is not in the current list of options. The stored value is shown exactly as it is, and has not been renamed.",
				},
				recorded_field_note:
					"Stage, disposition and relationship level are what someone entered on this record. They are shown as entered, and they are not proof of a commitment either way.",
				source: {
					...json.source,
					source: "vendor",
					source_ref:
						"vendor+party+vendor_category+vendor_stage+vendor_disposition",
				},
			}),
		);

		const legacy = (await ask("")).json;
		assert.deepEqual(Object.keys(legacy.facets), [
			"categories",
			"stages",
			"dispositions",
		]);
		const {
			relationship,
			vertical,
			deal_type,
			last_deal_at,
			territory,
			...kept
		} = row(2, "", {});
		assert.deepEqual(Object.keys(legacy.rows[0]), Object.keys(kept));

		assert.deepEqual(await ids("sort=territory"), [id(1), id(3), id(2)]);
		assert.deepEqual(await ids("territory=Austin"), [id(1)]);
		assert.deepEqual(await ids("territory=austin"), []);
		assert.deepEqual(await ids("category=architect"), [id(3)]);
		assert.deepEqual(await ids("q=ALPHA"), [id(2)]);
		assert.deepEqual(await ids("q=p-1&scope=mine"), [id(1)]);
		assert.deepEqual(await ids("owner=dell&stage=any"), [id(3)]);
	}));
