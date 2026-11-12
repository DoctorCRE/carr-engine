import type { Difference } from "./answers.ts";
import type { Ask, Outcome, Run } from "./run.ts";

type Tally = Map<string, { records: number; ids: Set<string> }>;

const SHOWN_IDS = 5;
const RESULTS = [
	"matched",
	"tie order",
	"at cap",
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
		case "capture queue":
			return "capture queue";
		case "feed":
			return "change feed";
		case "find":
			return "search find";
		case "lead board":
			return "lead board";
		case "lead":
			return "lead detail";
		case "quiet follow-ups":
			return "quiet follow-ups";
		case "territory":
			return "territory";
		case "reasons to reach out":
			return "reasons to reach out";
		case "invoices":
			return "invoices";
	}
}
const recordOf = (ask: Ask) =>
	ask.read === "deal" ? ask.deal : ask.read === "lead" ? ask.lead : undefined;
const PREFIXES = {
	board: "board",
	deal: "detail",
	"client fit": "fit",
	"capture queue": "queue",
	feed: "feed",
	find: "find",
	"lead board": "leads",
	lead: "lead",
	"quiet follow-ups": "quiet",
	territory: "territory",
	"reasons to reach out": "reasons",
	invoices: "invoices",
};
const table = (rows: (string | number)[][]) =>
	rows.map((row) =>
		row
			.map((cell, i) =>
				i === 0 ? String(cell).padEnd(40) : String(cell).padStart(10),
			)
			.join("")
			.trimEnd(),
	);

function tally(into: Tally, prefix: string, ask: Ask, difference: Difference) {
	const key = `${prefix}.${difference.path}\t${difference.kind}`;
	const entry = into.get(key) ?? { records: 0, ids: new Set() };
	entry.records++;
	const id =
		difference.records.findLast((step) => "id" in step)?.id ?? recordOf(ask);
	if (id && entry.ids.size < SHOWN_IDS) entry.ids.add(id);
	into.set(key, entry);
}

const listed = (title: string, into: Tally) =>
	into.size === 0
		? []
		: [
				"",
				`${title}: field path, kind, records, first record IDs`,
				...[...into].map(([key, { records, ids }]) =>
					[...key.split("\t"), records, [...ids].join(", ") || "-"].join("  "),
				),
			];

export function report(target: string, run: Run): string {
	const lines = [
		`Old and new answers compared on ${target}`,
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

	const paths: Tally = new Map();
	const capped: Tally = new Map();
	const ties = new Map<string, number>();
	for (const outcome of run.outcomes) {
		if (!("comparison" in outcome)) continue;
		const prefix = PREFIXES[outcome.ask.read];
		for (const difference of outcome.comparison.differences)
			tally(paths, prefix, outcome.ask, difference);
		for (const difference of outcome.comparison.capAmbiguous)
			tally(capped, prefix, outcome.ask, difference);
		for (const place of new Set(
			outcome.comparison.tiedRowsReordered.map((p) => p.path),
		))
			ties.set(`${prefix}.${place}`, (ties.get(`${prefix}.${place}`) ?? 0) + 1);
	}
	lines.push(
		...listed("differences", paths),
		...listed("cap ambiguity, the old list was full", capped),
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
			"not compared: result, read, record ID",
			...open.map((o) =>
				[o.result, readOf(o.ask), recordOf(o.ask) ?? "-"].join("  "),
			),
		);
	return `${lines.join("\n")}\n`;
}
