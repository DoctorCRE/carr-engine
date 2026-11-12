const viaLink = ["deals_via_link[]", "note"];
const derived = ["lead_client_links[]", ...viaLink];

// The old order is ranked on values the answer leaves out (similarity, link
// time) or on nothing, so those lists compare as sets (decision 13).
export const findShape = {
	rows: {
		"parties[]": {
			id: "ref",
			ref: "ref",
			sortedBy: ["merged"],
			cap: { size: 10, decides: derived },
		},
		"organizations[]": {
			id: "name",
			unordered: true,
			cap: { size: 5, decides: derived },
		},
		"deals[]": {
			key: ["name", "client_ref"],
			ref: "client_ref",
			unordered: true,
			cap: { size: 5, decides: viaLink },
		},
		"connections[]": {
			key: ["from_ref", "to_ref", "kind"],
			ref: "from_ref",
			unordered: true,
			cap: { size: 12, decides: [] },
		},
		"lead_client_links[]": {
			id: "lead_ref",
			ref: "lead_ref",
			sortedBy: ["link_basis", "lead_ref"],
			cap: { size: 20, decides: viaLink },
		},
		"deals_via_link[]": {
			key: ["name", "client_ref"],
			ref: "client_ref",
			sortedBy: ["client_ref", "name"],
		},
	},
	ignore: ["correlation_id"],
} as const;
