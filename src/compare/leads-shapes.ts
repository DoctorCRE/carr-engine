import { type ReadShape, strict } from "./answers.ts";

// `pages` are the paths of whole lead-board answers inside one compared answer.
// Their `generated_at` and each lead's `evaluated_at` are the time the answer
// was made, the only clock values the contract on #52 names.
function workspaceShape(...pages: string[]) {
	const leadObjects = pages.flatMap((page) => [
		`${page}leads[]`,
		`${page}detail`,
	]);
	return {
		rows: Object.fromEntries([
			...pages.flatMap((page) => [
				[`${page}leads[]`, strict("id")],
				[`${page}detail.correspondence[]`, strict("id")],
				[`${page}detail.stage_history[]`, strict("event_id")],
				[`${page}detail.research.evidence[]`, strict("flag_id")],
			]),
			...leadObjects.flatMap((lead) => [
				[`${lead}.possible_clients[]`, strict("client_id")],
				[`${lead}.reachability.evidence[]`, strict("flag_id")],
				[`${lead}.reachability.source_inputs.activities[]`, strict("id")],
			]),
		]),
		opaque: [
			...leadObjects.map((lead) => `${lead}.reachability.evidence[].value`),
			...pages.flatMap((page) => [
				`${page}detail.research.evidence[].value`,
				`${page}detail.stage_history[].stage_review`,
			]),
		],
		clocks: [
			...pages.map((page) => `${page}generated_at`),
			...leadObjects.map((lead) => `${lead}.reachability.evaluated_at`),
		],
	};
}

export const leadBoardShape = workspaceShape("");

export const leadShape = workspaceShape(
	"opened.",
	"older_correspondence[].",
	"older_stage_history[].",
);

export const quietShape = { rows: { "proposals[]": strict("subject_id") } };

export const territoryShape = {
	rows: {
		"submarkets[]": { key: ["state", "city"], sortedBy: [] },
		"submarkets[].evidence[]": strict("flag_id"),
	},
};

export const reasonsShape: ReadShape = {
	rows: { "pages[].cards[]": { ...strict("id"), serial: true } },
	opaque: ["pages[].cards[].facts"],
};
