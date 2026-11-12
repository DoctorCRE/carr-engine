import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import worker from "../worker.ts";

const signedIn = {
	fetch: async () =>
		Response.json({
			actor: { slug: "activity-route-partner", display: "Example Partner" },
			csrf_token: "made-up-csrf",
		}),
};
const recent = (search: string, connectionString: string) =>
	worker.request(
		`https://app.example.test/api/engine/recent-activity${search}`,
		{ headers: { Cookie: "__Host-dealroom_session=made-up-session" } },
		{ CARR: signedIn, DATABASE: { connectionString } },
	);
const refusal = async (response: Response) => {
	const { correlation_id, ...body } = (await response.json()) as {
		correlation_id: string;
	};
	assert.match(correlation_id, /^[0-9a-f-]{36}$/);
	return [response.status, body];
};

test("bad input is refused in the old door's order, before any read", async () => {
	const unread = "postgres://made-up@127.0.0.1:1/none";
	const refused = async (search: string) =>
		refusal(await recent(search, unread));
	const unknown = (fields: string[]) => [
		400,
		{
			error: "unregistered_operation_fields",
			hint: "Remove fields outside the documented input.",
			fields,
		},
	];
	const markup = (field: string) => [
		400,
		{
			error: "tool_call_markup_in_value",
			hint: "Remove tool-call markup from the named fields.",
			fields: [field],
		},
	];
	const number = [
		400,
		{
			error: "invalid_number",
			hint: "Supply a numeric value for the named fields.",
			fields: ["limit"],
		},
	];
	const missing = [
		400,
		{
			error: "missing_required",
			hint: "Supply the named required fields from the tool's documented input.",
			fields: ["query"],
		},
	];
	const generic = [
		422,
		{
			error: "unhandled_verb_failure",
			hint: "The operation failed. Quote the correlation_id when reporting it.",
		},
	];
	assert.deepEqual(
		await refused("?query=Example&b=1&a=2&%24x=3"),
		unknown(["a", "b"]),
	);
	assert.deepEqual(await refused("?limit=x&extra=1"), unknown(["extra"]));
	assert.deepEqual(
		await refused("?query=a%3C%2Fquery%3E&limit=x"),
		markup("query"),
	);
	assert.deepEqual(
		await refused("?query=a%60%3Cinvoke%0A%60"),
		markup("query"),
	);
	assert.deepEqual(await refused("?limit=%3C%2Flimit%3E"), markup("limit"));
	assert.deepEqual(await refused("?limit=abc"), number);
	assert.deepEqual(await refused("?query=Example&limit=%20"), number);
	assert.deepEqual(await refused("?query="), missing);
	assert.deepEqual(await refused("?query=%20%20"), generic);
	assert.deepEqual(await refused(`?query=${"a".repeat(201)}`), generic);
	for (const limit of ["0", "51", "2.5"])
		assert.deepEqual(await refused(`?query=Example&limit=${limit}`), generic);
});

test("the read answers trimmed queries and maps the resolver's refusals", () =>
	withSnapshot(async (url) => {
		const db = new pg.Client({ connectionString: url });
		await db.connect();
		try {
			await db.query(`with a as (insert into actor (slug, kind, display_name)
				values ('activity-route-partner', 'human', 'Example') returning id),
			k as (insert into contact_state (slug, label, contactable, sort)
				values ('active', 'Example', true, 1)),
			d as (insert into vendor_disposition (slug, label, workable, sort)
				values ('active', 'Example', true, 1)),
			s as (insert into deal_phase (slug, label) values ('route-open', 'Example')),
			t as (insert into deal_type_ref (slug, label, sort) values ('route-lease', 'Example', 1)),
			p as (insert into party (kind, name, created_by, updated_by)
				select 'org', 'Blorft Quaffle', id, id from a returning id, created_by),
			v as (insert into party (kind, name, created_by, updated_by)
				select 'person', 'Kwyjibo Plinth', id, id from a returning id, created_by),
			w as (insert into vendor (party_id, vendor_ref, category, created_by, updated_by)
				select id, 'VND-1', 'cpa', created_by, created_by from v),
			c as (insert into client (party_id, roster_ref, created_by, updated_by)
				select id, 'Example Lease', created_by, created_by from p returning id, created_by)
			insert into deal (client_id, name, deal_type, phase, created_by, updated_by)
			select id, name, 'route-lease', 'route-open', created_by, created_by
			from c, unnest(array['Example Lease A', 'Example Lease B', 'Thistlewick <invoke Deal']) name`);
		} finally {
			await db.end();
		}
		const completed = await recent(
			"?query=%20%20example%20LEASE%20a%20&limit=5",
			url,
		);
		assert.equal(completed.status, 200);
		assert.deepEqual(
			(({ state, query, match }) => ({ state, query, match }))(
				(await completed.json()) as Record<string, unknown>,
			),
			{
				state: "completed",
				query: "example LEASE a",
				match: {
					kind: "deal",
					name: "Example Lease A",
					target: "Example Lease A",
				},
			},
		);
		assert.deepEqual(await refusal(await recent("?query=Blorft", url)), [
			409,
			{
				error: "needs_disambiguation",
				hint: "Choose an exact record reference from the candidates before retrying.",
				candidates: [
					{
						name: "Example Lease A",
						phase: "route-open",
						client_ref: "Example Lease",
					},
					{
						name: "Example Lease B",
						phase: "route-open",
						client_ref: "Example Lease",
					},
				],
			},
		]);
		assert.deepEqual(await refusal(await recent("?query=Kwyjibo", url)), [
			404,
			{
				error: "unhandled_verb_failure",
				hint: "The operation failed. Quote the correlation_id when reporting it.",
			},
		]);
		assert.deepEqual(await refusal(await recent("?query=Thistlewick", url)), [
			400,
			{
				error: "tool_call_markup_in_value",
				hint: "Remove tool-call markup from the named fields.",
				fields: [],
			},
		]);
	}));
