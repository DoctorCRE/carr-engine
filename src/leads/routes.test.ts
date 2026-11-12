import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import worker from "../worker.ts";

const signedIn = {
	fetch: async () =>
		Response.json({
			actor: { slug: "quiet-route-partner", display: "Example Partner" },
			csrf_token: "made-up-csrf",
		}),
};
const quiet = (search: string, connectionString: string) =>
	worker.request(
		`https://app.example.test/api/engine/quiet-follow-ups${search}`,
		{ headers: { Cookie: "__Host-dealroom_session=made-up-session" } },
		{ CARR: signedIn, DATABASE: { connectionString } },
	);

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
				values ('quiet-route-partner', 'human', 'Example');
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
