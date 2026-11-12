import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { type RawBuilder, sql } from "kysely";
import { withSnapshot } from "../scripts/test-database.ts";
import { Refusal } from "./answer.ts";
import type { JsonObject } from "./database.d.ts";
import { connect } from "./reader.ts";
import {
	answerSave,
	type Change,
	runSave,
	type Save,
	SaveRefusal,
	type Saving,
	type WriterEnv,
} from "./save.ts";
import { UUID } from "./uuid.ts";

const save = (args: JsonObject, partner = "partner_one"): Save => ({
	partner,
	verb: "example-save",
	args,
	correlation_id: randomUUID(),
});
const refused = (error: string) => (thrown: unknown) =>
	thrown instanceof SaveRefusal && thrown.refusal.error === error;
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
			for (const [request, refusal] of [
				[save({}), new Refusal(400, "missing_idempotency_key")],
				[
					save({ idempotency_key: "example" }),
					new Refusal(400, "invalid_idempotency_key", {
						fields: ["idempotency_key"],
					}),
				],
				[
					save({ idempotency_key: key }, "nobody"),
					new Refusal(422, "actor_not_provisioned"),
				],
			] as const)
				await assert.rejects(run(request, unreachable), { refusal });
			for (const failure of [
				new SaveRefusal(new Refusal(400, "field_required")),
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

		await t.test(
			"a replay leaves out an answer over 16,384 characters",
			async () => {
				const whole = { ok: true, note: "x".repeat(16_363) };
				const long = {
					ok: true,
					count: 2,
					gone: null,
					deal_id: "y".repeat(200),
					summary: "y".repeat(201),
					expires_at: new Date("2030-01-15T18:00:00.000Z"),
					noted_at: "2030-01-15T18:00:00.000Z",
					nested: {},
					note: "x".repeat(16_400),
				};
				for (const [answer, replay] of [
					[whole, whole],
					[
						long,
						{
							ok: true,
							count: 2,
							gone: null,
							deal_id: long.deal_id,
							noted_at: long.noted_at,
							response_omitted: {
								chars: JSON.stringify(long).length,
								reread:
									"the write already ran; read the record for its current state",
							},
						},
					],
				] as const) {
					const request = save({ idempotency_key: randomUUID() });
					assert.deepEqual(await run(request, async () => answer), answer);
					assert.deepEqual(await run(request, unreachable), {
						replayed: true,
						...replay,
					});
				}
			},
		);

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

const DOOR = {
	verb: "example-save",
	fields: {
		idempotency_key: {},
		slug: { nullable: true },
		level: { allowed: ["first", "second"] },
		urgent: { type: "boolean" },
		count: { type: "number" },
		note: {},
		detail: { type: "object", fields: { label: {}, size: { type: "number" } } },
	},
	required: ["idempotency_key", "slug"],
} as const;

test("a save checks its door and keeps one correlation id", (t) =>
	withSnapshot(async (database) => {
		const db = connect(database);
		t.after(() => db.destroy());
		await db
			.insertInto("actor")
			.values({ slug: "partner_one", kind: "human", display_name: "Example" })
			.execute();
		const post = (body: unknown, change: Change, correlation?: string) => {
			const app = new Hono<WriterEnv>();
			app.use(async (c, next) => {
				c.set("partner", { slug: "partner_one", display: "Example" });
				await next();
			});
			app.post("/", (c) => answerSave(c, DOOR, change));
			return app.request(
				"/",
				{
					method: "POST",
					headers: correlation ? { "x-correlation-id": correlation } : {},
					body: JSON.stringify(body),
				},
				{ DATABASE_WRITER: { connectionString: database } },
			);
		};
		const answered = async (pending: Response | Promise<Response>) => {
			const response = await pending;
			const id = response.headers.get("x-correlation-id");
			assert.match(id ?? "", UUID);
			const body: JsonObject = JSON.parse(await response.text());
			return { id, status: response.status, body };
		};
		const saved = async () => ({ ok: true });
		const statement =
			(query: RawBuilder<unknown>): Change =>
			async ({ tx }) => {
				await query.execute(tx);
				return {};
			};
		const actor = (slug: string | null, kind: string | null) =>
			statement(sql`insert into actor (slug, kind, display_name)
				values (${slug}, ${kind}, 'Example')`);

		await t.test("in the old door's order", async () => {
			const vocabulary = "value_not_in_declared_vocabulary";
			for (const [body, error, fields] of [
				[
					{ level: "third", actor: "x" },
					"caller_authority_field_forbidden",
					["actor"],
				],
				[{ level: "third", other: 1 }, vocabulary, ["level"]],
				[{ level: 1 }, vocabulary, ["level"]],
				[{ slug: "x", other: 1 }, "unregistered_operation_fields", ["other"]],
				[{ urgent: "yes", count: "</count>" }, "invalid_boolean", ["urgent"]],
				[{ count: "</count>" }, "tool_call_markup_in_value", ["count"]],
				[{ count: " " }, "invalid_number", ["count"]],
				[{ detail: { label: "</label>" } }, "tool_call_markup_in_value", []],
				[{ detail: { size: "x" } }, "invalid_number", []],
				[{ note: "x" }, "missing_required", ["idempotency_key", "slug"]],
				[
					{ idempotency_key: null, slug: "x" },
					"missing_required",
					["idempotency_key"],
				],
				[
					{ idempotency_key: randomUUID(), slug: "" },
					"missing_required",
					["slug"],
				],
				[
					{ idempotency_key: "example", slug: "x" },
					"invalid_idempotency_key",
					["idempotency_key"],
				],
			] as const) {
				const answer = await answered(post(body, saved));
				const { correlation_id, hint, ...rest } = answer.body;
				assert.deepEqual(
					[answer.status, rest],
					error === vocabulary
						? [400, { error, allowed_values: ["first", "second"], fields }]
						: [
								error === "caller_authority_field_forbidden" ? 403 : 400,
								{ error, fields },
							],
				);
				assert.equal(correlation_id, answer.id);
			}
			const empty = await answered(post([], saved));
			assert.deepEqual(
				[empty.status, empty.body],
				[400, { error: "invalid_json" }],
			);
		});

		await t.test(
			"values reach the change and the request hash as their declared types",
			async () => {
				const seen: JsonObject[] = [];
				const echo: Change = async (_, args) => {
					seen.push(args);
					return { ok: true };
				};
				const key = randomUUID();
				const sent = { idempotency_key: key, slug: null, level: null };
				const first = await answered(
					post(
						{
							...sent,
							urgent: " TRUE ",
							count: " 5 ",
							detail: { size: "7", label: "x" },
						},
						echo,
					),
				);
				const retry = await answered(
					post(
						{
							...sent,
							urgent: true,
							count: 5,
							detail: { label: "x", size: 7 },
						},
						echo,
					),
				);
				assert.deepEqual(
					[first.body, retry.body],
					[{ ok: true }, { replayed: true, ok: true }],
				);
				assert.deepEqual(seen, [
					{
						...sent,
						urgent: true,
						count: 5,
						detail: { size: 7, label: "x" },
					},
				]);
			},
		);

		await t.test(
			"a statement the database refuses gets the old named refusal",
			async () => {
				t.mock.method(console, "warn", () => {});
				const key = randomUUID();
				const named = { error: "invalid_field_value", fields: ["slug"] };
				const refusedStatement = { error: "database_refused_the_statement" };
				for (const [change, status, expected] of [
					[actor(null, "human"), 400, named],
					[actor("partner_two", null), 400, refusedStatement],
					[actor("partner_one", "human"), 400, refusedStatement],
					[actor("partner_two", "robot"), 400, refusedStatement],
					[statement(sql`select 'example'::uuid`), 400, refusedStatement],
					[
						statement(
							sql`do $$ begin raise exception using errcode = '23514', column = 'label'; end $$`,
						),
						400,
						{ error: "invalid_field_value", fields: ["label"] },
					],
					[
						statement(sql`select 1 / 0`),
						500,
						{ error: "unhandled_verb_failure", verb: "example-save" },
					],
				] as const) {
					const answer = await answered(
						post({ idempotency_key: key, slug: "x" }, change),
					);
					const { correlation_id, hint, ...rest } = answer.body;
					assert.deepEqual([answer.status, rest], [status, expected]);
				}
				assert.deepEqual(
					await db
						.selectFrom("tool_call")
						.select("verb")
						.where("idempotency_key", "=", key)
						.execute(),
					[],
				);
			},
		);

		await t.test("on the answer, its receipt and the failure log", async () => {
			const given = randomUUID();
			const key = randomUUID();
			const answer = await answered(
				post({ idempotency_key: key, slug: "x" }, saved, given.toUpperCase()),
			);
			assert.deepEqual(answer, { id: given, status: 200, body: { ok: true } });
			const { correlation_id } = await db
				.selectFrom("tool_call")
				.select("correlation_id")
				.where("idempotency_key", "=", key)
				.executeTakeFirstOrThrow();
			assert.equal(correlation_id, given);
			const warn = t.mock.method(console, "warn", () => {});
			const failed = await answered(
				post(
					{ idempotency_key: randomUUID(), slug: "x" },
					async () => {
						throw new Error("example");
					},
					"example",
				),
			);
			assert.equal(failed.status, 500);
			assert.equal(failed.body.correlation_id, failed.id);
			assert.notEqual(failed.id, "example");
			assert.deepEqual(
				warn.mock.calls.map((call) => call.arguments),
				[["save failed:", failed.id, "Error"]],
			);
		});
	}));
