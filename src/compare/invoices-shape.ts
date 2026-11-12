// A deal with several commissions repeats its deal_id, so those rows pair by
// their whole content.
export const invoicesShape = {
	rows: {
		"entries[]": {
			id: "deal_id",
			sortedBy: ["name", "commission_invoiced_on", "commission_id"],
		},
	},
	clocks: ["observed_at"],
} as const;
