import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import worker from "../worker.ts";
import type { VendorMarkets } from "./markets.ts";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const UNREAD = "postgres://made-up@127.0.0.1:1/none";

const markets = (search: string, connectionString: string, slug = "joe") =>
	worker.request(
		`https://app.example.test/api/engine/vendor-markets${search}`,
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

// The old door's generic body: none of this read's refusals was public.
const GENERIC = {
	error: "unhandled_verb_failure",
	hint: "The operation failed. Quote the correlation_id when reporting it.",
};

async function refused(response: Response, status: number, expected = {}) {
	assert.equal(response.status, status);
	const { correlation_id, ...body } = (await response.json()) as Record<
		string,
		unknown
	>;
	assert.equal(typeof correlation_id, "string");
	assert.deepEqual(body, { ...GENERIC, ...expected });
}

const ready = async (response: Response) => {
	assert.equal(response.status, 200);
	return (await response.json()) as VendorMarkets;
};

async function run(url: string, statements: string) {
	const db = new pg.Client({ connectionString: url });
	await db.connect();
	try {
		await db.query(statements);
	} finally {
		await db.end();
	}
}

const ACTORS = `insert into actor (id, slug, kind, display_name) values
		('${ACTOR}', 'joe', 'human', 'Example'),
		('00000000-0000-4000-8000-000000000002', 'example-agent', 'human', 'Example');
	insert into contact_state values ('active', 'Example', true, 1);
	insert into vendor_disposition values ('active', 'Example', true, 1);`;

const party = (
	id: string,
	kind: string,
	name: string,
	extra = "null, null, null",
) =>
	`insert into party (id, kind, name, org_id, merged_into, deleted_at, created_by, updated_by)
		values ('${id}', '${kind}', '${name}', ${extra}, '${ACTOR}', '${ACTOR}');`;
const vendor = (id: string, partyId: string, merged = "null") =>
	`insert into vendor (id, party_id, category, merged_into, created_by, updated_by)
		values ('${id}', '${partyId}', 'lender', ${merged}, '${ACTOR}', '${ACTOR}');`;
const market = (slug: string, kind = "market") =>
	`insert into vendor_market values ('${slug}', 'Example', '${kind}', 'Example', 'Example',
		'${ACTOR}', '2026-01-01T00:00:00Z');`;
const member = (slug: string, vendorId: string) =>
	`insert into vendor_market_membership values ('${slug}', '${vendorId}', true, null,
		'Example', '${ACTOR}', '2026-01-01T00:00:00Z');`;

test("bad input is refused before any read", async () => {
	await refused(await markets("?market=a&extra=1", UNREAD), 400, {
		error: "unregistered_operation_fields",
		hint: "Remove fields outside the documented input.",
		fields: ["extra"],
	});
	for (const search of [
		"?market=",
		"?market=%20%20",
		`?market=${"x".repeat(201)}`,
		"?market=a&market=b",
	])
		await refused(await markets(search, UNREAD), 400);
});

test("markets list live vendors, their people and offices, and resolve an alias", () =>
	withSnapshot(async (url) => {
		// Ids in the order the answer sorts them.
		const id = (n: number) => `00000000-0000-4000-8000-1000000000${n}0`;
		const [blake, alex, org, live] = [id(1), id(2), id(3), id(4)];
		const [merged, deleted, gone] = [id(5), id(6), id(7)];
		await run(
			url,
			`${ACTORS} ${party(org, "org", "Example Lending Co")}
			${party(alex, "person", "Alex Example", `'${org}', null, null`)}
			${party(blake, "person", "Blake Example", `'${org}', null, null`)}
			${party(gone, "org", "Example Deleted Co", "null, null, now()")}
			${vendor(live, org)} ${vendor(merged, org, `'${live}'`)} ${vendor(deleted, gone)}
			${market("springfield")} ${market("example-region", "regional")}
			insert into vendor_market_key values ('spring field', 'springfield');
			${member("springfield", live)} ${member("springfield", merged)}
			${member("springfield", deleted)} ${member("example-region", live)}
			insert into vendor_market_regional_reference (market_slug, regional_slug, note, source,
				reviewed_by, reviewed_at) values ('springfield', 'example-region', 'Example', 'Example',
				'${ACTOR}', '2026-01-01T00:00:00Z');
			insert into record_flag (subject_type, subject_id, kind, value, source, observed_at, created_by)
				values ('party', '${alex}', 'address', '{"found":true,"epistemic_status":"source_backed",
				"location_type":"office","street_address":"1 Example Way","city":"Springfield","state":"ZZ"}',
				'https://example.test', '2025-01-01T00:00:00Z', '${ACTOR}');`,
		);
		const answer = await ready(
			await markets("?market=%20Spring%20FIELD%20", url),
		);
		assert.equal(answer.selected_market, "springfield");
		assert.deepEqual(
			answer.markets.map((m) => [
				m.slug,
				m.aliases,
				m.vendor_count,
				m.memberships.map((x) => x.vendor_id),
				m.regional_references.map((r) => [r.regional_slug, r.regional_kind]),
			]),
			[
				["example-region", ["example-region"], 1, [live], []],
				[
					"springfield",
					["spring field", "springfield"],
					1,
					[live],
					[["example-region", "regional"]],
				],
			],
		);
		assert.deepEqual(
			answer.vendors.map((v) => [v.id, v.name, v.market_slugs]),
			[[live, "Example Lending Co", ["example-region", "springfield"]]],
		);
		assert.deepEqual(
			answer.vendors[0]?.people.map((p) => [
				p.contact.name,
				p.research.status,
				p.office?.street_address,
			]),
			[
				["Blake Example", "not_researched", undefined],
				["Alex Example", "office_verified", "1 Example Way"],
			],
		);
		await refused(await markets("?market=nowhere", url), 404);
		await refused(await markets("", url, "example-agent"), 422);
	}));

test("an empty registry answers empty, and one over either cap is refused, never cut", () =>
	withSnapshot(async (url) => {
		await run(url, ACTORS);
		assert.deepEqual(await ready(await markets("?market=Anywhere", url)), {
			ok: true,
			schema_version: "vendor-markets.v1",
			state: "empty",
			selected_market: null,
			markets: [],
			vendors: [],
		});
		const extra = "00000000-0000-4000-9000-000000000051";
		await run(
			url,
			`insert into vendor_market select 'm-' || i, 'Example', 'market', 'Example', 'Example',
				'${ACTOR}', '2026-01-01T00:00:00Z' from generate_series(1, 100) i;
			insert into party (id, kind, name, created_by, updated_by)
				select ('00000000-0000-4000-9000-' || lpad(i::text, 12, '0'))::uuid, 'person',
				'Example', '${ACTOR}', '${ACTOR}' from generate_series(1, 51) i;
			insert into vendor (id, party_id, category, created_by, updated_by)
				select id, id, 'lender', '${ACTOR}', '${ACTOR}' from party;
			insert into vendor_market_membership select m.slug, v.id, true, null, 'Example',
				'${ACTOR}', '2026-01-01T00:00:00Z' from vendor_market m cross join vendor v
				where v.id <> '${extra}';`,
		);
		const full = await ready(await markets("", url));
		assert.deepEqual([full.markets.length, full.vendors.length], [100, 50]);
		await run(url, member("m-1", extra));
		await refused(await markets("", url), 422);
		await run(
			url,
			`delete from vendor_market_membership where vendor_id = '${extra}'; ${market("m-101")}`,
		);
		await refused(await markets("", url), 422);
	}));
