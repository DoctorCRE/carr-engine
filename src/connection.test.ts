import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../scripts/test-database.ts";
import { url } from "./test-rollback.ts";
import worker from "./worker.ts";

const actor = { slug: "test-partner", display: "Test Partner" };
const CARR = {
	fetch: async () => Response.json({ actor, csrf_token: "made-up-csrf" }),
};

async function ask(database?: { connectionString: string }) {
	const response = await worker.request(
		"https://app.example.test/api/engine/database",
		{ headers: { Cookie: "__Host-dealroom_session=made-up-session" } },
		{ CARR, DATABASE: database },
	);
	return { status: response.status, body: await response.json() };
}

async function withLogin(
	database: string,
	grant: boolean,
	run: (login: string) => Promise<void>,
) {
	const name = `engine_probe_${randomUUID().replaceAll("-", "")}`;
	const admin = new pg.Client({ connectionString: database });
	await admin.connect();
	try {
		await admin.query(`CREATE ROLE ${name} LOGIN`);
		await admin.query(`ALTER ROLE ${name} SET TimeZone = 'America/Chicago'`);
		if (grant)
			await admin.query(
				`GRANT SELECT ON public.v_open_deal_room_board TO ${name}`,
			);
		const login = new URL(database);
		login.username = name;
		await run(login.href);
	} finally {
		await admin.query(`DROP OWNED BY ${name}`);
		await admin.query(`DROP ROLE ${name}`);
		await admin.end();
	}
}

for (const grant of [true, false])
	test(`a login ${grant ? "with" : "without"} the board grant gets a read-only UTC snapshot`, async () => {
		await withSnapshot((database) =>
			withLogin(database, grant, async (connectionString) => {
				assert.deepEqual(await ask({ connectionString }), {
					status: 200,
					body: {
						read_only: true,
						isolation: "repeatable read",
						time_zone: "UTC",
						board_view_readable: grant,
					},
				});
			}),
		);
	});

test("no binding and an unreachable database both answer 503 with a fixed body", async () => {
	const refused = { status: 503, body: { error: "database_unavailable" } };
	assert.deepEqual(await ask(), refused);
	assert.deepEqual(
		await ask({ connectionString: "postgres://made-up@127.0.0.1:1/none" }),
		refused,
	);
});

test("the database check needs a signed-in partner", async () => {
	const response = await worker.request(
		"https://app.example.test/api/engine/database",
		{},
		{ CARR, DATABASE: { connectionString: url } },
	);
	assert.equal(response.status, 401);
});
