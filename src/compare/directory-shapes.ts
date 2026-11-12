import { type ReadShape, strict } from "./answers.ts";

const source = [
	"source.observed_at",
	"source.valid_until",
	"source.correlation_id",
];
const slugs = (...lists: string[]) =>
	Object.fromEntries(lists.map((list) => [`facets.${list}[]`, strict("slug")]));
// The old order left ties unordered (decision 16), and introductions are
// ordered by a time the answer leaves out.
const trackRecord = (row: string) => ({
	[`${row}.relationship.recent_entries[]`]: { id: "id", sortedBy: ["when"] },
	[`${row}.relationship.introductions[]`]: { id: "id", unordered: true },
});
const people = strict("contact.id");

export const clientListShape: ReadShape = {
	rows: { "rows[]": strict("id"), ...slugs("statuses", "types") },
	clocks: source,
};

export const vendorListShape: ReadShape = {
	rows: {
		"rows[]": strict("id"),
		...trackRecord("rows[]"),
		...slugs("categories", "stages", "dispositions", "territories"),
	},
	clocks: source,
};

export const clientShape: ReadShape = { rows: {}, clocks: source };

export const vendorShape: ReadShape = {
	rows: { ...trackRecord("record"), "record.people[]": people },
	opaque: ["record.loan_programs"],
	clocks: source,
};

export const marketsShape: ReadShape = {
	rows: {
		"markets[]": strict("slug"),
		"markets[].memberships[]": strict("vendor_id"),
		"markets[].regional_references[]": strict("regional_slug"),
		"vendors[]": strict("id"),
		"vendors[].people[]": people,
	},
};

export const networkShape: ReadShape = {
	rows: {
		"nodes[]": strict("record_id"),
		"edges[]": strict("id"),
		"referrals[]": strict("node_id"),
		"suggestions[]": strict("id"),
	},
	clocks: ["observed_at", "valid_until"],
};

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
