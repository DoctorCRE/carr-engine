import { strict } from "./answers.ts";

export const todayShape = { rows: { "pages[].items[]": strict("id") } };

// Meetings come sorted by start, then title, and carry no ID.
export const meetingPrepShape = {
	rows: {
		"items[]": { key: ["start", "title"], sortedBy: [] },
		"items[].possible_deals[]": strict("id"),
		"follow_up_reviews[]": { id: "key", sortedBy: [] },
	},
};

// A vendor appears once per listed person, or once with no contact.
export const vendorMeetingsShape = {
	rows: {
		"pages[].items[]": {
			key: ["vendor_id", "contact.id"],
			ref: "ref",
			sortedBy: [],
		},
		"pages[].items[].possible_meetings[]": {
			key: ["start", "title"],
			sortedBy: [],
		},
	},
};
