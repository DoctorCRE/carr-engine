import type { Ask, Outcome, Run } from "./run.ts";

const SHOWN_IDS = 5;
const RESULTS = [
	"matched",
	"tie order",
	"different",
	"unsettled",
	"failed",
] as const;

function readOf(ask: Ask) {
	switch (ask.read) {
		case "board":
			return `board ${ask.workspace}`;
		case "deal":
			return "deal detail";
		case "client fit":
			return "client fit";
	}
}
const PREFIXES = { board: "board", deal: "detail", "client fit": "fit" };
const table = (rows: (string | number)[][]) =>
	rows.map((row) =>
		row
			.map((cell, i) =>
				i === 0 ? String(cell).padEnd(40) : String(cell).padStart(10),
			)
			.join("")
			.trimEnd(),
	);

export function report(target: string, run: Run): string {
	const lines = [
		`Old and new Deals answers compared on ${target}`,
		`old reads made: ${run.oldReads}, engine reads made: ${run.engineReads}`,
	];
	if (run.stopped)
		lines.push(
			"stopped at a network or sign-in failure, later requests were not asked",
		);

	const reads = [...new Set(run.outcomes.map((o) => readOf(o.ask)))];
	lines.push(
		"",
		...table([
			["read", "asked", ...RESULTS],
			...reads.map((read) => {
				const mine = run.outcomes.filter((o) => readOf(o.ask) === read);
				return [
					read,
					mine.length,
					...RESULTS.map((r) => mine.filter((o) => o.result === r).length),
				];
			}),
		]),
	);

	const paths = new Map<string, { records: number; ids: Set<string> }>();
	const ties = new Map<string, number>();
	for (const outcome of run.outcomes) {
		if (!("comparison" in outcome)) continue;
		const prefix = PREFIXES[outcome.ask.read];
		for (const difference of outcome.comparison.differences) {
			const key = `${prefix}.${difference.path}\t${difference.kind}`;
			const entry = paths.get(key) ?? { records: 0, ids: new Set() };
			entry.records++;
			const id =
				difference.records.findLast((step) => "id" in step)?.id ??
				(outcome.ask.read === "deal" ? outcome.ask.deal : undefined);
			if (id && entry.ids.size < SHOWN_IDS) entry.ids.add(id);
			paths.set(key, entry);
		}
		for (const place of new Set(
			outcome.comparison.tiedRowsReordered.map((p) => p.path),
		))
			ties.set(`${prefix}.${place}`, (ties.get(`${prefix}.${place}`) ?? 0) + 1);
	}
	if (paths.size > 0)
		lines.push(
			"",
			"differences: field path, kind, records, first record IDs",
			...[...paths].map(([key, { records, ids }]) =>
				[...key.split("\t"), records, [...ids].join(", ") || "-"].join("  "),
			),
		);
	if (ties.size > 0)
		lines.push(
			"",
			"tied rows in another order: array path, requests",
			...[...ties].map(([path, count]) => `${path}  ${count}`),
		);

	const open = run.outcomes.filter(
		(o): o is Outcome & { result: "unsettled" | "failed" } =>
			o.result === "unsettled" || o.result === "failed",
	);
	if (open.length > 0)
		lines.push(
			"",
			"not compared: result, read, deal ID",
			...open.map((o) =>
				[
					o.result,
					readOf(o.ask),
					o.ask.read === "deal" ? o.ask.deal : "-",
				].join("  "),
			),
		);
	return `${lines.join("\n")}\n`;
}
