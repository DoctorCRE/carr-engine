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

async function seed(database: string, rows: string) {
	const admin = new pg.Client({ connectionString: database });
	await admin.connect();
	try {
		await admin.query(rows);
	} finally {
		await admin.end();
	}
}

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
		await seed(database, SEED);
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
		assert.deepEqual(await ids("q=v-1"), [id(1)]);
		assert.deepEqual(await ids("q=p-1&scope=mine"), [id(1)]);
		assert.deepEqual(await ids("owner=dell&stage=any"), [id(3)]);
	}));

test("a vendor's details refuse paths that are not one vendor with the old bodies", async () => {
	const notFound = JSON.stringify({ error: "not_found" });
	for (const path of [
		"/x",
		`/${id(1)}/`,
		`/%30${id(1).slice(1)}`,
		`/${id(1)}%2F`,
	]) {
		const response = await get(path);
		assert.deepEqual([response.status, await response.text()], [404, notFound]);
	}
	const response = await get(`/${id(1)}?q=x`);
	assert.deepEqual(await response.json(), {
		error: "QUERY_INVALID",
		detail: { parameter: "q", reason: "unsupported" },
	});
});

// An org vendor whose people are two named members and one blank name. The
// first member's latest finding verifies an office; the second's is internal.
const PEOPLE = `
insert into party (id, kind, name, org_id, created_by, updated_by)
	select n::uuid, kind, name, org::uuid, '${id(901)}', '${id(901)}' from (values
		('${id(105)}', 'org', 'Example Firm', null),
		('${id(107)}', 'person', 'Example Ann', '${id(105)}'),
		('${id(106)}', 'person', 'Example Zed', '${id(105)}'),
		('${id(108)}', 'person', '  ', '${id(105)}')) v(n, kind, name, org);
insert into vendor (id, party_id, category, created_by, updated_by) values
	('${id(5)}', '${id(105)}', 'lender', '${id(901)}', '${id(901)}');
insert into record_flag (id, subject_type, subject_id, kind, value, source, observed_at, created_by)
	select n::uuid, 'party', subject::uuid, 'address', value::jsonb, 'Example source', at::timestamptz, '${id(901)}'
	from (values
		('${id(301)}', '${id(106)}', '2026-01-01 00:00:00+00', '{"found": true, "epistemic_status": "source_backed",
			"location_type": "office", "street_address": "1 Example St", "city": "Springfield", "state": "TX"}'),
		('${id(302)}', '${id(106)}', '2025-01-01 00:00:00+00', '{"found": false}'),
		('${id(303)}', '${id(107)}', '2026-01-01 00:00:00+00', '{"found": true, "internal": true}')) v(n, subject, at, value);
`;

const OLD_KEYS =
	"id ref name party_kind city state county title phone cell email contact_state contact_state_reason contact_state_until contact_state_cadence recorded_category recorded_category_label recorded_stage recorded_stage_label recorded_disposition recorded_disposition_label recorded_disposition_workable relationship_level relationship_level_label relationship_level_note verticals territory offers seeking rivalry_group originated referral_active is_target out_of_market last_touch relationship loan_programs intro_notes links_label owner_label owned_by_viewer record_version created_at updated_at";
// The same keys, and people, in the order PostgreSQL's jsonb keeps them.
const JSONB_KEYS =
	"id ref cell city name email phone state title county offers people seeking is_target territory verticals created_at last_touch originated party_kind updated_at intro_notes links_label owner_label relationship contact_state loan_programs out_of_market rivalry_group record_version recorded_stage owned_by_viewer referral_active recorded_category relationship_level contact_state_until contact_state_reason recorded_disposition recorded_stage_label contact_state_cadence recorded_category_label relationship_level_note relationship_level_label recorded_disposition_label recorded_disposition_workable";

// A person and its research, in jsonb's key order.
const finding = (status: string, n?: number) => ({
	status,
	expires_on: null,
	finding_id: n ? id(n) : null,
	observed_at: n ? "2026-01-01T00:00:00+00:00" : null,
});
const person = (
	n: number,
	name: string,
	company: object | null,
	research: object,
	office: object | null = null,
) => ({
	office,
	company,
	contact: {
		id: id(n),
		cell: null,
		name,
		email: null,
		phone: null,
	},
	research,
});

test("a vendor's details answer the old JSON, and v2 adds its people in jsonb's key order", () =>
	withSnapshot(async (database) => {
		await seed(database, SEED + PEOPLE);
		const ask = async (path: string, status = 200) => {
			const response = await get(path, database);
			const text = await response.text();
			assert.equal(response.status, status, text);
			return JSON.parse(text);
		};
		const v1 = await ask(
			`/${id(1).toUpperCase()}?contract=vendor-directory.v1`,
		);
		// Every key in the old order, then the ones this vendor fills.
		const record: Record<string, unknown> = {
			...Object.fromEntries(OLD_KEYS.split(" ").map((key) => [key, null])),
			id: id(1),
			ref: "V-1",
			name: "Example Beta",
			party_kind: "person",
			contact_state: "active",
			recorded_category: "lender",
			recorded_category_label: "Example lender",
			recorded_stage: "warm",
			recorded_stage_label: "Example warm",
			recorded_disposition: "active",
			recorded_disposition_label: "Example active",
			recorded_disposition_workable: true,
			relationship_level: 1,
			relationship_level_label: "Example one",
			relationship_level_note: "Example note",
			verticals: ["Dental", "Ortho"],
			territory: "Austin",
			is_target: false,
			out_of_market: false,
			relationship: {
				...unrated,
				coverage_verified_at: "2024-01-01T00:00:00+00:00",
				deals_referred: 0,
				deals_worked: 0,
				won: 0,
				lost: 0,
				computed_tier: "Trial",
			},
			owned_by_viewer: true,
			record_version: 1,
			created_at: v1.record.created_at,
			updated_at: "2026-01-02T03:04:05.123456+00:00",
		};
		assert.equal(JSON.stringify(v1.record), JSON.stringify(record));
		assert.equal(v1.partial, null);

		const { relationship, loan_programs, territory, ...legacy } = record;
		assert.equal(
			JSON.stringify((await ask(`/${id(1)}`)).record),
			JSON.stringify({ ...legacy, territory }),
		);

		const v2 = (await ask(`/${id(1)}?contract=vendor-directory.v2`)).record;
		assert.equal(Object.keys(v2).join(" "), JSONB_KEYS);
		assert.equal(
			Object.keys(v2.relationship).join(" "),
			"won lost override deals_worked introductions deals_referred recent_entries first_worked_at last_contact_note last_contacted_at coverage_verified_at computed_tier win_rate formula_version",
		);
		assert.deepEqual(v2, {
			...record,
			people: [person(101, "Example Beta", null, finding("not_researched"))],
		});

		const company = { id: id(105), name: "Example Firm" };
		const people = [
			person(106, "Example Zed", company, finding("office_verified", 301), {
				city: "Springfield",
				state: "TX",
				source: "Example source",
				expires_on: null,
				finding_id: id(301),
				observed_at: "2026-01-01T00:00:00+00:00",
				street_address: "1 Example St",
			}),
			person(107, "Example Ann", company, finding("needs_review", 303)),
		];
		const firm = await ask(`/${id(5)}?contract=vendor-directory.v2`);
		assert.equal(JSON.stringify(firm.record.people), JSON.stringify(people));
		const listed = await ask("?contract=vendor-directory.v2&q=firm");
		assert.equal(JSON.stringify(listed.rows[0].people), JSON.stringify(people));
		assert.equal(listed.query.contract, "vendor-directory.v2");
		assert.equal(
			(await ask("?contract=vendor-directory.v1&q=firm")).rows[0].people,
			undefined,
		);

		for (const missing of [id(4), id(999)])
			assert.deepEqual(
				await ask(`/${missing}?contract=vendor-directory.v2`, 404),
				{
					error: "RECORD_NOT_FOUND",
				},
			);
	}));
