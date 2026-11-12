import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { askers, pause } from "./ask.ts";
import { type Ask, StopRun } from "./run.ts";

const app = new URL("https://app.example.test");
const session = "made-up-session-value";
const deal = "00000000-0000-4000-8000-000000000001";
const board: Ask = { read: "board", workspace: "national_account" };
const detail: Ask = { read: "deal", deal };
const fit: Ask = { read: "client fit" };
const queue: Ask = { read: "capture queue" };

type Sent = { url: URL; init: RequestInit };

function fake(respond: (sent: Sent) => Response) {
	const sent: Sent[] = [];
	const ask = askers(app, session, async (url, init) => {
		sent.push({ url, init });
		return respond({ url, init });
	});
	return { ...ask, sent };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const rpc = (result: object) => json({ jsonrpc: "2.0", id: 1, result });
const content = (body: unknown, isError?: true) =>
	rpc({ content: [{ type: "text", text: JSON.stringify(body) }], isError });
const header = (sent: Sent, name: string) =>
	new Headers(sent.init.headers).get(name);

test("asks the engine's board by workspace, a deal by its reference, the client fit and the capture queue, on the app's host with the session", async () => {
	const { askEngine, sent } = fake(() => json({ made_up: true }));
	assert.deepEqual(await askEngine(board), { made_up: true });
	await askEngine(detail);
	await askEngine(fit);
	await askEngine(queue);
	assert.deepEqual(
		sent.map((s) => s.url.href),
		[
			"https://app.example.test/api/engine/deals?workspace=national_account",
			`https://app.example.test/api/engine/deals/${deal}`,
			"https://app.example.test/api/engine/client-fit",
			"https://app.example.test/api/engine/capture-queue",
		],
	);
	for (const s of sent) {
		assert.equal(header(s, "cookie"), `__Host-dealroom_session=${session}`);
		assert.equal(s.init.method ?? "GET", "GET");
		assert.equal(s.init.redirect, "manual");
	}
});

test("asks the old system through the same host with the session and the app's origin", async () => {
	const { askOld, sent } = fake(() => content({ made_up: true }));
	assert.deepEqual(await askOld(board), { made_up: true });
	await askOld(detail);
	await askOld(fit);
	await askOld(queue);
	assert.deepEqual(
		sent.map((s) => [s.url.href, s.init.method]),
		[
			["https://app.example.test/mcp", "POST"],
			["https://app.example.test/mcp", "POST"],
			["https://app.example.test/mcp", "POST"],
			["https://app.example.test/mcp", "POST"],
		],
	);
	assert.deepEqual(
		sent.map((s) => JSON.parse(String(s.init.body)).params),
		[
			{ name: "deal-room-board", arguments: { workspace: "national_account" } },
			{ name: "get-deal-room", arguments: { deal } },
			{ name: "ideal-client-profile", arguments: {} },
			{ name: "capture-queue", arguments: {} },
		],
	);
	for (const s of sent) {
		assert.equal(header(s, "cookie"), `__Host-dealroom_session=${session}`);
		assert.equal(header(s, "origin"), "https://app.example.test");
	}
});

test("reads the old answer from the last data line of an event stream", async () => {
	const { askOld } = fake(
		() =>
			new Response(
				`event: message\ndata: ${JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: { content: [{ type: "text", text: '{"deals":[]}' }] },
				})}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	assert.deepEqual(await askOld(board), { deals: [] });
});

test("a refused deal is compared as its refusal without the correlation ID, on either side", async () => {
	const refused = {
		error: "not_found",
		hint: "The requested record was not found.",
		correlation_id: "00000000-0000-4000-8000-000000000900",
	};
	const expected = {
		error: "not_found",
		hint: "The requested record was not found.",
	};
	assert.deepEqual(
		await fake(() => content(refused, true)).askOld(detail),
		expected,
	);
	assert.deepEqual(
		await fake(() => json(refused, 404)).askEngine(detail),
		expected,
	);
});

test("a refused board fails its read instead of comparing as an empty board", async () => {
	const refused = { error: "unauthenticated", correlation_id: "made-up" };
	for (const ask of [
		fake(() => content(refused, true)).askOld,
		fake(() => json(refused, 422)).askEngine,
	])
		await assert.rejects(
			ask(board),
			(error: Error) => !(error instanceof StopRun),
		);
});

test("a network or sign-in failure stops the run, and no failure shows the session", async () => {
	const failures: (() => Response)[] = [
		() => {
			throw new TypeError(`fetch failed ${session}`);
		},
		() => json({ error: "unauthorized" }, 401),
		() => new Response(null, { status: 302, headers: { location: "/login" } }),
	];
	for (const respond of failures)
		for (const ask of [fake(respond).askEngine, fake(respond).askOld])
			await assert.rejects(
				ask(detail),
				(error: Error) =>
					error instanceof StopRun && !error.message.includes(session),
			);
	for (const ask of [
		fake(() => json({ error: "read_failed" }, 500)).askEngine,
		fake(() => json({ error: "made-up" }, 500)).askOld,
	])
		await assert.rejects(
			ask(detail),
			(error: Error) =>
				!(error instanceof StopRun) && !error.message.includes(session),
		);
});

test("pauses one and a half seconds between asks", async (t) => {
	mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => mock.timers.reset());
	let done = false;
	const paused = pause().then(() => {
		done = true;
	});
	mock.timers.tick(1499);
	await Promise.resolve();
	assert.equal(done, false);
	mock.timers.tick(1);
	await paused;
	assert.equal(done, true);
});

const feedAsk: Ask = { read: "feed", start: "made-up-start" };
const events = (from: number, count: number) =>
	Array.from({ length: count }, (_, i) => ({ id: `event-${from + i}` }));
const feedPage = (body: { events: object[]; cursor: string }) =>
	json({ ...body, presence: [{ actor: "a" }], capture_sessions: [{}] });

test("pages each side's feed from the start with that side's cursors until a short page, keeping only events and cursors", async () => {
	const last = { events: events(400, 3), cursor: "c3" };
	const pages = new Map([
		["made-up-start", { events: events(0, 200), cursor: "c1" }],
		["c1", { events: events(200, 200), cursor: "c2" }],
		["c2", last],
	]);
	const sides = [
		["askEngine", "/api/engine/pipeline/changes"],
		["askOld", "/pipeline/changes"],
	] as const;
	for (const [side, path] of sides) {
		const asked = fake(({ url }) =>
			feedPage(pages.get(url.searchParams.get("cursor") ?? "") ?? last),
		);
		assert.deepEqual(await asked[side](feedAsk), {
			events: events(0, 403),
			cursors: ["c1", "c2", "c3"],
		});
		assert.deepEqual(
			asked.sent.map((s) => [s.url.pathname, s.url.searchParams.get("cursor")]),
			[
				[path, "made-up-start"],
				[path, "c1"],
				[path, "c2"],
			],
		);
		for (const s of asked.sent) {
			assert.equal(header(s, "cookie"), `__Host-dealroom_session=${session}`);
			assert.equal(s.init.method ?? "GET", "GET");
		}
	}
});

test("a full last page is followed by one more request, which hands back its cursor", async () => {
	const { askOld, sent } = fake(({ url }) =>
		url.searchParams.get("cursor") === "c1"
			? feedPage({ events: [], cursor: "c1" })
			: feedPage({ events: events(0, 200), cursor: "c1" }),
	);
	assert.deepEqual(await askOld(feedAsk), {
		events: events(0, 200),
		cursors: ["c1", "c1"],
	});
	assert.equal(sent.length, 2);
});

test("an unavailable feed or one that never ends fails its read without stopping the run", async () => {
	const unavailable = () =>
		json({ error: "database_unavailable", correlation_id: "made-up" }, 503);
	const endless = () => feedPage({ events: events(0, 200), cursor: "c1" });
	for (const respond of [unavailable, endless])
		for (const ask of [fake(respond).askEngine, fake(respond).askOld])
			await assert.rejects(
				ask(feedAsk),
				(error: Error) => !(error instanceof StopRun),
			);
	const { askEngine, sent } = fake(endless);
	await assert.rejects(askEngine(feedAsk));
	assert.equal(sent.length, 25);
});
