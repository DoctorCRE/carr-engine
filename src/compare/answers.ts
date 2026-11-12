import { isDeepStrictEqual } from "node:util";
import { UUID } from "../uuid.ts";

// A list at its cap holds one of several right answers when its order has
// ties, so which rows made it, and what `decides` derives from them, may differ.
type Cap = { size: number; decides: readonly string[] };
// `key` names the fields that pair rows without an ID; otherwise the whole row does.
// A `serial` ID is bigint text, which prints as a record ID.
type Rows = {
	id?: string;
	serial?: true;
	key?: readonly string[];
	ref?: string;
	cap?: Cap;
} & ({ sortedBy: readonly string[] } | { unordered: true });
export type ReadShape = {
	rows: Record<string, Rows>;
	opaque?: readonly string[];
	// The time the answer was made, or a random id: its value may differ, its
	// format may not.
	clocks?: readonly string[];
};
type Kind =
	| "value differs"
	| "type differs"
	| "missing in old"
	| "missing in new"
	| "order differs";
type Step = { id: string } | { index: number };
type Place = { path: string; records: Step[] };
export type Difference = Place & { kind: Kind };
type Row = { key: string; step: Step; value: unknown; ties: unknown[] | null };

const REF = /^[A-Z]{1,3}(?:-[A-Z0-9]+)*-[0-9]+$/;
const FIELD = /^[a-z][a-z0-9_]*$/;
const SERIAL = /^[0-9]+$/;

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
export const isRecord = (value: unknown): value is Record<string, unknown> =>
	kindOf(value) === "object";
const byKey = (a: Row, b: Row) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (!isRecord(value)) return JSON.stringify(value);
	const keys = Object.keys(value).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

const sameFormat = (a: unknown, b: unknown) =>
	typeof a === "string" &&
	typeof b === "string" &&
	a.replace(/[0-9a-f]/g, "0") === b.replace(/[0-9a-f]/g, "0");

export const strict = (id: string) => ({ id, sortedBy: [] });

const fieldOf = (value: unknown, name?: string) =>
	isRecord(value) && name ? value[name] : undefined;

function baseOf(value: unknown, rows: Rows): string {
	const id = fieldOf(value, rows.id);
	if (typeof id === "string" || typeof id === "number") return `id:${id}`;
	const key =
		rows.key && isRecord(value) ? rows.key.map((k) => value[k]) : value;
	return `row:${canonical(key)}`;
}

function stepOf(value: unknown, index: number, rows: Rows): Step {
	const id = fieldOf(value, rows.id);
	const printed =
		typeof id === "string"
			? UUID.test(id) || (rows.serial === true && SERIAL.test(id))
			: Number.isSafeInteger(id);
	if (printed) return { id: String(id) };
	const ref = fieldOf(value, rows.ref);
	return typeof ref === "string" && REF.test(ref) ? { id: ref } : { index };
}

function tiesOf(value: unknown, rows: Rows): unknown[] | null {
	if ("unordered" in rows) return [];
	const sortable =
		rows.sortedBy.length > 0 &&
		isRecord(value) &&
		rows.sortedBy.every((key) => Object.hasOwn(value, key));
	return sortable ? rows.sortedBy.map((key) => value[key]) : null;
}

function repeatedBases(a: unknown[], b: unknown[], rows: Rows) {
	const repeated = new Set<string>();
	for (const items of [a, b]) {
		const seen = new Set<string>();
		for (const value of items) {
			const base = baseOf(value, rows);
			(seen.has(base) ? repeated : seen).add(base);
		}
	}
	return repeated;
}

// Rows whose key repeats on either side pair by their whole content, since
// their order between the two answers is arbitrary.
function rowsOf(items: unknown[], rows: Rows, repeated: Set<string>): Row[] {
	const seen = new Map<string, number>();
	return items.map((value, index) => {
		const base = baseOf(value, rows);
		const key = repeated.has(base) ? `${base}#${canonical(value)}` : base;
		const count = seen.get(key) ?? 0;
		seen.set(key, count + 1);
		return {
			key: `${key}#${count}`,
			step: stepOf(value, index, rows),
			value,
			ties: tiesOf(value, rows),
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
	const full: (Cap & { path: string })[] = [];
	const opaque = new Set(shape.opaque);
	const clocks = new Set(shape.clocks);

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
				if (clocks.has(child) && sameFormat(a[key], b[key])) continue;
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
		const repeated = repeatedBases(a, b, rows);
		const left = rowsOf(a, rows, repeated);
		const right = rowsOf(b, rows, repeated);
		const inLeft = new Map(left.map((row) => [row.key, row]));
		const inRight = new Map(right.map((row) => [row.key, row]));
		const oneSided = [
			...left.filter((row) => !inRight.has(row.key)),
			...right.filter((row) => !inLeft.has(row.key)),
		];
		// Both sides run the same limit, so a full old list needs an equally full
		// new one, and only rows tied with its last row can fall either side of it.
		if (
			rows.cap &&
			a.length >= rows.cap.size &&
			b.length === a.length &&
			oneSided.every((row) => isDeepStrictEqual(row.ties, left.at(-1)?.ties))
		)
			full.push({ ...rows.cap, path });
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
	// A cap decides which rows lists hold and the note, never a held row's fields.
	const allowed = (d: Difference) =>
		full.some(
			(cap) =>
				[cap.path, ...cap.decides].includes(d.path) &&
				(!d.path.endsWith("[]") ||
					d.kind === "missing in new" ||
					d.kind === "missing in old"),
		);
	return {
		differences: differences.filter((d) => !allowed(d)),
		tiedRowsReordered,
		capAmbiguous: differences.filter(allowed),
	};
}
