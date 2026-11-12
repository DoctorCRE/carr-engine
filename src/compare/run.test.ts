import assert from "node:assert/strict";
import { test } from "node:test";
import { report } from "./report.ts";
import { type Ask, compareReads, exitCode, StopRun } from "./run.ts";

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
const fit = { schema_version: "ideal-client-profile.v1", profiles: [] };
const invoices = (entries: object[] = [], observed_at = "made-up") => ({
	actor: "example",
	entries,
	observed_at,
});

function label(ask: Ask) {
	switch (ask.read) {
		case "board":
			return ask.workspace;
		case "deal":
			return ask.deal;
		default:
			return ask.read;
	}
}
// Each reply takes the ask's workspace or deal, when it has one.
type Replies = Record<Ask["read"], (key: string) => unknown>;
const replying = (replies: Replies) => (ask: Ask) =>
	replies[ask.read](label(ask));
const replies: Replies = {
	board: () => board(),
	deal: (deal) => detail(deal),
	"client fit": () => fit,
	invoices: () => invoices(),
};
const answer = replying(replies);

async function runWith(
	engine: (ask: Ask, call: number) => unknown,
	old: (ask: Ask) => unknown = answer,
) {
	const calls: string[] = [];
	let engineCalls = 0;
	let pauses = 0;
	const run = await compareReads(
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

test("asks the engine, the old system and the engine again for every board, the client fit, the invoices and every deal, pausing between requests", async () => {
	const { run, calls, pauses } = await runWith(answer);
	const asks = run.outcomes.map((o) => label(o.ask));
	assert.deepEqual(asks, [
		"team",
		"national_account",
		"all",
		"client fit",
		"invoices",
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
		[...Array(6).fill("matched"), "unsettled", "matched"],
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
		[...Array(6).fill("matched"), "failed", "matched"],
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
		replying({
			...replies,
			board: (workspace) =>
				board(workspace === "all" ? tied.toReversed() : tied),
			deal: (deal) =>
				detail(deal, { vendors: [{ party_id: uuid(9), note: "New" }] }),
		}),
		replying({
			...replies,
			board: () => board(tied),
			deal: (deal) =>
				detail(deal, { vendors: [{ party_id: uuid(9), note: "Old" }] }),
		}),
	);
	assert.equal(exitCode(run), 1);
	assert.equal(
		report("production", run),
		`Old and new answers compared on production
old reads made: 8, engine reads made: 16

read                                         asked   matched tie order different unsettled    failed
board team                                       1         1         0         0         0         0
board national_account                           1         1         0         0         0         0
board all                                        1         0         1         0         0         0
client fit                                       1         1         0         0         0         0
invoices                                         1         1         0         0         0         0
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
		fit: {
			profiles: [
				{ vertical: m(s), evidence: [{ deal_id: uuid(4), deal_name: m(s) }] },
			],
		},
	});
	const answers = (s: string) => {
		const { board, detail, fit } = side(s);
		const details = new Map([d1, d2, d3].map((deal) => [deal, detail(deal)]));
		const tracker = invoices([{ deal_id: d1, name: m(s) }]);
		return replying({
			board: () => board,
			deal: (deal) => details.get(deal),
			"client fit": () => fit,
			invoices: () => tracker,
		});
	};
	const { run } = await runWith(answers("new"), answers("old"));
	assert.ok(run.outcomes.every((o) => o.result === "different"));
	const text = report("production", run);
	assert.ok(markers.length > 40);
	for (const marker of markers)
		assert.ok(!text.includes(marker), `${marker} reached the report`);
	assert.match(text, /detail\.events\[\]\.old_value {2}value differs/);
});

test("invoice entries ignore the read's clock, match a deal's commissions in order and report a changed amount by deal", async () => {
	const entry = (deal: string, commission: string | null, name = "Same") => ({
		deal_id: deal,
		name,
		commission_invoiced_on: null,
		commission_id: commission,
		gross_amount: "1250.00",
	});
	const tied = [entry(d1, null), entry(d2, null)];
	const later = entry(d3, uuid(10), "Later");
	const latest = entry(d3, uuid(11), "Later");
	const { run } = await runWith(
		(ask, call) =>
			replying({
				...replies,
				invoices: () =>
					invoices(
						[...tied.toReversed(), later, { ...latest, gross_amount: "99.00" }],
						`2026-01-01T00:00:00.00${call}Z`,
					),
			})(ask),
		replying({
			...replies,
			invoices: () => invoices([...tied, later, latest]),
		}),
	);
	assert.deepEqual(
		run.outcomes.filter((o) => o.result !== "matched").map((o) => o.ask),
		[{ read: "invoices" }],
	);
	const text = report("staging", run);
	assert.match(
		text,
		/invoices\.entries\[\]\.gross_amount {2}value differs {2}1 {2}0{8}-0{4}-4000-8000-0{11}3\n/,
	);
	assert.match(
		text,
		/tied rows in another order: array path, requests\ninvoices\.entries\[\] {2}1\n/,
	);
	assert.doesNotMatch(text, /observed_at/);
});
