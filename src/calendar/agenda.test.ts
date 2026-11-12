import assert from "node:assert/strict";
import { test } from "node:test";
import { agendaFromSnapshot, type Meeting, UNAVAILABLE } from "./agenda.ts";

const NOW = new Date("2026-11-12T15:00:00.000Z");
const at = (hours: number) =>
	new Date(NOW.getTime() + hours * 3_600_000).toISOString();
const snapshot = (items: unknown[], extra: Record<string, unknown> = {}) => ({
	schema: "carr-calendar-agenda.v1",
	observed_at: at(-1),
	items,
	...extra,
});
const meeting = (start: number, hours: number, title: string) => ({
	start: at(start),
	end: at(start + hours),
	title,
});
const agenda = (stored: unknown) => {
	const read = agendaFromSnapshot(stored, NOW);
	assert.ok(read.state !== "unavailable");
	return read;
};
const titles = (items: readonly Meeting[]) => items.map((m) => m.title);

test("a missing or unreadable snapshot is unavailable", () => {
	for (const stored of [
		undefined,
		snapshot([], { schema: "carr-calendar-agenda.v2" }),
		snapshot([], { observed_at: "2026-02-30T00:00:00Z" }),
		snapshot([], { items: {} }),
	])
		assert.deepEqual(agendaFromSnapshot(stored, NOW), UNAVAILABLE);
});

test("the agenda shows the next seven days of meetings in the old keys", () => {
	const read = agenda(
		snapshot([
			meeting(-3, 1, "Over"),
			meeting(24 * 7, 1, "Past the week"),
			{
				...meeting(2, 1, "  Example tour  "),
				organizer: { name: "Example Organizer", email: " Org@Example.TEST " },
				attendees: [{ name: "Example Client" }, "x"],
			},
		]),
	);
	assert.equal(
		JSON.stringify(read),
		JSON.stringify({
			state: "ready",
			source: "outlook_local_store",
			notes: [],
			observed_at: at(-1),
			sources: { outlook_calendar: { state: "ready" } },
			items: [
				{
					start: at(2),
					end: at(3),
					title: "Example tour",
					location: null,
					organizer: { name: "Example Organizer", email: "org@example.test" },
					attendees: [
						{ name: "Example Client", email: null },
						{ name: null, email: null },
					],
					attendee_count: 2,
					all_day: false,
					recurring: false,
					time_changed: false,
					times: [],
					conflict: false,
					schedule_conflict: false,
					schedule_conflicts: [],
					schedule_conflicts_omitted: 0,
				},
			],
		}),
	);
	assert.equal(agenda(snapshot([])).state, "empty");
});

test("meetings sort by start, then title, and overlaps list up to five conflicts", () => {
	const read = agenda(
		snapshot([
			meeting(1, 4, "Long"),
			...[0, 1, 2, 3, 4, 5].map((n) => meeting(1 + n / 2, 0.5, `Short ${n}`)),
			{ ...meeting(1, 1, "All day"), all_day: true },
		]),
	);
	const [allDay, long] = read.items;
	assert.deepEqual(titles(read.items).slice(0, 4), [
		"All day",
		"Long",
		"Short 0",
		"Short 1",
	]);
	assert.deepEqual(
		[
			long?.schedule_conflicts.map((c) => c.title),
			long?.schedule_conflicts_omitted,
		],
		[["Short 0", "Short 1", "Short 2", "Short 3", "Short 4"], 1],
	);
	assert.deepEqual(long?.schedule_conflicts[1], {
		title: "Short 1",
		start: at(1.5),
		end: at(2),
		overlap_start: at(1.5),
		overlap_end: at(2),
	});
	assert.equal(allDay?.schedule_conflict, false);
});

test("each gap in the snapshot becomes a note and makes the agenda partial", () => {
	const read = agenda(
		snapshot(
			[
				meeting(1, 1, "Kept"),
				{ ...meeting(2, 1, "Odd times"), times: [at(2), "bad"] },
				meeting(3, -1, "Backwards"),
				{ ...meeting(3, 1, " ") },
			],
			{
				observed_at: at(-19),
				warnings: [
					{ code: "undecoded", count: 2 },
					{ code: "trimmed", count: 1 },
					{ code: "unknown" },
				],
			},
		),
	);
	assert.deepEqual(
		{
			state: read.state,
			notes: read.notes,
			sources: read.sources,
			malformed: read.malformed_items,
		},
		{
			state: "partial",
			notes: [
				"2 calendar items in Outlook couldn't be read, so meetings may be missing.",
				"1 later meeting was left out to keep the brief small.",
				"This calendar has a gap the brief cannot describe. Check Outlook.",
				"2 stored meetings could not be shown.",
				"1 stored alternate time could not be shown. Check Outlook for the current time.",
				"This calendar was last read from Outlook more than 18 hours ago.",
			],
			sources: { outlook_calendar: { state: "stale" } },
			malformed: 2,
		},
	);
	assert.deepEqual(agenda(snapshot([], { observed_at: at(1) })).notes, [
		"This calendar's observation time is in the future. Refresh Outlook before reviewing meetings.",
	]);
});

test("meetings that ended in the last day ask for an outcome review", () => {
	const review = (key: string, end: number) => ({
		key,
		title: "Example review",
		prompt: "How did it go?",
		state: "needs_review",
		start: at(end - 1),
		end: at(end),
	});
	const reviews = [
		review("0123456789abcdef", -2),
		review("fedcba9876543210", -1.5),
		review("aaaaaaaaaaaaaaaa", -24),
		review("not-a-key", -2),
	];
	const read = agenda(snapshot([], { follow_up_reviews: reviews }));
	assert.deepEqual(
		read.follow_up_reviews?.map((r) => r.key),
		["fedcba9876543210", "0123456789abcdef"],
	);
	assert.deepEqual(read.notes, [
		"These are scheduled meetings, not confirmed attendance. Confirm each happened before recording an outcome or next step.",
		"1 stored meeting outcome review could not be shown.",
	]);
	const stale = agenda(
		snapshot([], {
			observed_at: at(-19),
			follow_up_reviews: [review("0123456789abcdef", -20)],
		}),
	);
	assert.deepEqual(stale.follow_up_reviews, []);
	assert.equal("follow_up_reviews" in agenda(snapshot([])), false);
});
