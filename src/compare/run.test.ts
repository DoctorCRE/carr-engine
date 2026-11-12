import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { decodeCursor } from "../deals/changes.ts";
import { report } from "./report.ts";
import { type Ask, compareDeals, exitCode, StopRun } from "./run.ts";

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [d1, d2, d3] = [uuid(1), uuid(2), uuid(3)];
const board = (deals: object[] = [{ id: d1 }, { id: d2 }]) => ({
	actor: "example",
	deals,
	closed_deals: [{ id: d3 }],
	lost_deals: [{ id: d2 }],
});
const detail = (deal: string, fields: object = {}) => ({
	deal_id: deal,
	name: "Made-up",
	...fields,
});
const fixed = {
	"client fit": { schema_version: "ideal-client-profile.v1", profiles: [] },
	"capture queue": { candidates: [] },
};
const event = (n: number, fields: object = {}) => ({
	id: uuid(n),
	recorded_at: "2030-01-01T00:00:00+00:00",
	actor: "example",
	field: "phase",
	old_value: "research",
	new_value: "legal",
	...fields,
});
const feed = (events = [event(11), event(12)]) => ({
	events,
	cursors: ["made-up-cursor"],
});
const answer = (ask: Ask) =>
	ask.read === "board"
		? board()
		: ask.read === "deal"
			? detail(ask.deal)
			: ask.read === "feed"
				? feed()
				: fixed[ask.read];
const label = (ask: Ask) =>
	ask.read === "board"
		? ask.workspace
		: ask.read === "deal"
			? ask.deal
			: ask.read;

async function runWith(
	engine: (ask: Ask, call: number) => unknown,
	old: (ask: Ask) => unknown = answer,
) {
	const calls: string[] = [];
	let engineCalls = 0;
	let pauses = 0;
	const run = await compareDeals(
		async (ask) => {
			calls.push(`engine ${label(ask)}`);
			return engine(ask, engineCalls++);
		},
		async (ask) => {
			calls.push(`old ${label(ask)}`);
			return old(ask);
		},
		async () => {
			pauses++;
			calls.push("pause");
		},
	);
	return { run, calls, pauses };
}

test("asks the engine, the old system and the engine again for every board, the client fit, the capture queue, the change feed and every deal, pausing between requests", async () => {
	const { run, calls, pauses } = await runWith(answer);
	const asks = run.outcomes.map((o) => label(o.ask));
	assert.deepEqual(asks, [
		"team",
		"national_account",
		"all",
		"client fit",
		"capture queue",
		"feed",
		d1,
		d2,
		d3,
	]);
	assert.deepEqual(calls.slice(0, 5), [
		"engine team",
		"old team",
		"engine team",
		"pause",
		"engine national_account",
	]);
	assert.equal(pauses, 8);
	assert.deepEqual([run.oldReads, run.engineReads], [9, 18]);
	assert.ok(run.outcomes.every((o) => o.result === "matched"));
	assert.equal(exitCode(run), 0);
});

test("every read of the change feed starts three days back at the zero ID, in the cursor text the app sends", async (t) => {
	mock.timers.enable({
		apis: ["Date"],
		now: Date.parse("2030-01-04T00:00:00Z"),
	});
	t.after(() => mock.timers.reset());
	const starts = new Set<string>();
	const remember = (ask: Ask) => {
		if (ask.read === "feed") starts.add(ask.start);
		return answer(ask);
	};
	await runWith(remember, remember);
	const start =
		"eyJyZWNvcmRlZF9hdCI6IjIwMzAtMDEtMDFUMDA6MDA6MDAuMDAwWiIsImlkIjoiMDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAwIn0";
	assert.deepEqual([...starts], [start]);
	assert.deepEqual(decodeCursor(start), {
		recorded_at: "2030-01-01T00:00:00.000Z",
		id: "00000000-0000-0000-0000-000000000000",
	});
});

test("a request whose two engine answers differ is unsettled and not compared", async () => {
	const { run } = await runWith((ask, call) =>
		ask.read === "deal" && ask.deal === d2 ? detail(d2, { call }) : answer(ask),
	);
	assert.deepEqual(
		run.outcomes.map((o) => o.result),
		[
			"matched",
			"matched",
			"matched",
			"matched",
			"matched",
			"matched",
			"matched",
			"unsettled",
			"matched",
		],
	);
	assert.equal(exitCode(run), 1);
	assert.match(
		report("staging", run),
		/not compared: result, read, deal ID\nunsettled {2}deal detail {2}0{8}-0{4}-4000-8000-0{11}2\n$/,
	);
});

test("a failed request is counted and the run goes on", async () => {
	const { run, calls } = await runWith(answer, (ask) => {
		if (ask.read === "deal" && ask.deal === d2) throw new Error("made-up body");
		return answer(ask);
	});
	assert.deepEqual(
		run.outcomes.map((o) => o.result),
		[
			"matched",
			"matched",
			"matched",
			"matched",
			"matched",
			"matched",
			"matched",
			"failed",
			"matched",
		],
	);
	assert.equal(run.stopped, false);
	assert.equal(calls.at(-1), `engine ${d3}`);
	assert.equal(exitCode(run), 2);
	assert.match(
		report("production", run),
		/not compared: result, read, deal ID\nfailed {2}deal detail {2}0{8}-0{4}-4000-8000-0{11}2\n$/,
	);
});

test("an engine feed that fails its read is a failed item and the deals are still asked", async () => {
	const { run } = await runWith((ask) => {
		if (ask.read === "feed") throw new Error("engine read failed");
		return answer(ask);
	});
	assert.deepEqual(
		run.outcomes.map((o) => `${label(o.ask)} ${o.result}`).slice(3),
		[
			"client fit matched",
			"capture queue matched",
			"feed failed",
			`${d1} matched`,
			`${d2} matched`,
			`${d3} matched`,
		],
	);
	assert.equal(run.stopped, false);
	assert.match(report("production", run), /\nfailed {2}change feed {2}-\n$/);
});

test("a network or sign-in failure stops the run", async () => {
	const { run, calls } = await runWith(answer, (ask) => {
		if (ask.read === "board" && ask.workspace === "national_account")
			throw new StopRun("made-up body");
		return answer(ask);
	});
	assert.deepEqual(
		run.outcomes.map((o) => o.result),
		["matched", "failed"],
	);
	assert.equal(run.stopped, true);
	assert.equal(calls.at(-1), "old national_account");
	assert.equal(exitCode(run), 2);
	assert.match(
		report("production", run),
		/stopped at a network or sign-in failure/,
	);
});

test("refusals match whatever correlation ID the engine gives each one", async () => {
	const refusal = { error: "not_found", table: "deal", id: d2 };
	const { run } = await runWith(
		(ask, call) =>
			ask.read === "deal" && ask.deal === d2
				? { ...refusal, correlation_id: uuid(900 + call) }
				: answer(ask),
		(ask) => (ask.read === "deal" && ask.deal === d2 ? refusal : answer(ask)),
	);
	assert.ok(run.outcomes.every((o) => o.result === "matched"));
});

test("the report counts each read and lists differing paths with record IDs and tie order apart", async () => {
	const tied = [
		{ id: d1, attention: false, next_date: null, name: "Same" },
		{ id: d2, attention: false, next_date: null, name: "Same" },
	];
	const { run } = await runWith(
		(ask) =>
			ask.read === "board"
				? board(ask.workspace === "all" ? tied.toReversed() : tied)
				: ask.read === "deal"
					? detail(ask.deal, { vendors: [{ party_id: uuid(9), note: "New" }] })
					: answer(ask),
		(ask) =>
			ask.read === "board"
				? board(tied)
				: ask.read === "deal"
					? detail(ask.deal, { vendors: [{ party_id: uuid(9), note: "Old" }] })
					: answer(ask),
	);
	assert.equal(exitCode(run), 1);
	assert.equal(
		report("production", run),
		`Old and new Deals answers compared on production
old reads made: 9, engine reads made: 18

read                                         asked   matched tie order different unsettled    failed
board team                                       1         1         0         0         0         0
board national_account                           1         1         0         0         0         0
board all                                        1         0         1         0         0         0
client fit                                       1         1         0         0         0         0
capture queue                                    1         1         0         0         0         0
change feed                                      1         1         0         0         0         0
deal detail                                      3         0         0         3         0         0

differences: field path, kind, records, first record IDs
detail.vendors[].note  value differs  3  ${uuid(9)}

tied rows in another order: array path, requests
board.deals[]  1
`,
	);
});

test("the change feed reports a differing event field by path and event ID, an event on one side by its ID, and a differing cursor by path, without values", async () => {
	const engineFeed = {
		events: [event(11, { field: "next_date" }), event(12), event(13)],
		cursors: ["engine-cursor"],
	};
	const oldFeed = {
		events: [event(14), event(11), event(12)],
		cursors: ["old-cursor"],
	};
	const { run } = await runWith(
		(ask) => (ask.read === "feed" ? engineFeed : answer(ask)),
		(ask) => (ask.read === "feed" ? oldFeed : answer(ask)),
	);
	const outcome = run.outcomes.find((o) => o.ask.read === "feed");
	assert.equal(outcome?.result, "different");
	const text = report("production", run);
	assert.match(text, /\nchange feed +1 +0 +0 +1 +0 +0\n/);
	assert.match(
		text,
		new RegExp(
			[
				"differences: field path, kind, records, first record IDs",
				`feed.events\\[\\]  missing in new  1  ${uuid(14)}`,
				`feed.events\\[\\].field  value differs  1  ${uuid(11)}`,
				`feed.events\\[\\]  missing in old  1  ${uuid(13)}`,
				"feed.cursors\\[\\]  value differs  1  -",
			].join("\n"),
		),
	);
	for (const value of ["next_date", "phase", "engine-cursor", "old-cursor"])
		assert.ok(!text.includes(value), `${value} reached the report`);
});

test("no value, free-form key or non-ID text from either answer reaches the report", async () => {
	const markers: string[] = [];
	const m = (name: string) => {
		const marker = `zzmarker${name}${markers.length}`;
		markers.push(marker);
		return marker;
	};
	const upper = (name: string) => {
		const key = m(name).toUpperCase();
		markers.push(key);
		return key;
	};
	const side = (s: string) => ({
		board: board([
			{
				id: d1,
				name: m(s),
				client_name: m(s),
				attention: false,
				next_date: m(s),
				items: [{ id: uuid(8), bullets: { [m(s)]: m(s) } }],
				phase_started_on: { [m(s)]: m(s) },
				vendors: [{ party_id: m(s), company: { id: m(s), name: m(s) } }],
			},
		]),
		detail: (deal: string) =>
			detail(deal, {
				[upper(s)]: m(s),
				phase_started_on: { [m(s)]: m(s) },
				next_actions: [{ id: uuid(5), bullets: [{ [m(s)]: m(s) }] }],
				items: [{ id: uuid(5), bullets: [{ [m(s)]: m(s) }] }],
				activities: [
					{ id: uuid(6), summary: m(s), email_context: { [m(s)]: m(s) } },
				],
				events: [
					{
						id: uuid(7),
						old_value: { [m(s)]: m(s) },
						new_value: { [m(s)]: [m(s)] },
					},
				],
				participants: [{ role: m(s), name: m(s), party_id: null }],
				email_threads: [{ conversation_id: m(s), subject: m(s) }],
			}),
		fixed: {
			"client fit": {
				profiles: [
					{ vertical: m(s), evidence: [{ deal_id: uuid(4), deal_name: m(s) }] },
				],
			},
			"capture queue": {
				candidates: [
					{
						id: uuid(10),
						kind: m(s),
						payload: { [m(s)]: m(s) },
						evidence_quote: m(s),
						deal_name: m(s),
						created_at: m(s),
					},
				],
			},
		},
		feed: {
			events: [
				{
					id: uuid(7),
					[upper(s)]: m(s),
					actor: m(s),
					field: m(s),
					old_value: { [m(s)]: m(s) },
					new_value: [{ [m(s)]: m(s) }],
				},
			],
			cursors: [m(s)],
		},
	});
	const answers = (s: string) => {
		const { board, detail, fixed, feed } = side(s);
		const details = new Map([d1, d2, d3].map((deal) => [deal, detail(deal)]));
		return (ask: Ask) =>
			ask.read === "board"
				? board
				: ask.read === "deal"
					? details.get(ask.deal)
					: ask.read === "feed"
						? feed
						: fixed[ask.read];
	};
	const { run } = await runWith(answers("new"), answers("old"));
	assert.ok(run.outcomes.every((o) => o.result === "different"));
	const text = report("production", run);
	assert.ok(markers.length > 40);
	for (const marker of markers)
		assert.ok(!text.includes(marker), `${marker} reached the report`);
	assert.match(text, /detail\.events\[\]\.old_value {2}value differs/);
	assert.match(text, /feed\.events\[\]\.new_value {2}value differs/);
});
