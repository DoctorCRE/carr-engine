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
const clock = "2030-01-01T00:00:00.000Z";
const invoices = (entries: object[] = [], observed_at = clock) => ({
	schema_version: "invoice-tracker.v1",
	actor: "example",
	entries,
	observed_at,
});
const source = {
	observed_at: clock,
	valid_until: clock,
	correlation_id: uuid(90),
};
const directory = (rows: object[] = []) => ({ rows, source });
const network = {
	observed_at: clock,
	valid_until: clock,
	nodes: [],
	edges: [],
};
const fixed = {
	"client fit": { schema_version: "ideal-client-profile.v1", profiles: [] },
	"capture queue": { candidates: [] },
	"quiet follow-ups": { schema_version: "quiet-follow-ups.v1", proposals: [] },
	territory: { schema_version: "territory-state-board.v1", submarkets: [] },
	"reasons to reach out": {
		pages: [{ ok: true, cards: [], next_cursor: null }],
	},
	invoices: invoices(),
	"client list": directory(),
	"vendor list": directory(),
	"vendor markets": { markets: [], vendors: [] },
	relationships: network,
	"today's reminders": {
		pages: [{ items: [], total: 0, has_more: false, next_cursor: null }],
	},
	"meeting prep": { state: "empty", observed_at: clock, items: [] },
};
const [l1, l2] = [uuid(31), uuid(32)];
const [c1, c2, v1] = [uuid(51), uuid(52), uuid(53)];
const leadRow = (id: string, fields: object = {}) => ({
	id,
	stage: "new",
	reachability: { evaluated_at: clock, evidence: [] },
	...fields,
});
const workspace = (
	leads = [leadRow(l1), leadRow(l2)],
	fields: object = {},
) => ({
	schema_version: "lead-workspace.v1",
	generated_at: clock,
	leads,
	...fields,
});
const opened = (lead: string, detail: object = {}) => ({
	opened: workspace(undefined, { detail: leadRow(lead, detail) }),
	older_correspondence: [],
	older_stage_history: [],
});
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
const found = (fields: object = {}) => ({
	parties: [{ name: "Made-up Name", ref: "C-1", merged: false }],
	deals: [],
	note: "Made-up note.",
	...fields,
});
function answer(ask: Ask) {
	switch (ask.read) {
		case "board":
			return board();
		case "deal":
			return detail(ask.deal);
		case "feed":
			return feed();
		case "find":
			return found();
		case "lead board":
			return workspace();
		case "lead":
			return opened(ask.lead);
		case "client":
			return { record: { id: ask.client }, source };
		case "vendor":
			return { record: { id: ask.vendor }, source };
		case "recent activity":
			return { state: "completed", catch_up: { timeline: [] } };
		default:
			return fixed[ask.read];
	}
}
function label(ask: Ask) {
	switch (ask.read) {
		case "board":
			return ask.workspace;
		case "deal":
			return ask.deal;
		case "find":
			return `find ${ask.query}`;
		case "lead":
			return ask.lead;
		case "client":
			return ask.client;
		case "vendor":
			return ask.vendor;
		case "recent activity":
			return `activity ${ask.record}`;
		default:
			return ask.read;
	}
}

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

test("asks the engine, the old system and the engine again for every board, the client fit, the capture queue, the change feed, the find probes, the Leads reads, the invoices, every deal and every lead, pausing between requests", async () => {
	const { run, calls, pauses } = await runWith(answer);
	const asks = run.outcomes.map((o) => label(o.ask));
	assert.deepEqual(asks, [
		"team",
		"national_account",
		"all",
		"client fit",
		"capture queue",
		"feed",
		"find %",
		"find _",
		"find  ",
		"lead board",
		"quiet follow-ups",
		"territory",
		"reasons to reach out",
		"invoices",
		"client list",
		"vendor list",
		"vendor markets",
		"relationships",
		"today's reminders",
		"today's reminders",
		"meeting prep",
		d1,
		d2,
		d3,
		l1,
		l2,
	]);
	assert.deepEqual(calls.slice(0, 5), [
		"engine team",
		"old team",
		"engine team",
		"pause",
		"engine national_account",
	]);
	assert.equal(pauses, 25);
	assert.deepEqual([run.oldReads, run.engineReads], [26, 52]);
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
		run.outcomes.flatMap((o) => (o.result === "matched" ? [] : [label(o.ask)])),
		[d2],
	);
	assert.equal(exitCode(run), 1);
	assert.match(
		report("staging", run),
		/not compared: result, read, record ID\nunsettled {2}deal detail {2}0{8}-0{4}-4000-8000-0{11}2\n$/,
	);
});

test("a failed request is counted and the run goes on", async () => {
	const { run, calls } = await runWith(answer, (ask) => {
		if (ask.read === "deal" && ask.deal === d2) throw new Error("made-up body");
		return answer(ask);
	});
	assert.deepEqual(
		run.outcomes.flatMap((o) => (o.result === "matched" ? [] : [label(o.ask)])),
		[d2],
	);
	assert.equal(run.stopped, false);
	assert.equal(calls.at(-1), `engine ${l2}`);
	assert.equal(exitCode(run), 2);
	assert.match(
		report("production", run),
		/not compared: result, read, record ID\nfailed {2}deal detail {2}0{8}-0{4}-4000-8000-0{11}2\n$/,
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
			"find % matched",
			"find _ matched",
			"find   matched",
			"lead board matched",
			"quiet follow-ups matched",
			"territory matched",
			"reasons to reach out matched",
			"invoices matched",
			"client list matched",
			"vendor list matched",
			"vendor markets matched",
			"relationships matched",
			"today's reminders matched",
			"today's reminders matched",
			"meeting prep matched",
			`${d1} matched`,
			`${d2} matched`,
			`${d3} matched`,
			`${l1} matched`,
			`${l2} matched`,
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

// Each side's refusal arrives without its correlation ID (ask.test.ts).
test("a deal both sides refuse alike matches, and a differing refusal is a difference", async () => {
	const refusal = { error: "not_found", table: "deal", id: d2 };
	const refused = (body: object) => (ask: Ask) =>
		ask.read === "deal" && ask.deal === d2 ? body : answer(ask);
	const { run } = await runWith(refused(refusal), refused(refusal));
	assert.ok(run.outcomes.every((o) => o.result === "matched"));
	const differing = await runWith(
		refused({ ...refusal, error: "conflict" }),
		refused(refusal),
	);
	assert.deepEqual(
		differing.run.outcomes.flatMap((o) =>
			o.result === "different" ? [label(o.ask)] : [],
		),
		[d2],
	);
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
		`Old and new answers compared on production
old reads made: 26, engine reads made: 52

read                                         asked   matched tie order    at cap different unsettled    failed
board team                                       1         1         0         0         0         0         0
board national_account                           1         1         0         0         0         0         0
board all                                        1         0         1         0         0         0         0
client fit                                       1         1         0         0         0         0         0
capture queue                                    1         1         0         0         0         0         0
change feed                                      1         1         0         0         0         0         0
search find                                      3         3         0         0         0         0         0
lead board                                       1         1         0         0         0         0         0
quiet follow-ups                                 1         1         0         0         0         0         0
territory                                        1         1         0         0         0         0         0
reasons to reach out                             1         1         0         0         0         0         0
invoices                                         1         1         0         0         0         0         0
client list                                      1         1         0         0         0         0         0
vendor list                                      1         1         0         0         0         0         0
vendor markets                                   1         1         0         0         0         0         0
relationships                                    1         1         0         0         0         0         0
today's reminders                                2         2         0         0         0         0         0
meeting prep                                     1         1         0         0         0         0         0
deal detail                                      3         0         0         0         3         0         0
lead detail                                      2         2         0         0         0         0         0

differences: field path, kind, records, first record IDs
detail.vendors[].note  value differs  3  ${uuid(9)}

tied rows in another order: array path, requests
board.deals[]  1
`,
	);
});

test("keys in another order are reported as key order by path and record ID, apart from a changed value", async () => {
	const { id, ...rest } = leadRow(l2);
	const { run } = await runWith(
		(ask) => {
			switch (ask.read) {
				case "board":
					return board([{ id: d1 }, { name: "Made-up", id: d2 }]);
				case "deal":
					return ask.deal === d1
						? { name: "Made-up", deal_id: d1 }
						: detail(ask.deal, { name: "Changed" });
				case "lead board":
					return workspace([leadRow(l1), { ...rest, id }]);
				default:
					return answer(ask);
			}
		},
		(ask) =>
			ask.read === "board"
				? board([{ id: d1 }, { id: d2, name: "Made-up" }])
				: answer(ask),
	);
	assert.equal(exitCode(run), 1);
	assert.equal(
		report("production", run).split("differences: ")[1],
		`field path, kind, records, first record IDs
board.deals[].id  key order  3  ${d2}
leads.leads[].id  key order  1  ${l2}
detail.deal_id  key order  1  ${d1}
detail.name  value differs  2  ${d2}, ${d3}
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
	assert.match(text, /\nchange feed +1 +0 +0 +0 +1 +0 +0\n/);
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
		find: {
			parties: [{ name: m(s), ref: m(s), city: m(s), merged: false }],
			deals: [{ name: m(s), client_ref: m(s) }],
			organizations: [{ name: m(s), refs: [m(s)] }],
			connections: [{ from_name: m(s), from_ref: m(s), note: m(s) }],
			lead_client_links: [{ lead_name: m(s), lead_ref: m(s) }],
			note: m(s),
		},
		leads: {
			"lead board": workspace([
				leadRow(l1, {
					name: m(s),
					[upper(s)]: m(s),
					possible_clients: [{ client_id: uuid(42), name: m(s) }],
					reachability: {
						evaluated_at: m(s),
						evidence: [{ flag_id: uuid(40), value: { [m(s)]: m(s) } }],
						source_inputs: {
							email: m(s),
							activities: [{ id: uuid(41), detail: m(s) }],
						},
					},
				}),
			]),
			lead: {
				opened: workspace([], {
					detail: leadRow(l1, {
						notes: m(s),
						correspondence: [{ id: uuid(43), summary: m(s) }],
						stage_history: [
							{ event_id: uuid(44), stage_review: { [m(s)]: m(s) } },
						],
						research: {
							evidence: [{ flag_id: uuid(45), value: [{ [m(s)]: m(s) }] }],
						},
					}),
				}),
				older_correspondence: [
					workspace([], {
						detail: { correspondence_page: { next_cursor: m(s) } },
					}),
				],
				older_stage_history: [],
			},
			"quiet follow-ups": {
				proposals: [{ subject_id: uuid(46), name: m(s), ref: m(s) }],
			},
			territory: {
				submarkets: [
					{
						city: m(s),
						state: m(s),
						evidence: [{ flag_id: uuid(47), source: m(s) }],
					},
				],
			},
			"reasons to reach out": {
				pages: [
					{
						cards: [{ id: "7", name: m(s), facts: { [m(s)]: m(s) } }],
						next_cursor: m(s),
					},
				],
			},
		},
		invoices: invoices([{ deal_id: d1, name: m(s), commission_id: m(s) }]),
		directory: {
			"client list": directory([{ id: c1, ref: m(s), name: m(s) }]),
			client: {
				record: {
					id: c1,
					ref: "C-1",
					name: m(s),
					[upper(s)]: m(s),
					notes: m(s),
				},
				source,
			},
			"vendor list": directory([{ id: v1, ref: m(s), name: m(s) }]),
			vendor: {
				record: {
					id: v1,
					loan_programs: { [m(s)]: m(s) },
					people: [{ contact: { id: m(s), email: m(s) } }],
				},
				source,
			},
			"vendor markets": {
				markets: [{ slug: upper(s), boundary: m(s) }],
				vendors: [{ id: v1, name: m(s) }],
			},
			relationships: {
				...network,
				nodes: [{ id: m(s), record_id: m(s), name: m(s), summary: m(s) }],
				edges: [{ id: m(s), from: m(s), summary: m(s) }],
			},
			"recent activity": {
				state: "completed",
				query: m(s),
				match: { kind: "client", name: m(s), target: m(s) },
				catch_up: {
					timeline: [
						{
							entry_kind: "note",
							occurred_at: clock,
							detail: { [m(s)]: m(s) },
						},
					],
				},
			},
		},
		today: {
			"today's reminders": {
				pages: [{ items: [{ id: uuid(48), what: m(s) }], next_cursor: m(s) }],
			},
			"meeting prep": {
				notes: [m(s)],
				items: [
					{
						start: m(s),
						title: m(s),
						attendees: [{ email: m(s) }],
						possible_deals: [{ id: uuid(49), name: m(s) }],
					},
				],
				follow_up_reviews: [{ key: m(s), prompt: m(s) }],
			},
		},
	});
	const answers = (s: string) => {
		const {
			board,
			detail,
			fixed,
			feed,
			find,
			leads,
			invoices,
			directory,
			today,
		} = side(s);
		const details = new Map([d1, d2, d3].map((deal) => [deal, detail(deal)]));
		return (ask: Ask) =>
			ask.read === "board"
				? board
				: ask.read === "deal"
					? details.get(ask.deal)
					: ask.read === "feed"
						? feed
						: ask.read === "find"
							? find
							: ask.read === "invoices"
								? invoices
								: ask.read === "client fit" || ask.read === "capture queue"
									? fixed[ask.read]
									: ask.read === "lead board" ||
											ask.read === "lead" ||
											ask.read === "quiet follow-ups" ||
											ask.read === "territory" ||
											ask.read === "reasons to reach out"
										? leads[ask.read]
										: ask.read === "today's reminders" ||
												ask.read === "meeting prep"
											? today[ask.read]
											: directory[ask.read];
	};
	const { run } = await runWith(answers("new"), answers("old"));
	assert.ok(
		run.outcomes.some(
			(o) => o.ask.read === "find" && markers.includes(o.ask.query),
		),
		"a client name from the old board was asked",
	);
	assert.ok(
		run.outcomes.some(
			(o) => o.ask.read === "recent activity" && markers.includes(o.ask.name),
		),
		"a name from the old record was asked",
	);
	assert.ok(run.outcomes.every((o) => o.result === "different"));
	const text = report("production", run);
	assert.ok(markers.length > 40);
	for (const marker of markers)
		assert.ok(!text.includes(marker), `${marker} reached the report`);
	assert.match(text, /detail\.events\[\]\.old_value {2}value differs/);
	assert.match(text, /feed\.events\[\]\.new_value {2}value differs/);
	assert.match(
		text,
		/lead\.opened\.detail\.stage_history\[\]\.stage_review {2}value differs {2}1 {2}0{8}-0{4}-4000-8000-0{10}44/,
	);
});

test("finds the first twelve client names on the old boards, each once, after the probes", async () => {
	const clients = Array.from({ length: 15 }, (_, n) => ({
		id: uuid(20 + n),
		client_name: `Made-up Client ${n}`,
	}));
	const listed = (ask: Ask) =>
		ask.read === "board"
			? {
					...board(clients),
					closed_deals: [{ id: d3, client_name: "Made-up Client 0" }],
				}
			: answer(ask);
	const { run } = await runWith(listed, listed);
	assert.deepEqual(
		run.outcomes.flatMap((o) => (o.ask.read === "find" ? [o.ask.query] : [])),
		["%", "_", " ", ...clients.slice(0, 12).map((c) => c.client_name)],
	);
	assert.equal(exitCode(run), 0);
});

test("a find whose old deals list is full reports the other deals as cap ambiguity, not a difference", async () => {
	const deal = (n: number) => ({
		name: `Made-up Deal ${n}`,
		client_ref: `C-${n}`,
	});
	const five = [1, 2, 3, 4, 5].map(deal);
	const { run } = await runWith(
		(ask) =>
			ask.read === "find"
				? found({ deals: [...five.slice(1), deal(6)] })
				: answer(ask),
		(ask) => (ask.read === "find" ? found({ deals: five }) : answer(ask)),
	);
	assert.ok(
		run.outcomes
			.filter((o) => o.ask.read === "find")
			.every((o) => o.result === "at cap"),
	);
	assert.equal(exitCode(run), 0);
	const text = report("production", run);
	assert.match(text, /\nsearch find +3 +0 +0 +3 +0 +0 +0\n/);
	assert.match(
		text,
		/\ncap ambiguity, the old list was full: field path, kind, records, first record IDs\nfind\.deals\[\] {2}missing in new {2}3 {2}C-1\nfind\.deals\[\] {2}missing in old {2}3 {2}C-6\n/,
	);
	assert.ok(!text.includes("Made-up"));
});

const readsWorkspace = (ask: Ask) =>
	ask.read === "lead board" || ask.read === "lead";

test("the Leads board and opened leads match when only their clock fields differ", async () => {
	const { run } = await runWith(
		(ask, call) => {
			const at = `2030-01-01T00:00:${String(call).padStart(2, "0")}.000Z`;
			const row = (id: string) =>
				leadRow(id, { reachability: { evaluated_at: at, evidence: [] } });
			if (ask.read === "lead board")
				return workspace([row(l1), row(l2)], { generated_at: at });
			if (ask.read === "lead")
				return {
					opened: workspace([row(l1), row(l2)], {
						generated_at: at,
						detail: row(ask.lead),
					}),
					older_correspondence: [
						workspace([row(l1), row(l2)], { generated_at: at }),
					],
					older_stage_history: [],
				};
			return answer(ask);
		},
		(ask) =>
			ask.read === "lead"
				? { ...opened(ask.lead), older_correspondence: [workspace()] }
				: answer(ask),
	);
	assert.ok(run.outcomes.filter((o) => readsWorkspace(o.ask)).length === 3);
	assert.ok(run.outcomes.every((o) => o.result === "matched"));
	assert.equal(exitCode(run), 0);
});

test("a Leads difference is reported by field path and lead ID, without values", async () => {
	const { run } = await runWith(
		(ask) =>
			ask.read === "lead board"
				? workspace([leadRow(l1), leadRow(l2, { stage: "engaged" })])
				: ask.read === "lead"
					? opened(ask.lead, { notes: "Made-up new note" })
					: answer(ask),
		(ask) =>
			ask.read === "lead"
				? opened(ask.lead, { notes: "Made-up old note" })
				: answer(ask),
	);
	assert.deepEqual(
		run.outcomes.flatMap((o) =>
			o.result === "different" ? [label(o.ask)] : [],
		),
		["lead board", l1, l2],
	);
	const text = report("production", run);
	assert.match(
		text,
		new RegExp(`\nleads\\.leads\\[\\]\\.stage  value differs  1  ${l2}\n`),
	);
	assert.match(
		text,
		new RegExp(
			`\nlead\\.opened\\.detail\\.notes  value differs  2  ${l1}, ${l2}\n`,
		),
	);
	assert.ok(!text.includes("Made-up"));
	assert.ok(!text.includes("engaged"));
});

test("opens twenty-five leads spread over the old board's order, each once", async () => {
	const ids = Array.from({ length: 60 }, (_, n) => uuid(100 + n));
	const board = (ask: Ask) =>
		ask.read === "lead board"
			? workspace(ids.map((id) => leadRow(id)))
			: answer(ask);
	const { run } = await runWith(board, board);
	const asked = run.outcomes.flatMap((o) =>
		o.ask.read === "lead" ? [o.ask.lead] : [],
	);
	assert.equal(asked.length, 25);
	assert.equal(new Set(asked).size, 25);
	assert.equal(asked[0], ids[0]);
	const places = asked.map((id) => ids.indexOf(id));
	assert.deepEqual(
		places,
		places.toSorted((a, b) => a - b),
	);
	assert.ok(
		places.every((place, n) => n === 0 || place - (places[n - 1] ?? 0) <= 3),
	);
	assert.ok(
		(places.at(-1) ?? 0) >= 57,
		"the sample reaches the end of the board",
	);
});

test("Leads reads the engine fails are recorded as failed and the run goes on", async () => {
	const { run } = await runWith((ask) => {
		if (ask.read !== "lead board" && readsWorkspace(ask))
			throw new Error("engine read failed");
		if (
			["quiet follow-ups", "territory", "reasons to reach out"].includes(
				ask.read,
			)
		)
			throw new Error("engine read failed");
		return answer(ask);
	});
	assert.deepEqual(
		run.outcomes.flatMap((o) => (o.result === "failed" ? [label(o.ask)] : [])),
		["quiet follow-ups", "territory", "reasons to reach out", l1, l2],
	);
	assert.equal(run.stopped, false);
	assert.equal(exitCode(run), 2);
	assert.match(
		report("production", run),
		new RegExp(`\nfailed  lead detail  ${l1}\nfailed  lead detail  ${l2}\n$`),
	);

	const boardDown = await runWith((ask) => {
		if (ask.read === "lead board") throw new Error("engine read failed");
		return answer(ask);
	});
	assert.deepEqual(
		boardDown.run.outcomes.flatMap((o) =>
			o.result === "matched" ? [] : [label(o.ask)],
		),
		["lead board"],
	);
});

test("invoice entries match when only the read's clock differs, pair a deal's commissions by content and report a changed amount by deal", async () => {
	const entry = (deal: string, commission: string | null, name = "Same") => ({
		deal_id: deal,
		name,
		commission_invoiced_on: null,
		commission_id: commission,
		gross_amount: "1250.00",
	});
	const tied = [entry(d1, null), entry(d2, null)];
	const twice = [entry(d3, uuid(10), "Later"), entry(d3, uuid(11), "Later")];
	const once = entry(uuid(12), uuid(13), "Latest");
	const { run } = await runWith(
		(ask, call) =>
			ask.read === "invoices"
				? invoices(
						[
							...tied.toReversed(),
							...twice,
							{ ...once, gross_amount: "99.00" },
						],
						`2030-01-01T00:00:${String(call).padStart(2, "0")}.000Z`,
					)
				: answer(ask),
		(ask) =>
			ask.read === "invoices"
				? invoices([...tied, ...twice, once])
				: answer(ask),
	);
	assert.deepEqual(
		run.outcomes.filter((o) => o.result !== "matched").map((o) => o.ask),
		[{ read: "invoices" }],
	);
	const text = report("staging", run);
	assert.match(
		text,
		/\ninvoices\.entries\[\]\.gross_amount {2}value differs {2}1 {2}0{8}-0{4}-4000-8000-0{10}12\n/,
	);
	assert.match(
		text,
		/tied rows in another order: array path, requests\ninvoices\.entries\[\] {2}1\n/,
	);
	assert.doesNotMatch(text, /observed_at|99\.00|Latest/);
});

test("opens every record on the old lists' first page, and asks recent activity for the first five read with a ref and a name of at most 200 characters", async () => {
	const row = (n: number, fields: object = {}) => ({
		id: uuid(n),
		ref: `C-${n}`,
		name: ` Made-up ${n} `,
		...fields,
	});
	const clients = [
		row(60, { ref: null }),
		row(61, { name: "x".repeat(201) }),
		row(62, { id: "not-a-uuid" }),
		row(63, { name: "  " }),
		row(64, { ref: "  " }),
		...[65, 66, 67, 68, 69, 71, 72].map((n) => row(n)),
	];
	const records = new Map(
		[...clients, row(70)].map((record) => [record.id, { record, source }]),
	);
	const list = (ask: Ask) => {
		switch (ask.read) {
			case "client list":
				return directory(clients);
			case "vendor list":
				return directory([row(70)]);
			case "client":
				return ask.client === uuid(66)
					? { error: "NOT_FOUND" }
					: records.get(ask.client);
			case "vendor":
				return records.get(ask.vendor);
			default:
				return answer(ask);
		}
	};
	const { run } = await runWith(list, list);
	const asked = run.outcomes.map((o) => o.ask);
	assert.deepEqual(
		asked.flatMap((ask) => (ask.read === "client" ? [ask.client] : [])),
		[60, 61, 63, 64, 65, 66, 67, 68, 69, 71, 72].map(uuid),
	);
	assert.deepEqual(
		asked.flatMap((ask) => (ask.read === "vendor" ? [ask.vendor] : [])),
		[uuid(70)],
	);
	assert.deepEqual(
		asked.flatMap((ask) =>
			ask.read === "recent activity" ? [[ask.name, ask.record]] : [],
		),
		[65, 67, 68, 69, 71, 70].map((n) => [`Made-up ${n}`, uuid(n)]),
	);
	assert.ok(run.outcomes.every((o) => o.result === "matched"));
});

test("directory reads match when only their clocks and correlation ids differ, and report a changed field by record ID", async () => {
	const [entry, contact, member, node] = [
		uuid(55),
		uuid(56),
		uuid(57),
		uuid(58),
	];
	const at = (call: number) =>
		`2030-01-01T00:00:${String(call % 60).padStart(2, "0")}.000Z`;
	const sides = (value: string, call: number) => (ask: Ask) => {
		const stamp = {
			observed_at: at(call),
			valid_until: at(call),
			correlation_id: uuid(100 + call),
		};
		switch (ask.read) {
			case "client list":
				return {
					rows: [
						{ id: c1, ref: "C-1", name: "Made-up", city: value },
						{ id: c2, ref: "C-2", name: "Made-up" },
					],
					source: stamp,
				};
			case "client":
				return {
					record: { id: ask.client, ref: "C-1", name: "Made-up", phone: value },
					source: stamp,
				};
			case "vendor list":
				return {
					rows: [
						{
							id: v1,
							ref: "V-1",
							name: "Made-up",
							relationship: {
								recent_entries: [{ id: entry, when: clock, summary: value }],
							},
						},
					],
					source: stamp,
				};
			case "vendor":
				return {
					record: {
						id: v1,
						ref: "V-1",
						name: "Made-up",
						people: [{ contact: { id: contact, email: value } }],
					},
					source: stamp,
				};
			case "vendor markets":
				return {
					markets: [
						{
							slug: "north-1",
							boundary: value,
							memberships: [{ vendor_id: member, service_coverage: value }],
						},
					],
				};
			case "relationships":
				return {
					observed_at: at(call),
					valid_until: at(call),
					nodes: [{ id: `party:${node}`, record_id: node, name: value }],
					edges: [{ id: `link:${node}`, summary: value }],
					referrals: [{ node_id: `party:${node}`, win_rate: value }],
					suggestions: [
						{ id: `evidence:${node}:${member}:referred`, reason: value },
					],
				};
			case "recent activity":
				return {
					state: "completed",
					catch_up: {
						timeline: [
							{ entry_kind: "note", occurred_at: clock, summary: value },
						],
					},
				};
			default:
				return answer(ask);
		}
	};
	const same = await runWith(
		(ask, call) => sides("same", call)(ask),
		sides("same", 99),
	);
	assert.ok(same.run.outcomes.every((o) => o.result === "matched"));

	const { run } = await runWith(
		(ask, call) => sides("zz-engine-value", call)(ask),
		sides("zz-old-value", 99),
	);
	assert.deepEqual(
		run.outcomes.flatMap((o) =>
			o.result === "matched" ? [] : [`${label(o.ask)} ${o.result}`],
		),
		[
			"client list different",
			"vendor list different",
			"vendor markets different",
			"relationships different",
			`${c1} different`,
			`${c2} different`,
			`${v1} different`,
			`activity ${c1} different`,
			`activity ${c2} different`,
			`activity ${v1} different`,
		],
	);
	const text = report("production", run);
	assert.match(
		text,
		new RegExp(
			[
				"differences: field path, kind, records, first record IDs",
				`clients\\.rows\\[\\]\\.city  value differs  1  ${c1}`,
				`vendors\\.rows\\[\\]\\.relationship\\.recent_entries\\[\\]\\.summary  value differs  1  ${entry}`,
				"markets\\.markets\\[\\]\\.boundary  value differs  1  north-1",
				`markets\\.markets\\[\\]\\.memberships\\[\\]\\.service_coverage  value differs  1  ${member}`,
				`network\\.nodes\\[\\]\\.name  value differs  1  ${node}`,
				`network\\.edges\\[\\]\\.summary  value differs  1  link:${node}`,
				`network\\.referrals\\[\\]\\.win_rate  value differs  1  party:${node}`,
				`network\\.suggestions\\[\\]\\.reason  value differs  1  evidence:${node}:${member}:referred`,
				`client\\.record\\.phone  value differs  2  ${c1}, ${c2}`,
				`vendor\\.record\\.people\\[\\]\\.contact\\.email  value differs  1  ${contact}`,
				`activity\\.catch_up\\.timeline\\[\\]\\.summary  value differs  3  ${c1}, ${c2}, ${v1}`,
				"",
			].join("\n"),
		),
	);
	assert.doesNotMatch(text, /zz-|Made-up|2030-/);
});

test("directory reads that fail are recorded as failed, a failed record read asks no recent activity, and the run goes on", async () => {
	const failing = new Set([
		"client",
		"vendor markets",
		"relationships",
		"recent activity",
	]);
	const [client, vendor] = [
		{ id: c1, ref: "C-1", name: "Made-up" },
		{ id: v1, ref: "V-1", name: "Made-up" },
	];
	const list = (ask: Ask) => {
		switch (ask.read) {
			case "client list":
				return directory([client]);
			case "vendor list":
				return directory([vendor]);
			case "vendor":
				return { record: vendor, source };
			default:
				return answer(ask);
		}
	};
	const records = (ask: Ask) => {
		if (failing.has(ask.read)) throw new Error("read failed");
		return list(ask);
	};
	const { run } = await runWith(records, records);
	assert.equal(run.stopped, false);
	assert.equal(exitCode(run), 2);
	assert.match(
		report("production", run),
		new RegExp(
			`\\nnot compared: result, read, record ID\\n${[
				"failed  vendor markets  -",
				"failed  relationships  -",
				`failed  client detail  ${c1}`,
				`failed  recent activity  ${v1}`,
				"",
			].join("\\n")}$`,
		),
	);
});

const reminders = (due_on: string) => ({
	pages: [
		{
			items: [
				{ item_kind: "next_action", id: uuid(60), due_on: "2030-01-01" },
				{ item_kind: "critical_date", id: uuid(62), due_on },
			],
			total: 2,
			has_more: false,
			next_cursor: null,
		},
	],
});
const meetingPrep = (phase: string) => ({
	state: "ready",
	observed_at: clock,
	items: [
		{
			start: clock,
			title: "Made-up meeting",
			possible_deals: [{ id: uuid(61), prep: { state: "ready", phase } }],
		},
	],
});
const withToday =
	(due_on: string, phase: string) =>
	(ask: Ask): unknown =>
		ask.read === "today's reminders"
			? reminders(due_on)
			: ask.read === "meeting prep"
				? meetingPrep(phase)
				: answer(ask);
const todayReads = (run: { outcomes: { ask: Ask; result: string }[] }) =>
	run.outcomes.flatMap((o) =>
		o.ask.read === "today's reminders" || o.ask.read === "meeting prep"
			? [o.result]
			: [],
	);

test("today's reminders and meeting prep match alike answers and report a changed reminder or deal preparation by path and record ID", async () => {
	const alike = await runWith(
		withToday("2030-01-02", "legal"),
		withToday("2030-01-02", "legal"),
	);
	assert.deepEqual(todayReads(alike.run), ["matched", "matched", "matched"]);
	const { run } = await runWith(
		withToday("2030-01-03", "research"),
		withToday("2030-01-02", "legal"),
	);
	assert.deepEqual(todayReads(run), ["different", "different", "different"]);
	const text = report("production", run);
	for (const line of [
		"today's reminders                                2         0         0         0         2         0         0",
		"meeting prep                                     1         0         0         0         1         0         0",
		`today.pages[].items[].due_on  value differs  2  ${uuid(62)}`,
		`prep.items[].possible_deals[].prep.phase  value differs  1  ${uuid(61)}`,
	])
		assert.ok(text.includes(`\n${line}\n`), line);
});

test("today's reminders and meeting prep the engine cannot read fail, and the run goes on", async () => {
	const { run, calls } = await runWith((ask) => {
		if (ask.read === "today's reminders" || ask.read === "meeting prep")
			throw new Error("read failed");
		return answer(ask);
	});
	assert.deepEqual(todayReads(run), ["failed", "failed", "failed"]);
	assert.equal(calls.at(-1), `engine ${l2}`);
	assert.equal(exitCode(run), 2);
	assert.match(
		report("production", run),
		/\nnot compared: result, read, record ID\nfailed {2}today's reminders {2}-\nfailed {2}today's reminders {2}-\nfailed {2}meeting prep {2}-\n$/,
	);
});
