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
const leads = (search: string, connectionString: string) =>
	worker.request(
		`https://app.example.test/api/engine/leads${search}`,
		{ headers: { Cookie: "__Host-dealroom_session=made-up-session" } },
		{ CARR: signedIn, DATABASE: { connectionString } },
	);

const refused = async (
	response: Response,
	status: number,
	expected: Record<string, unknown>,
) => {
	assert.equal(response.status, status);
	const { correlation_id, ...body } = (await response.json()) as {
		correlation_id: string;
	};
	assert.match(correlation_id, /^[0-9a-f-]{36}$/);
	assert.deepEqual(body, expected);
};
const generic = {
	error: "unhandled_verb_failure",
	hint: "The operation failed. Quote the correlation_id when reporting it.",
};

test("the board refuses a bad workspace, then unknown fields, then a cursor, before any read", async () => {
	const unread = "postgres://made-up@127.0.0.1:1/none";
	await refused(await leads("?workspace=deals&b=1", unread), 400, {
		error: "value_not_in_declared_vocabulary",
		hint: "Use a value from the field's documented vocabulary.",
		allowed_values: ["leads"],
		fields: ["workspace"],
	});
	await refused(await leads("?workspace=leads&b=1&a=2&%24bad=3", unread), 400, {
		error: "unregistered_operation_fields",
		hint: "Remove fields outside the documented input.",
		fields: ["a", "b"],
	});
	await refused(await leads("?stage_history_cursor=12", unread), 400, generic);
	await refused(await leads("?correspondence_cursor=", unread), 400, generic);
});

test("the board answers, and refuses whole past the finding limit", () =>
	withSnapshot(async (url) => {
		const db = new pg.Client({ connectionString: url });
		await db.connect();
		const seed = `with a as (insert into actor (slug, kind, display_name)
				values ('leads-route-partner', 'human', 'Example') returning id),
			k as (insert into contact_state (slug, label, contactable, sort)
				values ('active', 'Example', true, 1)),
			s as (insert into lead_stage (slug, label, sort) values ('new', 'New', 1)),
			p as (insert into party (kind, name, created_by, updated_by)
				select 'org', 'Example Route Lead', id, id from a returning id, created_by)
			insert into lead (party_id, stage, created_by, updated_by)
			select id, 'new', created_by, created_by from p`;
		const flood = `insert into record_flag (subject_type, subject_id, kind, value, source, created_by)
			select 'party', party_id, 'note', '{}', 'Example', created_by
			from lead, generate_series(1, 501)`;
		try {
			await db.query(seed);
			const response = await leads("?workspace=leads", url);
			assert.equal(response.status, 200);
			const board = (await response.json()) as {
				leads: { name: string; reachability: { classification: string } }[];
			};
			assert.deepEqual(
				board.leads.map((l) => [l.name, l.reachability.classification]),
				[["Example Route Lead", "research"]],
			);
			await db.query(flood);
			await refused(await leads("", url), 422, generic);
		} finally {
			await db.end();
		}
	}));
