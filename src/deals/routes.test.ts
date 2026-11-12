import assert from "node:assert/strict";
import { once } from "node:events";
import { mock, test } from "node:test";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import type { DB } from "../database.d.ts";
import { readSnapshot } from "../reader.ts";
import worker from "../worker.ts";
import { readBoard } from "./board.ts";
import { readCaptureQueue } from "./capture-queue.ts";
import { readClientFit } from "./client-fit.ts";
import { readDealDetail } from "./detail.ts";

const cookie = "__Host-dealroom_session=made-up-session";
// biome-ignore lint/suspicious/noExplicitAny: test bodies are read loosely
const json = (response: Response): Promise<any> => response.json();
const signedIn = (slug: string) => ({
	fetch: async () =>
		Response.json({
			actor: { slug, display: "Example Partner" },
			csrf_token: "made-up-csrf",
		}),
});

const reads = [
	["/deals", "deal-room-board"],
	["/deals/Example", "get-deal-room"],
	["/client-fit", "ideal-client-profile"],
	["/capture-queue", "capture-queue"],
	["/find?query=Example", "find"],
	["/invoices", "read-invoice-tracker"],
] as const;
const failedRead = (verb: string) => ({
	error: "unhandled_verb_failure",
	hint: "The operation failed. Quote the correlation_id when reporting it.",
	verb,
});

async function refused(
	response: Response,
	status: number,
	expected: Record<string, unknown>,
): Promise<void> {
	assert.equal(response.status, status);
	const text = await response.text();
	const { correlation_id } = JSON.parse(text);
	assert.match(correlation_id, /^[0-9a-f-]{36}$/);
	const { error, ...rest } = expected;
	assert.equal(text, JSON.stringify({ error, correlation_id, ...rest }));
}

async function seed(url: string) {
	// pg.Pool's end() resolves before its sockets close, and withSnapshot's
	// forced drop would then kill a still-open connection with an error nothing
	// listens for. Closing waits for every connection to end.
	const pool = new pg.Pool({ connectionString: url });
	const closed: Promise<unknown>[] = [];
	pool.on("connect", (client) => closed.push(once(client, "end")));
	const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
	const close = async () => {
		await db.destroy();
		await Promise.all(closed);
	};
	try {
		const actor = await db
			.insertInto("actor")
			.values({
				slug: "routes-agent",
				kind: "human",
				display_name: "Example A",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const audit = { created_by: actor.id, updated_by: actor.id };
		await db
			.insertInto("contact_state")
			.values({ slug: "active", label: "Example", contactable: true, sort: 1 })
			.execute();
		await db
			.insertInto("client_status")
			.values({ slug: "routes-active", label: "Example active" })
			.execute();
		await db
			.insertInto("deal_type_ref")
			.values({ slug: "routes-lease", label: "Example lease", sort: 1 })
			.execute();
		await db
			.insertInto("deal_phase")
			.values({ slug: "routes-open", label: "Example open" })
			.execute();
		const party = (name: string) =>
			db
				.insertInto("party")
				.values({ kind: "person", name, ...audit })
				.returning("id")
				.executeTakeFirstOrThrow();
		const client = await db
			.insertInto("client")
			.values({
				party_id: (await party("Dr. Ada Example (Example Clinic)")).id,
				status: "routes-active",
				roster_ref: "C-9001",
				...audit,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const deal = (name: string) =>
			db
				.insertInto("deal")
				.values({
					client_id: client.id,
					name,
					deal_type: "routes-lease",
					phase: "routes-open",
					...audit,
				})
				.returning("id")
				.executeTakeFirstOrThrow();
		const first = await deal("Example Route Deal");
		await deal("Example Route/Slash Deal");
		await deal("Example Twin Deal A");
		await deal("Example Twin Deal B");
		const other = await db
			.insertInto("actor")
			.values({
				slug: "routes-other",
				kind: "human",
				display_name: "Example B",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const session = async (started_by: string) =>
			(
				await db
					.insertInto("deal_review_session")
					.values({ workspace_kind: "team", started_by })
					.returning("id")
					.executeTakeFirstOrThrow()
			).id;
		const sessions = {
			"routes-agent": await session(actor.id),
			"routes-other": await session(other.id),
		};
		await sql`with s as (insert into capture_session (nonce, device_id, actor_id,
			mode, started_at, consent_announced_at, session_token_hash, expires_at, state_at)
			values ('example-nonce', 'example-device', ${actor.id}, 'meeting', now(), now(),
			'example-hash', now() + interval '1 hour', now()) returning id)
			insert into capture_candidate (session_id, idempotency_key, batch_hash,
			item_index, kind, payload, evidence_quote, confidence)
			select id, 'example-key', 'example-batch', 0, 'next_step',
			${JSON.stringify({ deal: first.id })}, 'Example quote', 0.75 from s`.execute(
			db,
		);
		const survivor = await db
			.insertInto("client")
			.values({ party_id: (await party("Example Survivor")).id, ...audit })
			.returning("id")
			.executeTakeFirstOrThrow();
		return {
			deal: first.id,
			sessions,
			mergeClient: () =>
				db
					.updateTable("client")
					.set({ merged_into: survivor.id })
					.where("id", "=", client.id)
					.execute(),
			// Each win is its own group, so the count crosses the old group limit.
			addWins: async (from: number, to: number) => {
				await db
					.insertInto("deal_phase")
					.values({ slug: "closed", label: "Example closed" })
					.onConflict((c) => c.doNothing())
					.execute();
				await sql`insert into deal (client_id, name, deal_type, phase, outcome,
					closed_on, city, created_by, updated_by)
					select ${survivor.id}, 'Example Win ' || n, 'routes-lease', 'closed',
					'won', '2024-05-01', 'Example City ' || n, ${actor.id}, ${actor.id}
					from generate_series(${from}::int, ${to}::int) n`.execute(db);
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}

test("the deals routes answer from one snapshot and refuse like the old system", async (t) => {
	await withSnapshot(async (url) => {
		const rows = await seed(url);
		const get = (path: string, slug = "routes-agent") =>
			worker.request(
				`https://app.example.test/api/engine${path}`,
				{ headers: { Cookie: cookie } },
				{ CARR: signedIn(slug), DATABASE: { connectionString: url } },
			);
		const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
		try {
			await t.test(
				"a signed-in partner gets the board and the deal",
				async () => {
					for (const query of ["", "?workspace=team", "?workspace=all"]) {
						const response = await get(`/deals${query}`);
						assert.equal(response.status, 200);
						assert.equal(response.headers.get("Cache-Control"), "no-store");
						assert.match(
							response.headers.get("Server-Timing") ?? "",
							/^db;dur=\d/,
						);
						const workspace = new URLSearchParams(query).get("workspace");
						const board = await json(response);
						if (!query)
							assert.ok(
								board.deals.some((d: { id: string }) => d.id === rows.deal),
							);
						assert.deepEqual(
							board,
							plain(
								await readSnapshot(url, (db) =>
									readBoard(db, {
										partner: "routes-agent",
										workspace: workspace as "team" | null,
									}),
								),
							),
						);
					}
					const detail = await readSnapshot(url, (db) =>
						readDealDetail(db, rows.deal),
					);
					assert.ok(!("error" in detail));
					const response = await get(`/deals/${rows.deal}`);
					assert.equal(response.status, 200);
					assert.equal(response.headers.get("Cache-Control"), "no-store");
					assert.match(
						response.headers.get("Server-Timing") ?? "",
						/^db;dur=\d/,
					);
					assert.deepEqual(await response.json(), plain(detail));
					const slashed = await get(
						`/deals/${encodeURIComponent("Example Route/Slash Deal")}`,
					);
					assert.equal(slashed.status, 200);
					assert.equal((await json(slashed)).name, "Example Route/Slash Deal");
				},
			);

			await t.test("a signed-in partner gets the capture queue", async () => {
				const response = await get("/capture-queue");
				assert.equal(response.status, 200);
				assert.equal(response.headers.get("Cache-Control"), "no-store");
				const text = await response.text();
				assert.match(
					text,
					/"confidence":0\.75,"deal_name":"Example Route Deal"/,
				);
				assert.equal(
					text,
					JSON.stringify(await readSnapshot(url, readCaptureQueue)),
				);
			});

			await t.test(
				"a partner with no actor record is refused for every read",
				async () => {
					const expected = {
						error: "unauthenticated",
						hint: "The authenticated actor could not be resolved.",
					};
					await refused(await get("/deals", "no-such-partner"), 422, expected);
					await refused(
						await get(`/deals/${rows.deal}`, "no-such-partner"),
						422,
						expected,
					);
					for (const path of ["/client-fit", "/capture-queue", "/invoices"])
						await refused(await get(path, "no-such-partner"), 422, expected);
				},
			);

			await t.test("bad board input refuses with the old payload", async () => {
				for (const workspace of ["", "everyone"])
					await refused(await get(`/deals?workspace=${workspace}`), 400, {
						error: "value_not_in_declared_vocabulary",
						hint: "Use a value from the field's documented vocabulary.",
						allowed_values: ["team", "national_account", "all"],
						fields: ["workspace"],
					});
				await refused(await get("/deals?account_client_id=not-a-uuid"), 400, {
					error: "database_refused_the_statement",
					hint: "The operation could not be completed. Quote the correlation_id when reporting it.",
				});
			});

			await t.test(
				"each partner's board carries their own open review session",
				async () => {
					for (const [slug, id] of Object.entries(rows.sessions)) {
						const board = await json(await get("/deals", slug));
						assert.equal(board.open_session?.session_id, id);
					}
				},
			);

			await t.test(
				"each deal refusal maps to its status and old payload",
				async () => {
					await refused(await get("/deals/No%20Such%20Example"), 404, {
						error: "unhandled_verb_failure",
						hint: "The operation failed. Quote the correlation_id when reporting it.",
					});
					await refused(await get("/deals/"), 400, {
						error: "missing_required",
						hint: "Supply the named required fields from the tool's documented input.",
						fields: ["deal"],
					});
					await refused(await get("/deals/C-9001"), 422, {
						error: "not_a_deal",
						hint: "Choose a deal record, not a client or lead.",
					});
					const twins = await get("/deals/Example%20Twin");
					assert.equal(twins.status, 409);
					const { candidates, correlation_id, ...rest } = await json(twins);
					assert.match(correlation_id, /^[0-9a-f-]{36}$/);
					assert.deepEqual(rest, {
						error: "needs_disambiguation",
						hint: "Choose an exact record reference from the candidates before retrying.",
					});
					assert.deepEqual(
						candidates.map((c: { name: string }) => c.name).sort(),
						["Example Twin Deal A", "Example Twin Deal B"],
					);
					assert.deepEqual(candidates[0], {
						name: candidates[0].name,
						phase: "routes-open",
						client_ref: "C-9001",
					});
					await rows.mergeClient();
					await refused(await get(`/deals/${rows.deal}`), 404, {
						error: "not_found",
						hint: "The requested record was not found.",
					});
				},
			);

			await t.test(
				"the client fit answers with its filters and refuses past 1000 groups",
				async () => {
					await rows.addWins(1, 2);
					const everything = { vertical: null, city: null, state: null };
					for (const [query, filters] of [
						["", everything],
						[
							"?vertical=&city=Example%20City%202",
							{ ...everything, city: "Example City 2" },
						],
					] as const) {
						const response = await get(`/client-fit${query}`);
						assert.equal(response.status, 200);
						assert.equal(response.headers.get("Cache-Control"), "no-store");
						assert.deepEqual(
							await response.text(),
							JSON.stringify(
								await readSnapshot(url, (db) => readClientFit(db, filters)),
							),
						);
					}
					await rows.addWins(3, 1000);
					assert.equal((await get("/client-fit")).status, 200);
					await rows.addWins(1001, 1001);
					await refused(await get("/client-fit"), 422, {
						error: "unhandled_verb_failure",
						hint: "The operation failed. Quote the correlation_id when reporting it.",
					});
				},
			);
		} finally {
			await rows.close();
		}
	});
});

test("without a database binding every read answers 503", async () => {
	for (const [path, verb] of reads) {
		const response = await worker.request(
			`https://app.example.test/api/engine${path}`,
			{ headers: { Cookie: cookie } },
			{ CARR: signedIn("routes-agent") },
		);
		assert.equal(response.headers.get("Cache-Control"), "no-store");
		await refused(response, 503, failedRead(verb));
	}
});

test("a request with no session is refused before any read", async () => {
	let sessionChecks = 0;
	for (const [path] of reads) {
		const response = await worker.request(
			`https://app.example.test/api/engine${path}`,
			{},
			{
				CARR: {
					fetch: async () => {
						sessionChecks++;
						return Response.json({});
					},
				},
				DATABASE: { connectionString: "postgres://made-up@127.0.0.1:1/none" },
			},
		);
		assert.equal(response.status, 401);
		assert.equal(response.headers.get("Cache-Control"), "no-store");
		assert.equal(
			await response.text(),
			'{"error":"unauthorized","state":"sign_in_required"}',
		);
	}
	assert.equal(sessionChecks, 0);
});

test("a failed read answers a fixed body and logs no input", async () => {
	const warnings = mock.method(console, "warn", () => {});
	const secrets = [
		"Secret Example Name",
		"0f0e0d0c-0b0a-4908-8706-050403020100",
	] as const;
	try {
		for (const [path, verb] of [
			[`/deals?account_client_id=${secrets[1]}`, "deal-room-board"],
			[`/deals/${encodeURIComponent(secrets[0])}`, "get-deal-room"],
			...reads.slice(2),
		]) {
			const response = await worker.request(
				`https://app.example.test/api/engine${path}`,
				{ headers: { Cookie: cookie } },
				{
					CARR: signedIn("routes-agent"),
					DATABASE: { connectionString: "postgres://made-up@127.0.0.1:1/none" },
				},
			);
			assert.equal(response.headers.get("Cache-Control"), "no-store");
			await refused(response, 500, failedRead(verb));
		}
		assert.deepEqual(
			warnings.mock.calls.map((call) => call.arguments),
			reads.map(() => ["read failed:", "Error"]),
		);
		const logged = JSON.stringify(warnings.mock.calls.map((c) => c.arguments));
		for (const secret of secrets) assert.ok(!logged.includes(secret));
	} finally {
		warnings.mock.restore();
	}
});
