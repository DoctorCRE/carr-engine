const strict = (id: string) => ({ id, sortedBy: [] });
const ignore = ["correlation_id"];

const vendors = strict("party_id");
const items = strict("id");

export const boardShape = {
	rows: {
		"deals[]": { id: "id", sortedBy: ["attention", "next_date", "name"] },
		"deals[].vendors[]": vendors,
		"deals[].items[]": items,
		"deals[].open_actions[]": strict("id"),
		"closed_deals[]": strict("id"),
		"closed_deals[].vendors[]": vendors,
		"lost_deals[]": strict("id"),
		"lost_deals[].vendors[]": vendors,
		"accounts[]": { id: "account_client_id", sortedBy: ["account_name"] },
	},
	opaque: ["deals[].items[].bullets", "deals[].phase_started_on"],
	ignore,
};

const checklistItems = strict("id");
const receipts = strict("id");

export const detailShape = {
	rows: {
		"vendors[]": vendors,
		"thread[]": strict("id"),
		"critical_dates[]": strict("id"),
		"next_actions[]": strict("id"),
		"items[]": items,
		"activities[]": strict("id"),
		"email_threads[]": strict("conversation_id"),
		"participants[]": { id: "party_id", sortedBy: ["role", "name"] },
		"premises[]": strict("id"),
		"negotiation_rounds[]": { sortedBy: ["round_no", "proposed_on"] },
		"documents[]": { id: "id", sortedBy: ["prepared_at"] },
		"events[]": strict("id"),
		"checklist.sources[]": strict("section_id"),
		"checklist.phases[]": strict("id"),
		"checklist.phases[].items[]": checklistItems,
		"checklist.phases[].items[].request.receipts[]": receipts,
		"checklist.due_items[]": checklistItems,
		"checklist.due_items[].request.receipts[]": receipts,
	},
	opaque: [
		"phase_started_on",
		"next_actions[].bullets",
		"items[].bullets",
		"activities[].email_context",
		"events[].old_value",
		"events[].new_value",
	],
	ignore,
};
