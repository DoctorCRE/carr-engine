import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "kysely";
import pg from "pg";
import { type Reader, readSnapshot } from "./reader.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url)
	throw new Error("Run npm run check to restore the test database first");

// The engine login's whole read grant: the base tables behind the Deals board
// and the deal page (plan on #17). v_deal_client_portal and
// v_requirement_request join it once the test copy has them.
const readable = [
	"activity",
	"activity_kind",
	"actor",
	"attachment",
	"building",
	"capture_post_call_action",
	"client",
	"commission",
	"critical_date",
	"deal",
	"deal_market_assignment",
	"deal_note",
	"deal_participant",
	"deal_phase",
	"deal_review_item",
	"deal_review_session",
	"deal_vendor_assignment",
	"doctrine_section",
	"document",
	"event",
	"lead",
	"lease",
	"national_account_owner",
	"negotiation_round",
	"next_action",
	"party",
	"premises",
	"premises_space",
	"space",
	"vendor",
];

async function withAdmin<T>(run: (admin: pg.Client) => Promise<T>) {
	const admin = new pg.Client({ connectionString: url });
	await admin.connect();
	try {
		return await run(admin);
	} finally {
		await admin.end();
	}
}

async function withReaderLogin(
	run: (login: string, name: string) => Promise<void>,
) {
	const name = `engine_reader_${randomUUID().replaceAll("-", "")}`;
	await withAdmin(async (admin) => {
		await admin.query(`CREATE ROLE ${name} LOGIN NOINHERIT`);
		try {
			await admin.query(`ALTER ROLE ${name} SET TimeZone = 'America/Chicago'`);
			await admin.query(
				`GRANT SELECT ON ${readable.map((t) => `public.${t}`).join(", ")} TO ${name}`,
			);
			const login = new URL(url as string);
			login.username = name;
			await run(login.href, name);
		} finally {
			await admin.query(`DROP OWNED BY ${name}`);
			await admin.query(`DROP ROLE ${name}`);
		}
	});
}

test("the reader login reads only the planned tables and changes nothing", async () => {
	await withReaderLogin(async (login, name) => {
		assert.deepEqual(
			await readSnapshot(login, (db) =>
				db
					.selectFrom("deal")
					.select("id")
					.where("id", "=", randomUUID())
					.execute(),
			),
			[],
		);
		const visible = await withAdmin((admin) =>
			admin.query<{ relname: string }>(
				`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p')
				AND has_table_privilege($1, c.oid, 'SELECT') ORDER BY c.relname`,
				[name],
			),
		);
		assert.deepEqual(
			visible.rows.map((r) => r.relname),
			readable,
		);
		await assert.rejects(
			readSnapshot(login, (db) =>
				db.selectFrom("schema_migrations").selectAll().execute(),
			),
			{ code: "42501" },
		);
		const client = new pg.Client({ connectionString: login });
		await client.connect();
		try {
			for (const write of [
				"INSERT INTO public.deal_phase (slug, label) VALUES ('example-refused', 'Example')",
				"UPDATE public.deal SET name = 'Example' WHERE false",
				"DELETE FROM public.party WHERE false",
			]) {
				await assert.rejects(client.query(write), { code: "42501" }, write);
			}
		} finally {
			await client.end();
		}
	});
});

test("an answer reads one read-only snapshot", async () => {
	const slug = `example-${randomUUID()}`;
	const count = (db: Reader) =>
		db
			.selectFrom("deal_phase")
			.select((eb) => eb.fn.countAll<string>().as("n"))
			.where("slug", "=", slug)
			.executeTakeFirstOrThrow();
	try {
		const seen = await readSnapshot(url, async (db) => {
			const before = await count(db);
			await withAdmin((admin) =>
				admin.query(
					"INSERT INTO public.deal_phase (slug, label) VALUES ($1, 'Example')",
					[slug],
				),
			);
			return [before, await count(db)];
		});
		assert.deepEqual(seen, [{ n: "0" }, { n: "0" }]);
		assert.deepEqual(await readSnapshot(url, count), { n: "1" });
		await assert.rejects(
			readSnapshot(url, (db) =>
				db.deleteFrom("deal_phase").where("slug", "=", slug).execute(),
			),
			{ code: "25006" },
		);
		assert.deepEqual(await readSnapshot(url, count), { n: "1" });
	} finally {
		await withAdmin((admin) =>
			admin.query("DELETE FROM public.deal_phase WHERE slug = $1", [slug]),
		);
	}
});

test("values come back in the old system's text forms", async () => {
	await withReaderLogin(async (login) => {
		const row = await readSnapshot(
			login,
			async (db) =>
				(
					await sql<Record<string, unknown>>`select
				1.50::numeric as amount,
				9007199254740993::bigint as big,
				'2026-03-08'::date as due_on,
				'2026-03-08 07:30:00.123456+00'::timestamptz::text as stamp_text,
				to_jsonb('2026-03-08 07:30:00.123456+00'::timestamptz) as stamp_json,
				jsonb_build_object('amount', 1.50::numeric, 'count', 3::bigint) as built,
				'2026-03-08 07:30:00.123+00'::timestamptz as stamp,
				current_setting('TimeZone') as zone`.execute(db)
				).rows[0],
		);
		assert.deepEqual(row, {
			amount: "1.50",
			big: "9007199254740993",
			due_on: "2026-03-08",
			stamp_text: "2026-03-08 07:30:00.123456+00",
			stamp_json: "2026-03-08T07:30:00.123456+00:00",
			built: { amount: 1.5, count: 3 },
			stamp: new Date("2026-03-08T07:30:00.123Z"),
			zone: "UTC",
		});
	});
});
