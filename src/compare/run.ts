import { WORKSPACES, type Workspace } from "../deals/board.ts";
import { UUID } from "../uuid.ts";
import { compareAnswers, isRecord } from "./answers.ts";
import {
	boardShape,
	captureQueueShape,
	clientFitShape,
	detailShape,
	feedShape,
} from "./deals-shapes.ts";
import { invoicesShape } from "./invoices-shape.ts";
import {
	leadBoardShape,
	leadShape,
	quietShape,
	reasonsShape,
	territoryShape,
} from "./leads-shapes.ts";
import { findShape } from "./search-shape.ts";

export class StopRun extends Error {}

export type Ask =
	| { read: "board"; workspace: Workspace }
	| { read: "deal"; deal: string }
	| { read: "client fit" }
	| { read: "capture queue" }
	| { read: "feed"; start: string }
	| { read: "find"; query: string }
	| { read: "lead board" }
	| { read: "lead"; lead: string }
	| { read: "quiet follow-ups" }
	| { read: "territory" }
	| { read: "reasons to reach out" }
	| { read: "invoices" };
type Fetch = (ask: Ask) => Promise<unknown>;
type Comparison = ReturnType<typeof compareAnswers>;
export type Outcome =
	| {
			ask: Ask;
			result: "matched" | "tie order" | "at cap" | "different";
			comparison: Comparison;
	  }
	| { ask: Ask; result: "unsettled" | "failed" };
export type Run = {
	outcomes: Outcome[];
	oldReads: number;
	engineReads: number;
	stopped: boolean;
};

function dealsOn(board: unknown) {
	if (!isRecord(board)) return [];
	return ["deals", "closed_deals", "lost_deals"].flatMap((key) => {
		const list = board[key];
		return Array.isArray(list) ? list.filter(isRecord) : [];
	});
}

const SHAPES = {
	board: boardShape,
	deal: detailShape,
	"client fit": clientFitShape,
	"capture queue": captureQueueShape,
	feed: feedShape,
	find: findShape,
	"lead board": leadBoardShape,
	lead: leadShape,
	"quiet follow-ups": quietShape,
	territory: territoryShape,
	"reasons to reach out": reasonsShape,
	invoices: invoicesShape,
};

// Each opened lead re-sends the whole board, so a fixed number spread over the
// board's order is opened.
const LEADS_OPENED = 25;

function leadsOn(board: unknown) {
	const leads =
		isRecord(board) && Array.isArray(board.leads) ? board.leads : [];
	const ids = leads.flatMap((lead) =>
		isRecord(lead) && typeof lead.id === "string" && UUID.test(lead.id)
			? [lead.id]
			: [],
	);
	// Picks exactly LEADS_OPENED evenly spaced IDs, or all when fewer.
	return ids.filter((_, n) => (n * LEADS_OPENED) % ids.length < LEADS_OPENED);
}

// Each find costs one old read, so the names asked stay few. The probes are
// the wildcards the old query passed through unescaped, and a blank.
const FIND_NAMES = 12;
const PROBES = ["%", "_", " "];

const FEED_DAYS = 3;

// Built as the app builds its start cursor: a time and the zero ID, base64url without padding.
function feedStart(now: number) {
	const recorded_at = new Date(now - FEED_DAYS * 86_400_000).toISOString();
	return btoa(
		JSON.stringify({ recorded_at, id: "00000000-0000-0000-0000-000000000000" }),
	)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
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
	const queue: Ask[] = [
		...WORKSPACES.map((workspace) => ({ read: "board", workspace }) as const),
		{ read: "client fit" },
		{ read: "capture queue" },
		// Every read of the feed starts here. A write between the reads shows as an unsettled feed.
		{ read: "feed", start: feedStart(Date.now()) },
		...PROBES.map((query) => ({ read: "find", query }) as const),
		{ read: "lead board" },
		// The app's inputs: no filters, and the first page of reasons.
		{ read: "quiet follow-ups" },
		{ read: "territory" },
		{ read: "reasons to reach out" },
		{ read: "invoices" },
	];
	const queued = new Set(queue.map((ask) => JSON.stringify(ask)));
	let names = 0;
	const enqueue = (ask: Ask) => {
		const key = JSON.stringify(ask);
		if (queued.has(key)) return false;
		queued.add(key);
		queue.push(ask);
		return true;
	};
	for (const [index, ask] of queue.entries()) {
		if (index > 0) await pause();
		const shape = SHAPES[ask.read];
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
			for (const { id, client_name } of dealsOn(old)) {
				if (typeof id === "string" && UUID.test(id))
					enqueue({ read: "deal", deal: id });
				if (
					typeof client_name === "string" &&
					names < FIND_NAMES &&
					enqueue({ read: "find", query: client_name })
				)
					names++;
			}
		if (ask.read === "lead board")
			for (const lead of leadsOn(old)) enqueue({ read: "lead", lead });
		const settled = compareAnswers(first, second, shape);
		if (settled.differences.length + settled.capAmbiguous.length > 0) {
			run.outcomes.push({ ask, result: "unsettled" });
			continue;
		}
		const comparison = compareAnswers(old, first, shape);
		const result =
			comparison.differences.length > 0
				? "different"
				: comparison.capAmbiguous.length > 0
					? "at cap"
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
