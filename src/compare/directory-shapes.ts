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
// A market's ID is its slug; a map ID is a kind and record UUIDs, such as
// `link:<uuid>` or `evidence:<uuid>:<uuid>:<role>`.
const bySlug = (id: string) => ({
	...strict(id),
	printable: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
});
const byMapId = (id: string) => ({
	...strict(id),
	printable: /^[a-z-]+:[0-9a-f-]{36}(?::[0-9a-f-]{36}:[a-z_]+)?$/,
});

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
		"markets[]": bySlug("slug"),
		"markets[].memberships[]": strict("vendor_id"),
		"markets[].regional_references[]": bySlug("regional_slug"),
		"vendors[]": strict("id"),
		"vendors[].people[]": people,
	},
};

export const networkShape: ReadShape = {
	rows: {
		"nodes[]": strict("record_id"),
		"edges[]": byMapId("id"),
		"referrals[]": byMapId("node_id"),
		"suggestions[]": byMapId("id"),
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
