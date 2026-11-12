import assert from "node:assert/strict";
import { test } from "node:test";
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
const answer = (ask: Ask) =>
	ask.read === "board"
		? board()
		: ask.read === "deal"
			? detail(ask.deal)
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

test("asks the engine, the old system and the engine again for every board, the client fit, the capture queue and every deal, pausing between requests", async () => {
	const { run, calls, pauses } = await runWith(answer);
	const asks = run.outcomes.map((o) => label(o.ask));
	assert.deepEqual(asks, [
		"team",
		"national_account",
		"all",
		"client fit",
		"capture queue",
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
	assert.equal(pauses, 7);
	assert.deepEqual([run.oldReads, run.engineReads], [8, 16]);
	assert.ok(run.outcomes.every((o) => o.result === "matched"));
	assert.equal(exitCode(run), 0);
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
					: fixed[ask.read],
		(ask) =>
			ask.read === "board"
				? board(tied)
				: ask.read === "deal"
					? detail(ask.deal, { vendors: [{ party_id: uuid(9), note: "Old" }] })
					: fixed[ask.read],
	);
	assert.equal(exitCode(run), 1);
	assert.equal(
		report("production", run),
		`Old and new Deals answers compared on production
old reads made: 8, engine reads made: 16

read                                         asked   matched tie order different unsettled    failed
board team                                       1         1         0         0         0         0
board national_account                           1         1         0         0         0         0
board all                                        1         0         1         0         0         0
client fit                                       1         1         0         0         0         0
capture queue                                    1         1         0         0         0         0
deal detail                                      3         0         0         3         0         0

differences: field path, kind, records, first record IDs
detail.vendors[].note  value differs  3  ${uuid(9)}

tied rows in another order: array path, requests
board.deals[]  1
`,
	);
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
	});
	const answers = (s: string) => {
		const { board, detail, fixed } = side(s);
		const details = new Map([d1, d2, d3].map((deal) => [deal, detail(deal)]));
		return (ask: Ask) =>
			ask.read === "board"
				? board
				: ask.read === "deal"
					? details.get(ask.deal)
					: fixed[ask.read];
	};
	const { run } = await runWith(answers("new"), answers("old"));
	assert.ok(run.outcomes.every((o) => o.result === "different"));
	const text = report("production", run);
	assert.ok(markers.length > 40);
	for (const marker of markers)
		assert.ok(!text.includes(marker), `${marker} reached the report`);
	assert.match(text, /detail\.events\[\]\.old_value {2}value differs/);
});
