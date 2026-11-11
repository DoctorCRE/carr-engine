import { isDeepStrictEqual } from "node:util";

type Rows = { id?: string; sortedBy: readonly string[] };
type ReadShape = { rows: Record<string, Rows>; opaque?: readonly string[] };
type Kind =
	| "value differs"
	| "type differs"
	| "missing in old"
	| "missing in new"
	| "order differs";
type Step = { id: string } | { index: number };
type Place = { path: string; records: Step[] };
type Difference = Place & { kind: Kind };
type Row = { key: string; step: Step; value: unknown; ties: unknown[] | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD = /^[a-z][a-z0-9_]*$/;

function kindOf(value: unknown) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null)
			throw new TypeError("Answers must be parsed JSON");
	}
	return typeof value;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
	kindOf(value) === "object";
const byKey = (a: Row, b: Row) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (!isRecord(value)) return JSON.stringify(value);
	const keys = Object.keys(value).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function rowsOf(items: unknown[], rows: Rows): Row[] {
	const seen = new Map<string, number>();
	return items.map((value, index) => {
		const id = isRecord(value) && rows.id ? value[rows.id] : undefined;
		const named = typeof id === "string" || typeof id === "number";
		const base = named ? `id:${id}` : `row:${canonical(value)}`;
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		const printable =
			(typeof id === "string" && UUID.test(id)) || Number.isSafeInteger(id);
		const sortable =
			rows.sortedBy.length > 0 &&
			isRecord(value) &&
			rows.sortedBy.every((key) => Object.hasOwn(value, key));
		return {
			key: `${base}#${count}`,
			step: printable ? { id: String(id) } : { index },
			value,
			ties: sortable ? rows.sortedBy.map((key) => value[key]) : null,
		};
	});
}

function untie(rows: Row[]): Row[] {
	const sorted: Row[] = [];
	let run: Row[] = [];
	for (const row of rows) {
		const tied =
			run[0]?.ties && row.ties && isDeepStrictEqual(run[0].ties, row.ties);
		if (run[0] && !tied) {
			sorted.push(...run.sort(byKey));
			run = [];
		}
		run.push(row);
	}
	return [...sorted, ...run.sort(byKey)];
}

export function compareAnswers(old: unknown, next: unknown, shape: ReadShape) {
	const differences: Difference[] = [];
	const tiedRowsReordered: Place[] = [];
	const opaque = new Set(shape.opaque);

	function walk(a: unknown, b: unknown, path: string, records: Step[]): void {
		if (kindOf(a) !== kindOf(b)) {
			differences.push({ path, records, kind: "type differs" });
		} else if (opaque.has(path)) {
			if (canonical(a) !== canonical(b))
				differences.push({ path, records, kind: "value differs" });
		} else if (isRecord(a) && isRecord(b)) {
			for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
				const field = FIELD.test(key) ? key : "*";
				const child = path ? `${path}.${field}` : field;
				if (!Object.hasOwn(b, key))
					differences.push({ path: child, records, kind: "missing in new" });
				else if (!Object.hasOwn(a, key))
					differences.push({ path: child, records, kind: "missing in old" });
				else walk(a[key], b[key], child, records);
			}
		} else if (Array.isArray(a) && Array.isArray(b)) {
			const rows = shape.rows[`${path}[]`];
			if (rows) compareRows(a, b, `${path}[]`, records, rows);
			else
				for (let index = 0; index < Math.max(a.length, b.length); index++) {
					const at = [...records, { index }];
					if (index >= b.length)
						differences.push({
							path: `${path}[]`,
							records: at,
							kind: "missing in new",
						});
					else if (index >= a.length)
						differences.push({
							path: `${path}[]`,
							records: at,
							kind: "missing in old",
						});
					else walk(a[index], b[index], `${path}[]`, at);
				}
		} else if (a !== b) {
			differences.push({ path, records, kind: "value differs" });
		}
	}

	function compareRows(
		a: unknown[],
		b: unknown[],
		path: string,
		records: Step[],
		rows: Rows,
	): void {
		const left = rowsOf(a, rows);
		const right = rowsOf(b, rows);
		const inLeft = new Map(left.map((row) => [row.key, row]));
		const inRight = new Map(right.map((row) => [row.key, row]));
		for (const row of left) {
			const match = inRight.get(row.key);
			if (match) walk(row.value, match.value, path, [...records, row.step]);
			else
				differences.push({
					path,
					records: [...records, row.step],
					kind: "missing in new",
				});
		}
		for (const row of right)
			if (!inLeft.has(row.key))
				differences.push({
					path,
					records: [...records, row.step],
					kind: "missing in old",
				});

		const oldOrder = left.filter((row) => inRight.has(row.key));
		const newOrder = right.filter((row) => inLeft.has(row.key));
		if (oldOrder.every((row, i) => row.key === newOrder[i]?.key)) return;
		const oldUntied = untie(oldOrder);
		const newUntied = untie(newOrder);
		const at = oldUntied.find((row, i) => row.key !== newUntied[i]?.key);
		if (at)
			differences.push({
				path,
				records: [...records, at.step],
				kind: "order differs",
			});
		else tiedRowsReordered.push({ path, records });
	}

	walk(old, next, "", []);
	return { differences, tiedRowsReordered };
}
