const strict = (id: string) => ({ id, sortedBy: [] });

// `pages` are the paths of whole lead-board answers inside one compared answer.
// Their `generated_at` and each lead's `evaluated_at` are the time the answer
// was made, the only clock values the contract on #52 names.
function workspaceShape(...pages: string[]) {
	const leads = pages.flatMap((page) => [`${page}leads[]`, `${page}detail`]);
	return {
		rows: Object.fromEntries([
			...pages.flatMap((page) => [
				[`${page}leads[]`, strict("id")],
				[`${page}detail.correspondence[]`, strict("id")],
				[`${page}detail.stage_history[]`, strict("event_id")],
				[`${page}detail.research.evidence[]`, strict("flag_id")],
			]),
			...leads.flatMap((lead) => [
				[`${lead}.possible_clients[]`, strict("client_id")],
				[`${lead}.reachability.evidence[]`, strict("flag_id")],
				[`${lead}.reachability.source_inputs.activities[]`, strict("id")],
			]),
		]),
		opaque: [
			...leads.map((lead) => `${lead}.reachability.evidence[].value`),
			...pages.flatMap((page) => [
				`${page}detail.research.evidence[].value`,
				`${page}detail.stage_history[].stage_review`,
			]),
		],
		ignore: [
			...pages.map((page) => `${page}generated_at`),
			...leads.map((lead) => `${lead}.reachability.evaluated_at`),
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

export const reasonsShape = {
	rows: { "pages[].cards[]": strict("id") },
	opaque: ["pages[].cards[].facts"],
};
