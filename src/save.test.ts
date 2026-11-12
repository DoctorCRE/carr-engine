import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "kysely";
import { withSnapshot } from "../scripts/test-database.ts";
import type { JsonObject } from "./database.d.ts";
import { connect } from "./reader.ts";
import {
	type Change,
	runSave,
	type Save,
	SaveRefusal,
	type Saving,
} from "./save.ts";

const save = (args: JsonObject, partner = "partner_one"): Save => ({
	partner,
	verb: "example-save",
	args,
	correlation_id: randomUUID(),
});
const refused = (error: string) => (thrown: unknown) =>
	thrown instanceof SaveRefusal && thrown.answer.error === error;
const unreachable = () => assert.fail("the change ran");
const subject = (saving: Saving) => ({
	subject_type: "actor",
	subject_id: saving.actor_id,
});

test("saves", (t) =>
	withSnapshot(async (database) => {
		const db = connect(database);
		t.after(() => db.destroy());
		const run = (request: Save, change: Change) =>
			runSave(database, request, change);
		const stored = async (key: string) =>
			(
				await sql<{ events: number; receipts: number }>`select
				(select count(*)::int from event where idempotency_key = ${key}) as events,
				(select count(*)::int from tool_call where idempotency_key = ${key}) as receipts`.execute(
					db,
				)
			).rows[0];
		const { id: partner } = await db
			.insertInto("actor")
			.values([
				{ slug: "partner_one", kind: "human", display_name: "Example" },
				{ slug: "partner_two", kind: "human", display_name: "Example" },
			])
			.returning("id")
			.executeTakeFirstOrThrow();
		await t.test(
			"one transaction saves the change, history and answer",
			async () => {
				const key = randomUUID();
				const request = save({ idempotency_key: key });
				const answer = await run(request, async (saving) => {
					const { rows } = await sql`select
						current_setting('transaction_isolation') as isolation,
						current_setting('transaction_read_only') as read_only`.execute(
						saving.tx,
					);
					assert.deepEqual(rows, [
						{ isolation: "read committed", read_only: "off" },
					]);
					await saving.record({
						...subject(saving),
						field: "note",
						old: { note: null },
						new: { note: "Example" },
						human_quote: "Example",
						agent_rationale: "Example",
					});
					await saving.record({ ...subject(saving), human_quote: "  " });
					await saving.record({
						...subject(saving),
						verb: "other-save",
						after_lock: true,
						occurred_at: "2030-01-15T18:00:00Z",
					});
					return { ok: true };
				});
				assert.deepEqual(answer, { ok: true });
				const stamp = {
					idempotency_key: key,
					actor_id: partner,
					verb: "example-save",
					via: "dealroom-cookie",
					client_id: "dealroom-pwa",
					organization_tenant_id: "carr-internal",
					sponsoring_human_slug: "partner_one",
					personal_scope: "partner_one-personal",
					authorization_class: "verified_partner",
					correlation_id: request.correlation_id,
				};
				const events = await db
					.selectFrom("event")
					.selectAll()
					.select(
						sql<boolean>`recorded_at > min(recorded_at) over ()`.as(
							"after_lock",
						),
					)
					.where("idempotency_key", "=", key)
					.orderBy("mutation_order")
					.execute();
				const row = {
					...stamp,
					subject_type: "actor",
					subject_id: partner,
					field: null,
					old_value: null,
					new_value: null,
					cause: "automation_job",
					human_quote: null,
					agent_rationale: null,
					after_lock: false,
				};
				const start = events[0]?.recorded_at;
				assert.deepEqual(
					events.map(({ id, mutation_order, recorded_at, ...event }) => event),
					[
						{
							...row,
							occurred_at: start,
							field: "note",
							old_value: { note: null },
							new_value: { note: "Example" },
							cause: "human_stated",
							human_quote: "Example",
							agent_rationale: "Example",
						},
						{ ...row, occurred_at: start, human_quote: "  " },
						{
							...row,
							verb: "other-save",
							occurred_at: "2030-01-15 18:00:00+00",
							after_lock: true,
						},
					],
				);
				const { created_at, request_hash, ...receipt } = await db
					.selectFrom("tool_call")
					.selectAll()
					.where("idempotency_key", "=", key)
					.executeTakeFirstOrThrow();
				assert.deepEqual(receipt, { ...stamp, response: { ok: true } });
			},
		);

		await t.test("a retry replays and a reused key is refused", async () => {
			const key = randomUUID();
			const args = { idempotency_key: key, nested: { b: 2, a: 1 } };
			await run(save(args), async (saving) => {
				await saving.record(subject(saving));
				return { ok: true };
			});
			assert.deepEqual(
				await run(
					save({ nested: { a: 1, b: 2 }, idempotency_key: key }),
					unreachable,
				),
				{ replayed: true, ok: true },
			);
			for (const other of [
				save({ ...args, nested: null }),
				save(args, "partner_two"),
				{ ...save(args), verb: "other-save" },
			])
				await assert.rejects(run(other, unreachable), refused("key_reuse"));
			assert.deepEqual(await stored(key), { events: 1, receipts: 1 });
		});

		await t.test("a refusal or failure keeps nothing", async () => {
			const key = randomUUID();
			for (const [request, error] of [
				[save({}), "missing_idempotency_key"],
				[save({ idempotency_key: "example" }), "invalid_idempotency_key"],
				[save({ idempotency_key: key }, "nobody"), "actor_not_provisioned"],
			] as const)
				await assert.rejects(run(request, unreachable), refused(error));
			await assert.rejects(
				run(save({ idempotency_key: key }, "nobody"), unreachable),
				(thrown) =>
					thrown instanceof SaveRefusal &&
					thrown.answer.hint ===
						"the token authenticates as this actor but no row exists in the actor table — provision the actor before any write verb will run",
			);
			for (const failure of [
				new SaveRefusal({ error: "example" }),
				new Error("example"),
			])
				await assert.rejects(
					run(save({ idempotency_key: key }), async (saving) => {
						await saving.record(subject(saving));
						throw failure;
					}),
					failure,
				);
			assert.deepEqual(await stored(key), { events: 0, receipts: 0 });
		});

		await t.test("a concurrent retry waits, then replays", async () => {
			const request = save({ idempotency_key: randomUUID() });
			let started = () => {};
			let release = () => {};
			const running = new Promise<void>((resolve) => (started = resolve));
			const held = new Promise<void>((resolve) => (release = resolve));
			const first = run(request, async () => {
				started();
				await held;
				return { ok: true };
			});
			await running;
			const second = run(request, unreachable);
			const waiting = async (): Promise<string> => {
				const { rows } = await sql<{
					waiting: boolean;
				}>`select exists (select 1 from pg_locks
						where locktype = 'advisory' and not granted
						and database = (select oid from pg_database where datname = current_database())) as waiting`.execute(
					db,
				);
				return rows[0]?.waiting ? "waited" : waiting();
			};
			assert.equal(
				await Promise.race([waiting(), second.then(() => "settled")]),
				"waited",
			);
			release();
			assert.deepEqual(await Promise.all([first, second]), [
				{ ok: true },
				{ replayed: true, ok: true },
			]);
		});

		await t.test("an answer kept 30 days no longer replays", async () => {
			const key = randomUUID();
			await db
				.insertInto("tool_call")
				.values({
					idempotency_key: key,
					verb: "example-save",
					actor_id: partner,
					request_hash: "old",
					response: {},
					created_at: sql<string>`now() - interval '31 days'`,
				})
				.execute();
			assert.deepEqual(
				await run(save({ idempotency_key: key }), async () => ({ ok: true })),
				{ ok: true },
			);
			assert.deepEqual(await stored(key), { events: 0, receipts: 1 });
		});
	}));
