import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { withSnapshot } from "../scripts/test-database.ts";
import type { DB } from "./database.d.ts";
import { readBoard } from "./deals/board.ts";
import { readCaptureQueue } from "./deals/capture-queue.ts";
import { readChanges } from "./deals/changes.ts";
import { readClientFit } from "./deals/client-fit.ts";
import { readDealDetail } from "./deals/detail.ts";
import { readLeadBoard } from "./leads/board.ts";
import { readQuietFollowUps } from "./leads/quiet-follow-ups.ts";
import { readReasonsToReachOut } from "./leads/reasons-to-reach-out.ts";
import { type Reader, readSnapshot } from "./reader.ts";
import { readFind } from "./search/find.ts";
import { url } from "./test-rollback.ts";

// The engine login's whole read grant: every relation the engine's reads
// name. The views read their tables with their owner's rights.
const readable = [
	"actor",
	"client",
	"commission",
	"deal",
	"doctrine_section",
	"lead",
	"next_action",
	"party",
	"practice_origination_event",
	"practice_origination_feed",
	"v_capture_candidate_queue",
	"v_capture_session_status",
	"v_client_account",
	"v_client_engagement_status",
	"v_deal_board",
	"v_deal_client_portal",
	"v_deal_reconciliation_read",
	"v_deal_room_account",
	"v_deal_room_action",
	"v_deal_room_activity",
	"v_deal_room_board",
	"v_deal_room_critical_date",
	"v_deal_room_current_lease",
	"v_deal_room_document",
	"v_deal_room_event",
	"v_deal_room_negotiation",
	"v_deal_room_note",
	"v_deal_room_participant",
	"v_deal_room_phase_change",
	"v_deal_room_phase_start",
	"v_deal_room_premises",
	"v_deal_room_presence",
	"v_deal_room_session",
	"v_deal_room_vendor",
	"v_last_touch",
	"v_lead_client_best",
	"v_lead_prospect_engagement",
	"v_lead_workspace",
	"v_lead_workspace_correspondence",
	"v_open_deal_room_board",
	"v_party_graph",
	"v_practice_origination_party_address",
	"v_record_flag_subject",
	"v_ref_index",
	"v_requirement_request",
	"vendor",
];

async function withAdmin<T>(
	run: (admin: pg.Client) => Promise<T>,
	connectionString = url,
) {
	const admin = new pg.Client({ connectionString });
	await admin.connect();
	try {
		return await run(admin);
	} finally {
		await admin.end();
	}
}

async function withReaderLogin(
	database: string,
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
			// Production revoked PUBLIC's right to call this one.
			await admin.query(
				"REVOKE EXECUTE ON FUNCTION public.practice_address_key(text) FROM PUBLIC",
			);
			await admin.query(
				`GRANT EXECUTE ON FUNCTION public.practice_address_key(text) TO ${name}`,
			);
			const login = new URL(database);
			login.username = name;
			await run(login.href, name);
		} finally {
			await admin.query(`DROP OWNED BY ${name}`);
			await admin.query(`DROP ROLE ${name}`);
		}
	}, database);
}

async function seedDeal(database: string) {
	const pool = new pg.Pool({ connectionString: database });
	const closed: Promise<unknown>[] = [];
	pool.on("connect", (client) => closed.push(once(client, "end")));
	const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
	try {
		return await db.transaction().execute(async (tx) => {
			const actor = await tx
				.insertInto("actor")
				.values({
					slug: "reader-agent",
					kind: "human",
					display_name: "Example",
				})
				.returning(["id", "slug"])
				.executeTakeFirstOrThrow();
			const audit = { created_by: actor.id, updated_by: actor.id };
			await tx
				.insertInto("contact_state")
				.values({
					slug: "active",
					label: "Example",
					contactable: true,
					sort: 1,
				})
				.execute();
			await tx
				.insertInto("deal_type_ref")
				.values({ slug: "reader-lease", label: "Example", sort: 1 })
				.execute();
			await tx
				.insertInto("deal_phase")
				.values({ slug: "reader-open", label: "Example" })
				.execute();
			const party = await tx
				.insertInto("party")
				.values({ kind: "org", name: "Example Clinic", ...audit })
				.returning("id")
				.executeTakeFirstOrThrow();
			const client = await tx
				.insertInto("client")
				.values({ party_id: party.id, ...audit })
				.returning("id")
				.executeTakeFirstOrThrow();
			const deal = await tx
				.insertInto("deal")
				.values({
					client_id: client.id,
					name: "Example Reader Deal",
					deal_type: "reader-lease",
					phase: "reader-open",
					owner: actor.slug,
					next_date: "2030-01-15",
					...audit,
				})
				.returning("id")
				.executeTakeFirstOrThrow();
			await tx
				.insertInto("deal_note")
				.values({
					deal_id: deal.id,
					kind: "note",
					text: "Example reader note",
					actor_id: actor.id,
				})
				.execute();
			await sql`with s as (insert into capture_session (nonce, device_id, actor_id,
				mode, started_at, consent_announced_at, session_token_hash, expires_at, state_at)
				values ('example-nonce', 'example-device', ${actor.id}, 'meeting', now(), now(),
				'example-hash', now() + interval '1 hour', now()) returning id)
				insert into capture_candidate (session_id, idempotency_key, batch_hash,
				item_index, kind, payload, evidence_quote, confidence)
				select id, 'example-key', 'example-batch', 0, 'next_step',
				${JSON.stringify({ deal: deal.id })}, 'Example quote', 1 from s`.execute(
				tx,
			);
			return { actor: actor.slug, deal: deal.id };
		});
	} finally {
		await db.destroy();
		await Promise.all(closed);
	}
}

test("the reader login reads the board, a deal, the client fit, the change feed, the capture queue, search, the lead board, quiet follow-ups and reasons to reach out and changes nothing", () =>
	withSnapshot(async (database) => {
		const seeded = await seedDeal(database);
		await withReaderLogin(database, async (login, name) => {
			const board = await readSnapshot(login, (db) =>
				readBoard(db, { partner: seeded.actor, workspace: "all" }),
			);
			assert.deepEqual(
				board.deals.map((d) => [d.id, d.name, d.next_date]),
				[[seeded.deal, "Example Reader Deal", "2030-01-15"]],
			);
			const detail = await readSnapshot(login, (db) =>
				readDealDetail(db, seeded.deal),
			);
			assert.ok("deal_id" in detail, JSON.stringify(detail));
			assert.equal(detail.deal_id, seeded.deal);
			assert.deepEqual(
				detail.thread.map((n) => n.text),
				["Example reader note"],
			);
			const fit = await readSnapshot(login, (db) =>
				readClientFit(db, { vertical: null, city: null, state: null }),
			);
			assert.deepEqual(fit, {
				schema_version: "ideal-client-profile.v1",
				coverage: "recorded_closed_won_only",
				profiles: [],
			});
			const queue = await readSnapshot(login, readCaptureQueue);
			assert.deepEqual(
				queue.candidates.map((c) => [c.deal_name, c.confidence]),
				[["Example Reader Deal", 1]],
			);
			const changes = await readSnapshot(login, (db) =>
				readChanges(db, null, ""),
			);
			assert.deepEqual(
				{
					...changes,
					capture_sessions: changes.capture_sessions.map((s) => s.device_id),
				},
				{
					events: [],
					presence: [],
					capture_sessions: ["example-device"],
					cursor: "",
				},
			);
			const found = await readSnapshot(login, (db) => readFind(db, "Example"));
			assert.deepEqual(
				[found.parties.map((p) => p.kind), found.deals.map((d) => d.name)],
				[["client"], ["Example Reader Deal"]],
			);
			const leads = await readSnapshot(login, readLeadBoard);
			assert.deepEqual(leads.leads, []);
			const quiet = await readSnapshot(login, (db) =>
				readQuietFollowUps(db, { lead_days: 45, vendor_days: 90 }, null),
			);
			assert.deepEqual("proposals" in quiet && quiet.proposals, []);
			await withAdmin(
				(admin) =>
					admin.query(`insert into practice_origination_feed (source) values ('nppes');
						insert into practice_origination_event (source, record_key, fingerprint, npi,
							name, city, state, kind, evidence_date, date_basis, source_url, facts,
							published_on, recorded_by)
						select 'nppes', '1000000009', repeat('0', 64), '1000000009', 'Example Clinic',
							'Exampleton', 'AL', 'enumeration', '2026-01-02', 'enumeration',
							'https://example.test/1000000009', '{"address": "1 Example Way"}',
							'2026-01-02', id from actor`),
				database,
			);
			const reasons = await readSnapshot(login, (db) =>
				readReasonsToReachOut(db, { limit: 25, before_id: null }),
			);
			assert.deepEqual(
				reasons.cards.map((c) => [c.record_key, c.route]),
				[["1000000009", "research"]],
			);
			const visible = await withAdmin(
				(admin) =>
					admin.query<{ relname: string }>(
						`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
						WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p')
						AND has_table_privilege($1, c.oid, 'SELECT') ORDER BY c.relname`,
						[name],
					),
				database,
			);
			assert.deepEqual(
				visible.rows.map((r) => r.relname),
				readable,
			);
			for (const outside of [
				"capture_candidate",
				"deal_note",
				"schema_migrations",
			] as const) {
				await assert.rejects(
					readSnapshot(login, (db) =>
						db.selectFrom(outside).selectAll().execute(),
					),
					{ code: "42501" },
					outside,
				);
			}
			await withAdmin(async (client) => {
				for (const write of [
					"INSERT INTO public.deal_phase (slug, label) VALUES ('example-refused', 'Example')",
					"UPDATE public.deal SET name = 'Example' WHERE false",
					"DELETE FROM public.party WHERE false",
				]) {
					await assert.rejects(client.query(write), { code: "42501" }, write);
				}
			}, login);
		});
	}));

test("an answer reads one read-only snapshot", () =>
	withSnapshot(async (database) => {
		const slug = "example-snapshot";
		const count = (db: Reader) =>
			db
				.selectFrom("deal_phase")
				.select((eb) => eb.fn.countAll<string>().as("n"))
				.where("slug", "=", slug)
				.executeTakeFirstOrThrow();
		const seen = await readSnapshot(database, async (db) => {
			const before = await count(db);
			await withAdmin(
				(admin) =>
					admin.query(
						"INSERT INTO public.deal_phase (slug, label) VALUES ($1, 'Example')",
						[slug],
					),
				database,
			);
			return [before, await count(db)];
		});
		assert.deepEqual(seen, [{ n: "0" }, { n: "0" }]);
		assert.deepEqual(await readSnapshot(database, count), { n: "1" });
		await assert.rejects(
			readSnapshot(database, (db) =>
				db.deleteFrom("deal_phase").where("slug", "=", slug).execute(),
			),
			{ code: "25006" },
		);
		await assert.rejects(
			readSnapshot(database, (db) =>
				sql`set transaction read write`.execute(db),
			),
			{ code: "25001" },
		);
		assert.deepEqual(await readSnapshot(database, count), { n: "1" });
	}));

test("an answer closes its connection, even one the server drops", async () => {
	const key = Math.floor(Math.random() * 2 ** 31);
	await readSnapshot(url, (db) =>
		sql`select pg_advisory_lock(${key})`.execute(db),
	);
	await withAdmin(async (admin) => {
		await admin.query("SET lock_timeout = '2s'");
		await admin.query("SELECT pg_advisory_lock($1)", [key]);
	});
	await assert.rejects(
		readSnapshot(url, async (db) => {
			const { rows } = await sql<{
				pid: number;
			}>`select pg_backend_pid() as pid`.execute(db);
			await withAdmin((admin) =>
				admin.query("SELECT pg_terminate_backend($1)", [rows[0]?.pid]),
			);
			return sql`select 1`.execute(db);
		}),
	);
});

test("values come back in the old system's text forms", () =>
	withSnapshot((database) =>
		withReaderLogin(database, async (login) => {
			const row = await readSnapshot(
				login,
				async (db) =>
					(
						await sql<Record<string, unknown>>`select
				1.50::numeric as amount,
				'{1.50,NULL,9007199254740993.25}'::numeric[] as amounts,
				9007199254740993::bigint as big,
				'2026-03-08'::date as due_on,
				'{2026-03-08,NULL,2026-03-09}'::date[] as due_dates,
				'2026-03-08 07:30:00.123456+00'::timestamptz as stamp,
				'infinity'::timestamptz as forever,
				'{"2026-03-08 07:30:00.123456+00"}'::timestamptz[] as stamps,
				'2026-03-08 07:30:00.123456'::timestamp as local_stamp,
				'{"2026-03-08 07:30:00.123456"}'::timestamp[] as local_stamps,
				'2026-03-08 07:30:00.123456+00'::timestamptz::text as stamp_text,
				to_jsonb('2026-03-08 07:30:00.123456+00'::timestamptz) as stamp_json,
				jsonb_build_object('amount', 1.50::numeric, 'count', 3::bigint) as built,
				current_setting('TimeZone') as zone`.execute(db)
					).rows[0],
			);
			assert.deepEqual(row, {
				amount: "1.50",
				amounts: ["1.50", null, "9007199254740993.25"],
				big: "9007199254740993",
				due_on: "2026-03-08",
				due_dates: ["2026-03-08", null, "2026-03-09"],
				stamp: "2026-03-08 07:30:00.123456+00",
				forever: "infinity",
				stamps: ["2026-03-08 07:30:00.123456+00"],
				local_stamp: "2026-03-08 07:30:00.123456",
				local_stamps: ["2026-03-08 07:30:00.123456"],
				stamp_text: "2026-03-08 07:30:00.123456+00",
				stamp_json: "2026-03-08T07:30:00.123456+00:00",
				built: { amount: 1.5, count: 3 },
				zone: "UTC",
			});
		}),
	));
