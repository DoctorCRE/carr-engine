import assert from "node:assert/strict";
import { test } from "node:test";
import { compareAnswers } from "./answers.ts";
import { clientFitShape } from "./deals-shapes.ts";
import { leadBoardShape, leadShape, reasonsShape } from "./leads-shapes.ts";
import { findShape } from "./search-shape.ts";

const shape = {
	rows: {
		"deals[]": { id: "id", sortedBy: ["attention", "next_date", "name"] },
		"deals[].vendors[]": { id: "party_id", sortedBy: ["role"] },
		"participants[]": { sortedBy: ["role", "name"] },
		"rounds[]": { id: "round_no", sortedBy: ["side"] },
	},
	opaque: ["events[].old_value"],
};
const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const d0 = uuid(0);
const d1 = uuid(1);
const d2 = uuid(2);
const d3 = uuid(3);
const d4 = uuid(4);
const p1 = uuid(101);
const p2 = uuid(102);
const deal = (id: string | undefined, fields: object = {}) => ({
	id,
	name: "Made-up Deal",
	attention: false,
	next_date: "2030-01-01",
	...fields,
});
const board = (deals: object[], extra: object = {}) => ({
	schema_version: "local-deals-board.v2",
	deals,
	...extra,
});
const compare = (old: unknown, next: unknown) =>
	compareAnswers(old, next, shape);
const none = { differences: [], tiedRowsReordered: [], capAmbiguous: [] };

test("identical answers match whatever their key order", () => {
	const old = board([deal(d1), deal(d2, { attention: true })]);
	const next = JSON.parse(JSON.stringify(old), (_key, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).reverse())
			: value,
	);
	assert.deepEqual(compare(old, next), none);
});

test("a changed value names the field and the record", () => {
	const result = compare(
		board([deal(d1), deal(d2)]),
		board([deal(d1), deal(d2, { next_date: "2030-01-02" })]),
	);
	assert.deepEqual(result.differences, [
		{
			path: "deals[].next_date",
			records: [{ id: d2 }],
			kind: "value differs",
		},
	]);
});

test("null and a missing key differ, in both directions", () => {
	const result = compare(
		board([deal(d1, { owner: null, items: [] })]),
		board([deal(d1, { lane: null })]),
	);
	assert.deepEqual(result.differences, [
		{ path: "deals[].owner", records: [{ id: d1 }], kind: "missing in new" },
		{ path: "deals[].items", records: [{ id: d1 }], kind: "missing in new" },
		{ path: "deals[].lane", records: [{ id: d1 }], kind: "missing in old" },
	]);
});

test("values of different JSON types differ in type", () => {
	const result = compare(
		{ area: "12.50", note: null, done: 0, label: "" },
		{ area: 12.5, note: "x", done: false, label: null },
	);
	assert.deepEqual(
		result.differences.map((difference) => [difference.path, difference.kind]),
		[
			["area", "type differs"],
			["note", "type differs"],
			["done", "type differs"],
			["label", "type differs"],
		],
	);
});

test("rows tied on every sort key may swap, and the swap is counted", () => {
	const result = compare(
		board([deal(d1), deal(d2), deal(d3, { name: "Later" })]),
		board([deal(d2), deal(d1), deal(d3, { name: "Later" })]),
	);
	assert.deepEqual(result, {
		differences: [],
		tiedRowsReordered: [{ path: "deals[]", records: [] }],
		capAmbiguous: [],
	});
});

test("a tie group of three may shuffle between rows that are not tied", () => {
	const first = deal(d0, { attention: true });
	const last = deal(d4, { name: "Later" });
	const result = compare(
		board([first, deal(d1), deal(d2), deal(d3), last]),
		board([first, deal(d3), deal(d1), deal(d2), last]),
	);
	assert.deepEqual(result, {
		differences: [],
		tiedRowsReordered: [{ path: "deals[]", records: [] }],
		capAmbiguous: [],
	});
});

test("a tie swap inside a record names the record", () => {
	const vendor = (party_id: string) => ({ party_id, role: "lender" });
	const result = compare(
		board([deal(d1, { vendors: [vendor(p1), vendor(p2)] })]),
		board([deal(d1, { vendors: [vendor(p2), vendor(p1)] })]),
	);
	assert.deepEqual(result, {
		differences: [],
		tiedRowsReordered: [{ path: "deals[].vendors[]", records: [{ id: d1 }] }],
		capAmbiguous: [],
	});
});

test("rows that differ on a sort key must keep their order", () => {
	const result = compare(
		board([deal(d1, { attention: true }), deal(d2)]),
		board([deal(d2), deal(d1, { attention: true })]),
	);
	assert.deepEqual(result, {
		differences: [
			{ path: "deals[]", records: [{ id: d1 }], kind: "order differs" },
		],
		tiedRowsReordered: [],
		capAmbiguous: [],
	});
});

test("rows never tie when no sort key is declared or present", () => {
	const swap = (rows: { id: string; sortedBy: string[] }) => {
		const old = { list: [{ id: d1 }, { id: d2 }] };
		const next = { list: [{ id: d2 }, { id: d1 }] };
		return compareAnswers(old, next, { rows: { "list[]": rows } });
	};
	for (const rows of [
		{ id: "id", sortedBy: [] },
		{ id: "id", sortedBy: ["misspelt"] },
	])
		assert.deepEqual(swap(rows).differences, [
			{ path: "list[]", records: [{ id: d1 }], kind: "order differs" },
		]);
	const plain = compareAnswers(
		{ list: ["a", "b"] },
		{ list: ["b", "a"] },
		{ rows: { "list[]": { sortedBy: ["name"] } } },
	);
	assert.equal(plain.differences[0]?.kind, "order differs");
});

test("rows pair by ID, so an extra or repeated row is reported once", () => {
	const result = compare(
		board([deal(d1), deal(d2)]),
		board([deal(d0, { attention: true }), deal(d1), deal(d2), deal(d2)]),
	);
	assert.deepEqual(result.differences, [
		{ path: "deals[]", records: [{ id: d0 }], kind: "missing in old" },
		{ path: "deals[]", records: [{ id: d2 }], kind: "missing in old" },
	]);
});

test("only UUIDs and integers print as IDs", () => {
	const round = (round_no: unknown) => ({ round_no, side: "landlord" });
	const result = compare(
		{ deals: [deal(d1)], rounds: [round(2)] },
		{ deals: [deal(d1), deal("not-an-id")], rounds: [round(2), round(2.5)] },
	);
	assert.deepEqual(result.differences, [
		{ path: "deals[]", records: [{ index: 1 }], kind: "missing in old" },
		{ path: "rounds[]", records: [{ index: 1 }], kind: "missing in old" },
	]);
	const integer = compare({ rounds: [round(2)] }, { rounds: [] });
	assert.deepEqual(integer.differences[0]?.records, [{ id: "2" }]);
});

test("a nested difference names every enclosing record", () => {
	const vendor = (note: string) => ({ party_id: p1, role: "lender", note });
	const result = compare(
		board([deal(d1, { vendors: [vendor("a")] })]),
		board([deal(d1, { vendors: [vendor("b")] })]),
	);
	assert.deepEqual(result.differences, [
		{
			path: "deals[].vendors[].note",
			records: [{ id: d1 }, { id: p1 }],
			kind: "value differs",
		},
	]);
});

test("rows without an ID pair by content and may swap when tied", () => {
	const person = (name: string) => ({ role: "agent", name, actor: null });
	const tied = compare(
		{ participants: [person("A"), { ...person("A"), actor: "x" }] },
		{ participants: [{ ...person("A"), actor: "x" }, person("A")] },
	);
	assert.deepEqual(tied, {
		differences: [],
		tiedRowsReordered: [{ path: "participants[]", records: [] }],
		capAmbiguous: [],
	});
	const changed = compare(
		{ participants: [person("A")] },
		{ participants: [person("B")] },
	);
	assert.deepEqual(changed.differences, [
		{ path: "participants[]", records: [{ index: 0 }], kind: "missing in new" },
		{ path: "participants[]", records: [{ index: 0 }], kind: "missing in old" },
	]);
});

test("arrays the read does not describe compare by position", () => {
	const result = compare({ bullets: ["a", "b"] }, { bullets: ["b", "a", "c"] });
	assert.deepEqual(result.differences, [
		{ path: "bullets[]", records: [{ index: 0 }], kind: "value differs" },
		{ path: "bullets[]", records: [{ index: 1 }], kind: "value differs" },
		{ path: "bullets[]", records: [{ index: 2 }], kind: "missing in old" },
	]);
});

test("opaque fields compare whole and report only their own path", () => {
	const event = (old_value: unknown) => ({ events: [{ old_value }] });
	assert.deepEqual(
		compare(event({ a: 1, b: [2] }), event({ b: [2], a: 1 })),
		none,
	);
	assert.deepEqual(compare(event({ a: 1 }), event({ a: "1" })).differences, [
		{
			path: "events[].old_value",
			records: [{ index: 0 }],
			kind: "value differs",
		},
	]);
});

test("answers that are not parsed JSON are refused", () => {
	for (const [old, next] of [
		[new Date(0), new Date(1)],
		[{}, new Date(0)],
		[new Map([["a", 1]]), new Map()],
	])
		assert.throws(() => compare({ at: old }, { at: next }), {
			message: "Answers must be parsed JSON",
		});
});

test("no value or data-made key from either answer reaches the result", () => {
	const marked = (n: number) => `MARKER-VALUE-${n}`;
	const json = (value: unknown) => JSON.parse(JSON.stringify(value));
	const result = compare(
		json(
			board(
				[
					deal(d1, { attention: true, name: marked(1), owner: marked(2) }),
					deal(d2, {
						name: marked(3),
						vendors: [{ party_id: p1, role: marked(4) }],
					}),
				],
				{
					area: marked(5),
					only_old: marked(6),
					participants: [{ role: marked(7), name: marked(8) }],
					bullets: [marked(9)],
					by_name: { [marked(21)]: 1 },
					events: [{ old_value: { marker_key_secret: 1 } }],
				},
			),
		),
		json(
			board(
				[
					deal(d2, { name: marked(10), vendors: [{ party_id: p1, role: 11 }] }),
					deal(d1, { attention: true, name: marked(12), owner: marked(13) }),
					deal(marked(14)),
					deal(undefined, { name: marked(22) }),
				],
				{
					area: 15,
					only_new: marked(16),
					participants: [{ role: marked(17), name: marked(18) }],
					bullets: [marked(19), marked(20)],
					by_name: { [marked(23)]: 1 },
					events: [{ old_value: {} }],
				},
			),
		),
	);
	assert.ok(result.differences.length >= 12, "every kind of difference ran");
	const serialized = JSON.stringify(result);
	for (let n = 1; n <= 23; n++)
		assert.ok(!serialized.includes(marked(n)), `marker ${n} stayed out`);
	assert.ok(!serialized.includes("marker_key_secret"), "opaque key stayed out");
	assert.ok(!/\b1[15]\b/.test(serialized), "numeric values stayed out");
});

test("a client fit profile compares by position, so a changed field names its evidence row", () => {
	const fit = (deal_name: string) => ({
		profiles: [{ vertical: null, evidence: [{ deal_id: d1, deal_name }] }],
	});
	assert.deepEqual(
		compareAnswers(fit("Old"), fit("New"), clientFitShape).differences,
		[
			{
				path: "profiles[].evidence[].deal_name",
				records: [{ index: 0 }, { id: d1 }],
				kind: "value differs",
			},
		],
	);
});

const party = (ref: string, fields: object = {}) => ({
	name: "Made-up Name",
	city: "Springfield",
	ref,
	kind: "client",
	merged: false,
	...fields,
});
const named = (n: number) => ({
	name: `Made-up Deal ${n}`,
	phase: "research",
	client_ref: `C-${n}`,
});
const organization = (n: number) => ({ name: `Made-up Org ${n}`, refs: [] });
const found = (fields: object = {}) => ({
	parties: [party("C-1"), party("L-2"), party("V-CPA-3", { merged: true })],
	deals: [named(1), named(2)],
	connections: [
		{ from_ref: "C-1", to_ref: "L-2", kind: "referral" },
		{ from_ref: "L-2", to_ref: "C-1", kind: "referral" },
	],
	organizations: [organization(1), organization(2)],
	lead_client_links: [],
	deals_via_link: [],
	note: "Made-up note.",
	...fields,
});
const find = (old: unknown, next: unknown) =>
	compareAnswers(old, next, findShape);

test("find lists ranked on values the answer leaves out may come back in any order", () => {
	const old = found();
	assert.deepEqual(find(old, found()), none);
	const reversed = find(
		old,
		found({
			parties: [party("L-2"), party("C-1"), party("V-CPA-3", { merged: true })],
			deals: [named(2), named(1)],
			connections: old.connections.toReversed(),
			organizations: [organization(2), organization(1)],
		}),
	);
	assert.deepEqual(reversed.differences, []);
	assert.deepEqual(
		reversed.tiedRowsReordered.map((place) => place.path),
		["parties[]", "deals[]", "connections[]", "organizations[]"],
	);
});

test("a find difference names its path and ref, and never a name", () => {
	const result = find(
		found(),
		found({
			parties: [
				party("C-1", { city: "Shelbyville" }),
				party("L-2"),
				party("V-CPA-3", { merged: true }),
			],
			deals: [named(1)],
			organizations: [organization(1), { ...organization(2), refs: ["P-9"] }],
		}),
	);
	assert.deepEqual(result.differences, [
		{ path: "parties[].city", records: [{ id: "C-1" }], kind: "value differs" },
		{ path: "deals[]", records: [{ id: "C-2" }], kind: "missing in new" },
		{
			path: "organizations[].refs[]",
			records: [{ index: 1 }, { index: 0 }],
			kind: "missing in old",
		},
	]);
	assert.ok(!JSON.stringify(result).includes("Made-up"));
});

test("a full old list leaves which rows made it, and what they decide, as cap ambiguity", () => {
	const five = [1, 2, 3, 4, 5].map(named);
	const changed = {
		deals: [...five.slice(0, 4), named(6)],
		deals_via_link: [named(7)],
		note: "Another made-up note.",
	};
	const full = find(found({ deals: five }), found(changed));
	assert.deepEqual(full.differences, []);
	assert.deepEqual(
		full.capAmbiguous.map((d) => [d.path, d.kind, d.records]),
		[
			["deals[]", "missing in new", [{ id: "C-5" }]],
			["deals[]", "missing in old", [{ id: "C-6" }]],
			["deals_via_link[]", "missing in old", [{ id: "C-7" }]],
			["note", "value differs", []],
		],
	);
});

test("a field that differs on a deal in both answers is a difference even when the list is full", () => {
	const five = [1, 2, 3, 4, 5].map(named);
	const result = find(
		found({ deals: five }),
		found({ deals: five.with(0, { ...named(1), phase: "legal" }) }),
	);
	assert.deepEqual(result.differences, [
		{ path: "deals[].phase", records: [{ id: "C-1" }], kind: "value differs" },
	]);
	assert.deepEqual(result.capAmbiguous, []);
});

test("a full old list hides nothing when the engine returns a different number of rows", () => {
	const ten = Array.from({ length: 10 }, (_, i) => party(`C-${i + 1}`));
	for (const parties of [ten.slice(0, 3), [...ten, party("C-11")]]) {
		const result = find(found({ parties: ten }), found({ parties }));
		assert.ok(result.differences.length > 0, `${parties.length} rows differ`);
		assert.deepEqual(result.capAmbiguous, []);
	}
});

test("a full old list hides nothing when a row crosses the merged groups", () => {
	const live = Array.from({ length: 10 }, (_, i) => party(`C-${i + 1}`));
	const swapped = [...live.slice(0, 9), party("C-11", { merged: true })];
	for (const [old, next] of [
		[live, swapped],
		[swapped, live],
	]) {
		const result = find(found({ parties: old }), found({ parties: next }));
		assert.deepEqual(
			result.differences.map((d) => [d.path, d.kind]),
			[
				["parties[]", "missing in new"],
				["parties[]", "missing in old"],
			],
		);
		assert.deepEqual(result.capAmbiguous, []);
	}
});

test("a full upstream list leaves only which linked rows appear ambiguous", () => {
	const ten = Array.from({ length: 10 }, (_, i) => party(`C-${i + 1}`));
	const link = (lead_ref: string, link_basis: string) => ({
		lead_ref,
		client_ref: "C-1",
		link_basis,
	});
	const result = find(
		found({
			parties: ten,
			lead_client_links: [link("L-5", "conversion"), link("L-6", "same_org")],
			deals_via_link: [named(7)],
		}),
		found({
			parties: ten,
			lead_client_links: [link("L-5", "same_party")],
			deals_via_link: [{ ...named(7), phase: "legal" }],
			note: "Another made-up note.",
		}),
	);
	assert.deepEqual(result.differences, [
		{
			path: "lead_client_links[].link_basis",
			records: [{ id: "L-5" }],
			kind: "value differs",
		},
		{
			path: "deals_via_link[].phase",
			records: [{ id: "C-7" }],
			kind: "value differs",
		},
	]);
	assert.deepEqual(
		result.capAmbiguous.map((d) => [d.path, d.kind]),
		[
			["lead_client_links[]", "missing in new"],
			["note", "value differs"],
		],
	);
});

test("rows sharing a key pair by their content, not their position", () => {
	const twin = (phase: string) => ({ ...named(1), phase });
	const bare = (to_name: string) => ({
		from_ref: "C-1",
		from_name: "Made-up Client",
		kind: "org",
		to_ref: null,
		to_name,
	});
	const old = found({
		deals: [twin("research"), twin("legal")],
		connections: [bare("Made-up Org A"), bare("Made-up Org B")],
		deals_via_link: [twin("research"), twin("legal")],
	});
	const reordered = find(
		old,
		found({
			deals: [twin("legal"), twin("research")],
			connections: [bare("Made-up Org B"), bare("Made-up Org A")],
			deals_via_link: [twin("legal"), twin("research")],
		}),
	);
	assert.deepEqual(reordered.differences, []);
	const changed = find(
		old,
		found({
			deals: [twin("research"), twin("closed")],
			connections: old.connections,
			deals_via_link: old.deals_via_link,
		}),
	);
	assert.deepEqual(
		changed.differences.map((d) => [d.path, d.kind, d.records]),
		[
			["deals[]", "missing in new", [{ id: "C-1" }]],
			["deals[]", "missing in old", [{ id: "C-1" }]],
		],
	);
	assert.ok(!JSON.stringify([reordered, changed]).includes("Made-up"));
});

test("a changed field on an edge to a party without a ref names that field", () => {
	const edge = (note: string) => ({
		from_ref: "C-1",
		from_name: "Made-up Client",
		kind: "org",
		to_ref: null,
		to_name: "Made-up Org",
		note,
	});
	const result = find(
		found({
			connections: [
				edge("Made-up note."),
				{ ...edge(""), to_name: "Made-up Org B" },
			],
		}),
		found({
			connections: [
				edge("Changed note."),
				{ ...edge(""), to_name: "Made-up Org B" },
			],
		}),
	);
	assert.deepEqual(result.differences, [
		{
			path: "connections[].note",
			records: [{ id: "C-1" }],
			kind: "value differs",
		},
	]);
});

test("twenty lead links are a full answer, so a different twenty is a difference", () => {
	const links = (from: number) =>
		Array.from({ length: 20 }, (_, i) => ({
			lead_ref: `L-${from + i}`,
			client_ref: "C-1",
			link_basis: "conversion",
		}));
	const result = find(
		found({ lead_client_links: links(1) }),
		found({ lead_client_links: links(2) }),
	);
	assert.deepEqual(
		result.differences.map((d) => [d.path, d.kind, d.records]),
		[
			["lead_client_links[]", "missing in new", [{ id: "L-1" }]],
			["lead_client_links[]", "missing in old", [{ id: "L-21" }]],
		],
	);
});

const l1 = uuid(31);
const lead = (evaluated_at?: unknown) => ({
	id: l1,
	reachability: evaluated_at === undefined ? {} : { evaluated_at },
});
const leadBoard = (generated_at: unknown, evaluated_at: unknown) => ({
	...(generated_at === undefined ? {} : { generated_at }),
	leads: [lead(evaluated_at)],
});
const zulu = "2030-01-01T00:00:00.000Z";

test("clock values may differ while their keys, types and formats match", () => {
	const at = "2031-12-31T23:59:59.999Z";
	assert.deepEqual(
		compareAnswers(leadBoard(zulu, zulu), leadBoard(at, at), leadBoardShape),
		none,
	);
	assert.deepEqual(
		compareAnswers(
			leadBoard(null, null),
			leadBoard(null, null),
			leadBoardShape,
		),
		none,
	);
});

test("a missing, null or differently formatted clock is a difference at its path", () => {
	const lost = (generated_at: unknown, evaluated_at: unknown) =>
		compareAnswers(
			leadBoard(zulu, zulu),
			leadBoard(generated_at, evaluated_at),
			leadBoardShape,
		).differences;
	const at = [{ id: l1 }];
	const evaluated = "leads[].reachability.evaluated_at";
	assert.deepEqual(lost(zulu, undefined), [
		{ path: evaluated, records: at, kind: "missing in new" },
	]);
	assert.deepEqual(lost(zulu, null), [
		{ path: evaluated, records: at, kind: "type differs" },
	]);
	assert.deepEqual(lost(undefined, zulu), [
		{ path: "generated_at", records: [], kind: "missing in new" },
	]);
	for (const other of [
		"2030-01-01T00:00:00+00:00",
		"2030-01-01T00:00:00.000000Z",
		"2030-01-01T00:00:00Z",
	])
		assert.deepEqual(lost(zulu, other), [
			{ path: evaluated, records: at, kind: "value differs" },
		]);
});

test("an opened lead without its clock is a difference", () => {
	const opened = (detail: object) => ({
		opened: { ...leadBoard(zulu, zulu), detail },
		older_correspondence: [],
		older_stage_history: [],
	});
	assert.deepEqual(
		compareAnswers(opened(lead(zulu)), opened(lead()), leadShape).differences,
		[
			{
				path: "opened.detail.reachability.evaluated_at",
				records: [],
				kind: "missing in new",
			},
		],
	);
});

test("a reason card prints its bigint ID", () => {
	const cards = (...ids: string[]) => ({
		pages: [{ cards: ids.map((id) => ({ id, facts: {} })) }],
	});
	assert.deepEqual(
		compareAnswers(cards("77", "78"), cards("77"), reasonsShape).differences,
		[
			{
				path: "pages[].cards[]",
				records: [{ index: 0 }, { id: "78" }],
				kind: "missing in new",
			},
		],
	);
});
