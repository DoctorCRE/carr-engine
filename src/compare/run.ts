import { compareAnswers, UUID } from "./answers.ts";
import { boardShape, detailShape } from "./deals-shapes.ts";

const WORKSPACES = ["team", "national_account", "all"] as const;

export class StopRun extends Error {}

export type Ask =
	| { read: "board"; workspace: (typeof WORKSPACES)[number] }
	| { read: "deal"; deal: string };
type Fetch = (ask: Ask) => Promise<unknown>;
type Comparison = ReturnType<typeof compareAnswers>;
export type Outcome =
	| {
			ask: Ask;
			result: "matched" | "tie order" | "different";
			comparison: Comparison;
	  }
	| { ask: Ask; result: "unsettled" | "failed" };
export type Run = {
	outcomes: Outcome[];
	oldReads: number;
	engineReads: number;
	stopped: boolean;
};

function dealsOn(board: unknown): string[] {
	if (typeof board !== "object" || board === null) return [];
	const lists = ["deals", "closed_deals", "lost_deals"].map((key) =>
		Object.hasOwn(board, key) ? (board as Record<string, unknown>)[key] : [],
	);
	return lists
		.flatMap((list) => (Array.isArray(list) ? list : []))
		.map((deal) => (typeof deal === "object" && deal ? deal.id : undefined))
		.filter((id): id is string => typeof id === "string" && UUID.test(id));
}

export async function compareDeals(
	askEngine: Fetch,
	askOld: Fetch,
	pause: () => Promise<void>,
): Promise<Run> {
	const run: Run = {
		outcomes: [],
		oldReads: 0,
		engineReads: 0,
		stopped: false,
	};
	const queue: Ask[] = WORKSPACES.map((workspace) => ({
		read: "board",
		workspace,
	}));
	const queued = new Set<string>();
	for (const [index, ask] of queue.entries()) {
		if (index > 0) await pause();
		const shape = ask.read === "board" ? boardShape : detailShape;
		let answers: unknown[];
		try {
			run.engineReads++;
			const first = await askEngine(ask);
			run.oldReads++;
			const old = await askOld(ask);
			run.engineReads++;
			answers = [first, old, await askEngine(ask)];
		} catch (error) {
			run.outcomes.push({ ask, result: "failed" });
			if (!(error instanceof StopRun)) continue;
			run.stopped = true;
			return run;
		}
		const [first, old, second] = answers;
		if (ask.read === "board")
			for (const deal of dealsOn(old))
				if (!queued.has(deal)) {
					queued.add(deal);
					queue.push({ read: "deal", deal });
				}
		if (compareAnswers(first, second, shape).differences.length > 0) {
			run.outcomes.push({ ask, result: "unsettled" });
			continue;
		}
		const comparison = compareAnswers(old, first, shape);
		const result =
			comparison.differences.length > 0
				? "different"
				: comparison.tiedRowsReordered.length > 0
					? "tie order"
					: "matched";
		run.outcomes.push({ ask, result, comparison });
	}
	return run;
}

export function exitCode(run: Run): 0 | 1 | 2 {
	const results = new Set(run.outcomes.map((outcome) => outcome.result));
	if (results.has("failed")) return 2;
	return results.has("different") || results.has("unsettled") ? 1 : 0;
}
