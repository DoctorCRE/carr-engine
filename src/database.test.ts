import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { DB } from "./database.d.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url)
	throw new Error("Run npm run check to restore the test database first");
const db = new Kysely<DB>({
	dialect: new PostgresDialect({
		pool: new pg.Pool({ connectionString: url }),
	}),
});

test("business rows use the copied constraints and touch triggers", async () => {
	try {
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
			where n.nspname in ('public') and not exists
			(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
		`.execute(db);
		assert.deepEqual(inventory.rows, [
			{ tables: 102, views: 51, sequences: 6, triggers: 32 },
		]);
		assert.equal(
			(await db.selectFrom("party").selectAll().execute()).length,
			0,
		);
		assert.equal((await db.selectFrom("deal").selectAll().execute()).length, 0);
		await db.transaction().execute(async (tx) => {
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
			await sql`set constraints all immediate`.execute(tx);
		});
		await assert.rejects(
			db
				.insertInto("party")
				.values({
					kind: "invalid",
					name: "Example Invalid",
					created_by: "00000000-0000-0000-0000-000000000000",
					updated_by: "00000000-0000-0000-0000-000000000000",
				})
				.execute(),
			{ code: "23514" },
		);
	} finally {
		await db.destroy();
	}
});

test("drift compares catalogs read-only and prints object names", async () => {
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
		await target.query(
			`ALTER TABLE public.party ADD COLUMN example_drift text;
			ALTER TABLE public.party ADD CONSTRAINT example_drift_check CHECK (example_drift <> 'example');
			CREATE INDEX example_drift_index ON public.party(example_drift);
			ALTER TABLE public.party DISABLE TRIGGER party_touch;
			CREATE OR REPLACE FUNCTION public.trg_touch_row() RETURNS trigger LANGUAGE plpgsql AS $$ begin return new; end $$;`,
		);
	} finally {
		await target.end();
	}
	const drift = run();
	assert.equal(drift.status, 1, drift.stderr);
	assert.equal(drift.stdout, "public.party\npublic.trg_touch_row()\n");
});
