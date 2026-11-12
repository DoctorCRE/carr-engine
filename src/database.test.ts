import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { sql } from "kysely";
import pg from "pg";
import { withSnapshot } from "../scripts/test-database.ts";
import { withRollback } from "./test-rollback.ts";

test("business rows use the copied constraints and touch triggers", () =>
	withRollback(async (tx) => {
		const inventory = await sql<{
			tables: number;
			views: number;
			sequences: number;
			triggers: number;
		}>`
			select count(*) filter (where c.relkind='r')::int as tables,
			count(*) filter (where c.relkind='v')::int as views,
			count(*) filter (where c.relkind='S')::int as sequences,
			(select count(*)::int from pg_trigger where not tgisinternal) as triggers
			from pg_class c join pg_namespace n on n.oid=c.relnamespace
			where n.nspname in ('public', 'ops') and not exists
			(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
		`.execute(tx);
		assert.deepEqual(inventory.rows, [
			{ tables: 108, views: 56, sequences: 6, triggers: 33 },
		]);
		const actor = await tx
			.insertInto("actor")
			.values({
				slug: "fixture-agent",
				kind: "human",
				display_name: "Example Agent",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const audit = { created_by: actor.id, updated_by: actor.id };
		await tx
			.insertInto("contact_state")
			.values({
				slug: "active",
				label: "Example active",
				contactable: true,
				sort: 1,
			})
			.execute();
		const party = await tx
			.insertInto("party")
			.values({ kind: "org", name: "Example Clinic", ...audit })
			.returningAll()
			.executeTakeFirstOrThrow();
		const client = await tx
			.insertInto("client")
			.values({ party_id: party.id, ...audit })
			.returning("id")
			.executeTakeFirstOrThrow();
		await tx
			.insertInto("deal_type_ref")
			.values({ slug: "example-lease", label: "Example lease", sort: 1 })
			.execute();
		await tx
			.insertInto("deal_phase")
			.values({ slug: "example-open", label: "Example open" })
			.execute();
		const deal = await tx
			.insertInto("deal")
			.values({
				client_id: client.id,
				name: "Example Deal",
				deal_type: "example-lease",
				phase: "example-open",
				...audit,
			})
			.returningAll()
			.executeTakeFirstOrThrow();
		await tx
			.updateTable("party")
			.set({ name: "Example Clinic Updated", version: 99 })
			.where("id", "=", party.id)
			.execute();
		await tx
			.updateTable("deal")
			.set({ name: "Example Deal Updated", version: 99 })
			.where("id", "=", deal.id)
			.execute();
		const row = await tx
			.selectFrom("deal")
			.innerJoin("client", "client.id", "deal.client_id")
			.innerJoin("party", "party.id", "client.party_id")
			.select([
				"deal.name as deal",
				"party.name as party",
				"deal.version as dealVersion",
				"party.version as partyVersion",
			])
			.where("deal.id", "=", deal.id)
			.executeTakeFirstOrThrow();
		assert.deepEqual(row, {
			deal: "Example Deal Updated",
			party: "Example Clinic Updated",
			dealVersion: 2,
			partyVersion: 2,
		});
		const portal = (slug: string, disabled: boolean) =>
			sql`insert into ops.client_portal (slug, client_id, deal_id, password_hash, disabled_at)
				values (${slug}, ${client.id}, ${deal.id}, ${`$2b$12$${"a".repeat(53)}`},
				${disabled ? sql`now()` : null})`.execute(tx);
		await portal("example-closed", true);
		await portal("example-open", false);
		assert.deepEqual(
			await tx
				.selectFrom("v_deal_client_portal")
				.selectAll()
				.where("deal_id", "=", deal.id)
				.execute(),
			[
				{
					deal_id: deal.id,
					client_portal_url: "https://share.example.com/example-open",
				},
			],
		);
		await sql`savepoint second_portal`.execute(tx);
		await assert.rejects(portal("example-second", false), {
			code: "23505",
			constraint: "client_portal_one_active_per_deal",
		});
		await sql`rollback to savepoint second_portal`.execute(tx);
		await assert.rejects(
			tx
				.insertInto("party")
				.values({
					kind: "invalid",
					name: "Example Invalid",
					created_by: "00000000-0000-0000-0000-000000000000",
					updated_by: "00000000-0000-0000-0000-000000000000",
				})
				.execute(),
			{ code: "23514", constraint: "party_kind_check" },
		);
	}));

test("drift compares catalogs read-only and prints object names", () =>
	withSnapshot(async (url) => {
		const run = () =>
			spawnSync(process.execPath, ["scripts/schema-drift.ts"], {
				env: { ...process.env, SCHEMA_DATABASE_URL: url },
				encoding: "utf8",
			});
		const same = run();
		assert.equal(same.status, 0, same.stderr);
		assert.equal(same.stdout, "");
		const target = new pg.Client({ connectionString: url });
		await target.connect();
		try {
			const definition = await target.query<{ definition: string }>(
				"SELECT pg_get_functiondef('public.carr_is_partner_actor(uuid)'::regprocedure) AS definition",
			);
			const original = definition.rows[0]?.definition;
			assert.ok(original);
			assert.ok(original.includes("'partner_one'"));
			await target.query(
				original.replace("'partner_one'", "'example partner''s slug'"),
			);
			const literalOnly = run();
			assert.equal(literalOnly.status, 0, literalOnly.stderr);
			assert.equal(literalOnly.stdout, "");
			await target.query(
				`ALTER TABLE public.party ADD COLUMN example_drift text;
			ALTER TABLE public.party ADD CONSTRAINT example_drift_check CHECK (example_drift <> 'example');
			CREATE INDEX example_drift_index ON public.party(example_drift);
			ALTER TABLE public.party DISABLE TRIGGER party_touch;
			DROP INDEX ops.client_portal_one_active_per_deal;
			CREATE OR REPLACE FUNCTION public.trg_touch_row() RETURNS trigger LANGUAGE plpgsql AS $$ begin return new; end $$;`,
			);
		} finally {
			await target.end();
		}
		const drift = run();
		assert.equal(drift.status, 1, drift.stderr);
		assert.equal(
			drift.stdout,
			"ops.client_portal\npublic.party\npublic.trg_touch_row()\n",
		);
	}));
