import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import worker from "../worker.ts";

const signedIn = {
	fetch: async () =>
		Response.json({
			actor: { slug: "territory-route-partner", display: "Example Partner" },
			csrf_token: "made-up-csrf",
		}),
};
const territory = (search: string, connectionString: string) =>
	worker.request(
		`https://app.example.test/api/engine/territory-state-board${search}`,
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

test("territory refuses unknown fields before any read", async () => {
	const unread = "postgres://made-up@127.0.0.1:1/none";
	const unknown = {
		error: "unregistered_operation_fields",
		hint: "Remove fields outside the documented input.",
	};
	assert.deepEqual(
		await refusal(await territory("?city=A&b=1&a=2&a=3&%24bad=4", unread)),
		[400, { ...unknown, fields: ["a", "b"] }],
	);
	assert.deepEqual(await refusal(await territory("?%24bad=1", unread)), [
		400,
		{ ...unknown, fields: [] },
	]);
});

test("territory filters as the old system did and refuses past 1000 markets", () =>
	withSnapshot(async (url) => {
		const db = new pg.Client({ connectionString: url });
		await db.connect();
		const places = (count: number) =>
			db.query(
				`insert into party (kind, name, city, state, specialty, created_by, updated_by)
				select 'person', 'Example Person', 'City ' || i, 'ZZ', 'Dental', id, id
				from actor, generate_series(1, $1::int) i`,
				[count],
			);
		const markets = async (search: string) => {
			const response = await territory(search, url);
			assert.equal(response.status, 200);
			const board = (await response.json()) as {
				submarkets: { city: string }[];
			};
			return board.submarkets.map((m) => m.city);
		};
		try {
			await db.query(`insert into actor (slug, kind, display_name)
				values ('territory-route-partner', 'human', 'Example');
				insert into contact_state (slug, label, contactable, sort)
				values ('active', 'Example', true, 1)`);
			await places(2);
			assert.deepEqual(await markets(""), ["City 1", "City 2"]);
			assert.deepEqual(await markets("?city=&state=&vertical="), [
				"City 1",
				"City 2",
			]);
			assert.deepEqual(await markets("?city=City%202&state=ZZ"), ["City 2"]);
			assert.deepEqual(await markets("?vertical=Dental"), ["City 1", "City 2"]);
			// The declared state pattern and lengths were never checked.
			assert.deepEqual(await markets("?state=zz"), []);
			assert.deepEqual(await markets(`?city=${"x".repeat(201)}`), []);
			await db.query("delete from party");
			await places(1001);
			assert.deepEqual(await refusal(await territory("", url)), [
				422,
				{
					error: "unhandled_verb_failure",
					hint: "The operation failed. Quote the correlation_id when reporting it.",
				},
			]);
		} finally {
			await db.end();
		}
	}));
