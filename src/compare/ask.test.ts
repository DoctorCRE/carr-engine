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
const find: Ask = { read: "find", query: "Made-up & 50%" };
const invoices: Ask = { read: "invoices" };
const client = "00000000-0000-4000-8000-000000000051";
const activity: Ask = {
	read: "recent activity",
	name: "Made-up & Co",
	record: client,
};
const lead = "00000000-0000-4000-8000-000000000031";
const leadReads: Ask[] = [
	{ read: "lead board" },
	{ read: "quiet follow-ups" },
	{ read: "territory" },
];
const opened: Ask = { read: "lead", lead };
const reasons: Ask = { read: "reasons to reach out" };

type Sent = { url: URL; init: RequestInit };

function fake(respond: (sent: Sent) => Response) {
	const sent: Sent[] = [];
	const waits: number[] = [];
	const ask = askers(
		app,
		session,
		async (url, init) => {
			sent.push({ url, init });
			return respond({ url, init });
		},
		async () => {
			waits.push(sent.length);
		},
	);
	return { ...ask, sent, waits };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const rpc = (result: object) => json({ jsonrpc: "2.0", id: 1, result });
const content = (body: unknown, isError?: true) =>
	rpc({ content: [{ type: "text", text: JSON.stringify(body) }], isError });
const failedRead = (verb: string) => ({
	error: "unhandled_verb_failure",
	correlation_id: "made-up",
	hint: "The operation failed. Quote the correlation_id when reporting it.",
	verb,
});
const header = (sent: Sent, name: string) =>
	new Headers(sent.init.headers).get(name);

test("asks the engine's board by workspace, a deal by its reference, the client fit, the capture queue, a find, the invoices and recent activity, on the app's host with the session", async () => {
	const { askEngine, sent } = fake(() => json({ made_up: true }));
	assert.deepEqual(await askEngine(board), { made_up: true });
	await askEngine(detail);
	await askEngine(fit);
	await askEngine(queue);
	await askEngine(find);
	await askEngine(invoices);
	await askEngine(activity);
	assert.deepEqual(
		sent.map((s) => s.url.href),
		[
			"https://app.example.test/api/engine/deals?workspace=national_account",
			`https://app.example.test/api/engine/deals/${deal}`,
			"https://app.example.test/api/engine/client-fit",
			"https://app.example.test/api/engine/capture-queue",
			"https://app.example.test/api/engine/find?query=Made-up+%26+50%25",
			"https://app.example.test/api/engine/invoices",
			"https://app.example.test/api/engine/recent-activity?query=Made-up+%26+Co&limit=10",
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
	await askOld(find);
	await askOld(invoices);
	await askOld(activity);
	assert.deepEqual(
		sent.map((s) => [s.url.href, s.init.method]),
		Array(7).fill(["https://app.example.test/mcp", "POST"]),
	);
	assert.deepEqual(
		sent.map((s) => JSON.parse(String(s.init.body)).params),
		[
			{ name: "deal-room-board", arguments: { workspace: "national_account" } },
			{ name: "get-deal-room", arguments: { deal } },
			{ name: "ideal-client-profile", arguments: {} },
			{ name: "capture-queue", arguments: {} },
			{ name: "find", arguments: { query: "Made-up & 50%" } },
			{ name: "read-invoice-tracker", arguments: {} },
			{
				name: "find-and-catch-up",
				arguments: { query: "Made-up & Co", limit: 10 },
			},
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
		correlation_id: "00000000-0000-4000-8000-000000000900",
		hint: "The requested record was not found.",
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
	for (const ask of [
		fake(() => content(refused, true)).askOld,
		fake(() => json(refused, 422)).askEngine,
	])
		assert.deepEqual(await ask({ read: "lead board" }), expected);
});

test("a refused board or invoices read fails instead of comparing as an empty answer", async () => {
	const refused = {
		error: "unauthenticated",
		correlation_id: "made-up",
		hint: "The authenticated actor could not be resolved.",
	};
	for (const ask of [
		fake(() => content(refused, true)).askOld,
		fake(() => json(refused, 422)).askEngine,
	])
		for (const read of [board, invoices])
			await assert.rejects(
				ask(read),
				(error: Error) => !(error instanceof StopRun),
			);
});

test("an engine find, Leads or recent activity read that fails with a server error fails that read without stopping the run", async () => {
	for (const ask of [find, ...leadReads, opened, reasons, activity])
		await assert.rejects(
			fake(() => json(failedRead("made-up"), 500)).askEngine(ask),
			(error: Error) => !(error instanceof StopRun),
		);
});

test("a network or sign-in failure stops the run, and no failure shows the session", async () => {
	const failures: (() => Response)[] = [
		() => {
			throw new TypeError(`fetch failed ${session}`);
		},
		() => json({ error: "unauthorized", state: "sign_in_required" }, 401),
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
		fake(() => json(failedRead("get-deal-room"), 500)).askEngine,
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
		json(
			{
				error: "database_unavailable",
				correlation_id: "made-up",
				hint: "The operation failed. Quote the correlation_id when reporting it.",
			},
			503,
		);
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

test("asks the Leads board, quiet follow-ups and territory with the app's inputs on both sides", async () => {
	const engine = fake(() => json({ made_up: true }));
	const old = fake(() => content({ made_up: true }));
	for (const ask of leadReads) {
		assert.deepEqual(await engine.askEngine(ask), { made_up: true });
		assert.deepEqual(await old.askOld(ask), { made_up: true });
	}
	assert.deepEqual(
		engine.sent.map((s) => s.url.href),
		[
			"https://app.example.test/api/engine/leads?workspace=leads",
			"https://app.example.test/api/engine/quiet-follow-ups",
			"https://app.example.test/api/engine/territory-state-board",
		],
	);
	assert.deepEqual(
		old.sent.map((s) => JSON.parse(String(s.init.body)).params),
		[
			{ name: "lead-board", arguments: { workspace: "leads" } },
			{ name: "quiet-follow-ups", arguments: {} },
			{ name: "territory-state-board", arguments: {} },
		],
	);
});

const mail = (n: number) => ({
	occurred_at: `2030-01-0${n}T00:00:00.12345+00:00`,
	id: `00000000-0000-4000-8000-00000000010${n}`,
});
const leadPage = (
	name: string,
	correspondence: object | null,
	stages: string | null,
) => ({
	leads: [{ id: lead }],
	detail: {
		id: lead,
		page: name,
		correspondence_page: {
			total: 250,
			has_more: correspondence !== null,
			next_cursor: correspondence,
		},
		stage_history_page: {
			total: 150,
			has_more: stages !== null,
			next_cursor: stages,
		},
	},
});
const pageAfter = (args: Record<string, unknown>) =>
	"correspondence_cursor" in args
		? JSON.stringify(args.correspondence_cursor) === JSON.stringify(mail(1))
			? leadPage("mail 2", mail(2), "150")
			: leadPage("mail 3", null, "150")
		: "stage_history_cursor" in args
			? leadPage("stages 2", mail(1), null)
			: leadPage("first", mail(1), "150");

test("an opened lead follows each side's correspondence and stage-history cursors to the last page, the correspondence cursor as JSON text to the engine", async () => {
	const expected = {
		opened: leadPage("first", mail(1), "150"),
		older_correspondence: [
			leadPage("mail 2", mail(2), "150"),
			leadPage("mail 3", null, "150"),
		],
		older_stage_history: [leadPage("stages 2", mail(1), null)],
	};
	const engine = fake(({ url }) => {
		const { workspace: _, ...args } = Object.fromEntries(url.searchParams);
		return json(
			pageAfter(
				args.correspondence_cursor
					? { correspondence_cursor: JSON.parse(args.correspondence_cursor) }
					: args,
			),
		);
	});
	assert.deepEqual(await engine.askEngine(opened), expected);
	assert.deepEqual(
		engine.sent.map((s) => [...s.url.searchParams]),
		[
			[
				["workspace", "leads"],
				["lead_id", lead],
			],
			[
				["workspace", "leads"],
				["lead_id", lead],
				["correspondence_cursor", JSON.stringify(mail(1))],
			],
			[
				["workspace", "leads"],
				["lead_id", lead],
				["correspondence_cursor", JSON.stringify(mail(2))],
			],
			[
				["workspace", "leads"],
				["lead_id", lead],
				["stage_history_cursor", "150"],
			],
		],
	);
	assert.deepEqual(engine.waits, []);

	const old = fake(({ init }) =>
		content(pageAfter(JSON.parse(String(init.body)).params.arguments)),
	);
	assert.deepEqual(await old.askOld(opened), expected);
	assert.deepEqual(
		old.sent.map((s) => JSON.parse(String(s.init.body)).params),
		[
			{ workspace: "leads", lead_id: lead },
			{ workspace: "leads", lead_id: lead, correspondence_cursor: mail(1) },
			{ workspace: "leads", lead_id: lead, correspondence_cursor: mail(2) },
			{ workspace: "leads", lead_id: lead, stage_history_cursor: "150" },
		].map((args) => ({ name: "lead-board", arguments: args })),
	);
	assert.deepEqual(old.waits, [1, 2, 3], "the old side waits before each page");
});

const cards = (before: string | null) =>
	before === null
		? { cards: [{ id: "30" }], next_cursor: "30" }
		: before === "30"
			? { cards: [{ id: "20" }], next_cursor: "20" }
			: { cards: [{ id: "10" }], next_cursor: null };

test("reasons to reach out follow next_cursor at a limit of 25 to the last page on both sides", async () => {
	const expected = { pages: [cards(null), cards("30"), cards("20")] };
	const engine = fake(({ url }) =>
		json(cards(url.searchParams.get("before_id"))),
	);
	assert.deepEqual(await engine.askEngine(reasons), expected);
	assert.deepEqual(
		engine.sent.map((s) => s.url.pathname + s.url.search),
		[
			"/api/engine/reasons-to-reach-out?limit=25",
			"/api/engine/reasons-to-reach-out?limit=25&before_id=30",
			"/api/engine/reasons-to-reach-out?limit=25&before_id=20",
		],
	);
	const old = fake(({ init }) =>
		content(
			cards(JSON.parse(String(init.body)).params.arguments.before_id ?? null),
		),
	);
	assert.deepEqual(await old.askOld(reasons), expected);
	assert.deepEqual(
		old.sent.map((s) => JSON.parse(String(s.init.body)).params),
		[
			{ limit: 25 },
			{ limit: 25, before_id: "30" },
			{ limit: 25, before_id: "20" },
		].map((args) => ({ name: "list-practice-origination", arguments: args })),
	);
});

test("pages that never end fail their read without stopping the run", async () => {
	const endless = fake(() => json({ cards: [], next_cursor: "1" }));
	await assert.rejects(
		endless.askEngine(reasons),
		(error: Error) => !(error instanceof StopRun),
	);
	assert.equal(endless.sent.length, 101);
	const stuck = fake(() => json(leadPage("first", mail(1), null)));
	await assert.rejects(
		stuck.askEngine(opened),
		(error: Error) => !(error instanceof StopRun),
	);
	assert.equal(stuck.sent.length, 26);
});

const directory: Ask[] = [{ read: "client list" }, { read: "client", client }];

test("asks the client list and a client as the app does, the old ones over HTTP at the old door's paths", async () => {
	const paths = [
		"/clients?contract=vendor-directory.v1",
		`/clients/${client}?contract=vendor-directory.v1`,
	];
	for (const [ask, prefix] of [
		["askEngine", "/api/engine"],
		["askOld", "/api/v1/business"],
	] as const) {
		const asker = fake(() => json({ made_up: true }));
		for (const read of directory)
			assert.deepEqual(await asker[ask](read), { made_up: true });
		assert.deepEqual(
			asker.sent.map((s) => [s.url.href, s.init.method ?? "GET"]),
			paths.map((path) => [`${app.origin}${prefix}${path}`, "GET"]),
		);
		for (const s of asker.sent)
			assert.equal(header(s, "cookie"), `__Host-dealroom_session=${session}`);
	}
});

test("a refused client compares as its refusal without the correlation ID, a refused list fails, and an unavailable read fails, on either side", async () => {
	const refused = {
		error: "RECORD_NOT_FOUND",
		correlation_id: "00000000-0000-4000-8000-000000000900",
	};
	for (const ask of ["askEngine", "askOld"] as const) {
		assert.deepEqual(
			await fake(() => json(refused, 404))[ask]({ read: "client", client }),
			{ error: "RECORD_NOT_FOUND" },
		);
		await assert.rejects(
			fake(() => json(refused, 404))[ask]({ read: "client list" }),
			(error: Error) => !(error instanceof StopRun),
		);
		const unprovisioned = {
			error: "DEPENDENCY_NOT_PROVISIONED",
			dependency: "read_access",
		};
		for (const read of directory)
			await assert.rejects(
				fake(() => json(unprovisioned, 503))[ask](read),
				(error: Error) => !(error instanceof StopRun),
			);
	}
});
