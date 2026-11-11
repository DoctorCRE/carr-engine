import assert from "node:assert/strict";
import { test } from "node:test";
import { compareAnswers } from "./answers.ts";

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
const none = { differences: [], tiedRowsReordered: [] };

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
