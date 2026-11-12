import { type ReadShape, strict } from "./answers.ts";

const source = [
	"source.observed_at",
	"source.valid_until",
	"source.correlation_id",
];

export const clientListShape: ReadShape = {
	rows: {
		"rows[]": strict("id"),
		"facets.statuses[]": strict("slug"),
		"facets.types[]": strict("slug"),
	},
	clocks: source,
};

export const clientShape: ReadShape = { rows: {}, clocks: source };

// Rows at one moment came back in no set order, and the app's limit of 10 can
// cut inside such a tie (decision 17).
export const activityShape: ReadShape = {
	rows: {
		"candidates[]": { id: "target", ref: "target", sortedBy: [] },
		"catch_up.timeline[]": {
			key: ["occurred_at", "entry_kind"],
			sortedBy: ["occurred_at"],
			cap: { size: 10, decides: [] },
		},
		"catch_up.calendar_history[]": strict("activity_id"),
	},
	opaque: ["catch_up.timeline[].detail"],
};
