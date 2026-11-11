import assert from "node:assert/strict";
import { test } from "node:test";
import { compareAnswers } from "./answers.ts";

const shape = {
	"deals[]": { id: "id", sortedBy: ["attention", "next_date", "name"] },
	"deals[].vendors[]": { id: "party_id", sortedBy: ["role"] },
	"participants[]": { sortedBy: ["role", "name"] },
};
const deal = (id: string, fields: object = {}) => ({
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
	const old = board([deal("d1"), deal("d2", { attention: true })]);
	const next = JSON.parse(JSON.stringify(old), (_key, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).reverse())
			: value,
	);
	assert.deepEqual(compare(old, next), none);
});

test("a changed value names the field and the record", () => {
	const result = compare(
		board([deal("d1"), deal("d2")]),
		board([deal("d1"), deal("d2", { next_date: "2030-01-02" })]),
	);
	assert.deepEqual(result.differences, [
		{
			path: "deals[].next_date",
			records: [{ id: "d2" }],
			kind: "value differs",
		},
	]);
});

test("null and a missing key differ, in both directions", () => {
	const result = compare(
		board([deal("d1", { owner: null })]),
		board([deal("d1", { lane: null })]),
	);
	assert.deepEqual(result.differences, [
		{ path: "deals[].owner", records: [{ id: "d1" }], kind: "missing in new" },
		{ path: "deals[].lane", records: [{ id: "d1" }], kind: "missing in old" },
	]);
});

test("a number and a string differ in type", () => {
	const result = compare(
		{ area: "12.50", note: null },
		{ area: 12.5, note: "x" },
	);
	assert.deepEqual(result.differences, [
		{ path: "area", records: [], kind: "type differs" },
		{ path: "note", records: [], kind: "type differs" },
	]);
});

test("rows tied on every sort key may swap, and the swap is counted", () => {
	const result = compare(
		board([deal("d1"), deal("d2"), deal("d3", { name: "Later" })]),
		board([deal("d2"), deal("d1"), deal("d3", { name: "Later" })]),
	);
	assert.deepEqual(result, {
		differences: [],
		tiedRowsReordered: [{ path: "deals[]", records: [] }],
	});
});

test("rows that differ on a sort key must keep their order", () => {
	const result = compare(
		board([deal("d1", { attention: true }), deal("d2")]),
		board([deal("d2"), deal("d1", { attention: true })]),
	);
	assert.deepEqual(result, {
		differences: [
			{ path: "deals[]", records: [{ id: "d1" }], kind: "order differs" },
		],
		tiedRowsReordered: [],
	});
});

test("rows pair by ID, so an extra or repeated row is reported once", () => {
	const result = compare(
		board([deal("d1"), deal("d2")]),
		board([
			deal("d0", { attention: true }),
			deal("d1"),
			deal("d2"),
			deal("d2"),
		]),
	);
	assert.deepEqual(result.differences, [
		{ path: "deals[]", records: [{ id: "d0" }], kind: "missing in old" },
		{ path: "deals[]", records: [{ id: "d2" }], kind: "missing in old" },
	]);
});

test("a nested difference names every enclosing record", () => {
	const vendor = (note: string) => ({ party_id: "p1", role: "lender", note });
	const result = compare(
		board([deal("d1", { vendors: [vendor("a")] })]),
		board([deal("d1", { vendors: [vendor("b")] })]),
	);
	assert.deepEqual(result.differences, [
		{
			path: "deals[].vendors[].note",
			records: [{ id: "d1" }, { id: "p1" }],
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

test("no value from either answer reaches the result", () => {
	const marked = (n: number) => `MARKER-VALUE-${n}`;
	const result = compare(
		board(
			[
				deal("d1", { attention: true, name: marked(1), owner: marked(2) }),
				deal("d2", {
					name: marked(3),
					vendors: [{ party_id: "p1", role: marked(4) }],
				}),
			],
			{
				area: marked(5),
				only_old: marked(6),
				participants: [{ role: marked(7), name: marked(8) }],
				bullets: [marked(9)],
			},
		),
		board(
			[
				deal("d2", {
					name: marked(10),
					vendors: [{ party_id: "p1", role: 11 }],
				}),
				deal("d1", { attention: true, name: marked(12), owner: marked(13) }),
				deal("d3", { name: marked(14) }),
			],
			{
				area: 15,
				only_new: marked(16),
				participants: [{ role: marked(17), name: marked(18) }],
				bullets: [marked(19), marked(20)],
			},
		),
	);
	assert.ok(
		result.differences.length >= 10,
		"every kind of difference is exercised",
	);
	const serialized = JSON.stringify(result);
	for (let n = 1; n <= 20; n++)
		assert.ok(!serialized.includes(marked(n)), `marker ${n} stayed out`);
	assert.ok(!/\b1[15]\b/.test(serialized), "numeric values stayed out");
});
