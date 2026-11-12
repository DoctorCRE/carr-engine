import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import worker from "../worker.ts";

const signedIn = {
	fetch: async () =>
		Response.json({
			actor: { slug: "find-route-partner", display: "Example Partner" },
			csrf_token: "made-up-csrf",
		}),
};
const find = (search: string, connectionString: string) =>
	worker.request(
		`https://app.example.test/api/engine/find${search}`,
		{ headers: { Cookie: "__Host-dealroom_session=made-up-session" } },
		{ CARR: signedIn, DATABASE: { connectionString } },
	);

test("find refuses reserved fields, then unknown fields, then a missing query, before any read", async () => {
	const unread = "postgres://made-up@127.0.0.1:1/none";
	const refused = async (
		search: string,
		expected: Record<string, unknown>,
		status = 400,
	) => {
		const response = await find(search, unread);
		assert.equal(response.status, status);
		const { correlation_id, ...body } = (await response.json()) as {
			correlation_id: string;
		};
		assert.match(correlation_id, /^[0-9a-f-]{36}$/);
		assert.deepEqual(body, expected);
	};
	const unknown = {
		error: "unregistered_operation_fields",
		hint: "Remove fields outside the documented input.",
	};
	await refused("?query=Example&b=1&a=2&a=3&%24bad=4", {
		...unknown,
		fields: ["a", "b"],
	});
	await refused("?%24bad=1", { ...unknown, fields: [] });
	await refused(
		"?organization_tenant_id=x&a=1",
		{
			error: "caller_authority_field_forbidden",
			hint: "Remove caller-supplied authority fields.",
			fields: ["organization_tenant_id"],
		},
		403,
	);
	const missing = {
		error: "missing_required",
		hint: "Supply the named required fields from the tool's documented input.",
		fields: ["query"],
	};
	await refused("", missing);
	await refused("?query=", missing);
});

test("find reads the query untrimmed", () =>
	withSnapshot(async (url) => {
		const db = new pg.Client({ connectionString: url });
		await db.connect();
		try {
			await db.query(`with a as (insert into actor (slug, kind, display_name)
				values ('find-route-partner', 'human', 'Example') returning id),
			k as (insert into contact_state (slug, label, contactable, sort)
				values ('active', 'Example', true, 1)),
			s as (insert into deal_phase (slug, label) values ('route-open', 'Example')),
			t as (insert into deal_type_ref (slug, label, sort) values ('route-lease', 'Example', 1)),
			p as (insert into party (kind, name, created_by, updated_by)
				select 'org', 'Example Route Clinic', id, id from a returning id, created_by),
			c as (insert into client (party_id, created_by, updated_by)
				select id, created_by, created_by from p returning id, created_by)
			insert into deal (client_id, name, deal_type, phase, created_by, updated_by)
			select id, 'Example Route Lease', 'route-lease', 'route-open', created_by, created_by from c`);
		} finally {
			await db.end();
		}
		const deals = async (search: string) => {
			const response = await find(search, url);
			assert.equal(response.status, 200);
			const found = (await response.json()) as { deals: { name: string }[] };
			return found.deals.map((d) => d.name);
		};
		assert.deepEqual(await deals("?query=Lease"), ["Example Route Lease"]);
		assert.deepEqual(await deals("?query=Lease%20"), []);
		assert.deepEqual(await deals("?query=+Route+"), ["Example Route Lease"]);
	}));
