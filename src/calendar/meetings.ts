// The Outlook job on a partner's Mac publishes their next fourteen days of
// meetings as one snapshot; this shows the next seven. Every gap the snapshot
// reports becomes a note, and an answer with any note is partial.
const SCHEMA = "carr-calendar-agenda.v1";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SHOWN = 100;
const CONFLICTS_SHOWN = 5;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const WARNINGS: Record<string, (n: number) => string> = {
	responses_unverified: () =>
		"May include meetings you declined or that were cancelled or deleted. Check Outlook.",
	group_invites_not_shown: () =>
		"Invites sent only to a group you belong to are not shown.",
	undecoded: (n) =>
		`${n} calendar ${plural(n, "item", "items")} in Outlook couldn't be read, so meetings may be missing.`,
	time_changed: (n) =>
		`${n} ${plural(n, "meeting has", "meetings have")} more than one stored time. Check Outlook for the current time.`,
	recurring_unverified: () =>
		"Recurring meetings show only the occurrences Outlook stored; some may be missing.",
	canceled_hidden: (n) =>
		`${n} cancelled ${plural(n, "meeting was", "meetings were")} left out.`,
	follow_up_trimmed: (n) =>
		`${n} meeting outcome ${plural(n, "review was", "reviews were")} left out to keep the brief small.`,
	trimmed: (n) =>
		`${n} later ${plural(n, "meeting was", "meetings were")} left out to keep the brief small.`,
};

type Person = { name: string | null; email: string | null };
type Conflict = Record<
	"title" | "start" | "end" | "overlap_start" | "overlap_end",
	string
>;
export type Meeting = {
	start: string;
	end: string;
	title: string;
	location: string | null;
	organizer: Person;
	attendees: Person[];
	attendee_count: number;
	all_day: boolean;
	recurring: boolean;
	time_changed: boolean;
	times: string[];
	conflict: boolean;
	schedule_conflict: boolean;
	schedule_conflicts: Conflict[];
	schedule_conflicts_omitted: number;
};

export const UNAVAILABLE = {
	state: "unavailable",
	reason: "source_unavailable",
	items: [],
} as const;

const field = (value: unknown, key: string): unknown =>
	typeof value === "object" && value !== null
		? Reflect.get(value, key)
		: undefined;

const STAMP =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):?(\d{2}))$/;

const daysIn = (year: number, month: number) => {
	if (month !== 2) return [4, 6, 9, 11].includes(month) ? 30 : 31;
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
};

// Milliseconds since the epoch, or null for anything but a real ISO instant.
function instant(value: unknown) {
	const match = typeof value === "string" ? STAMP.exec(value) : null;
	if (!match) return null;
	const [y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0, oh = 0, om = 0] = match
		.slice(1)
		.map((part) => Number(part ?? 0));
	const realDate =
		y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
	if (!realDate || h > 23 || mi > 59 || s > 59 || oh > 23 || om > 59)
		return null;
	const parsed = Date.parse(match[0]);
	return Number.isFinite(parsed) ? parsed : null;
}

const iso = (ms: number) => new Date(ms).toISOString();

const text = (value: unknown) =>
	typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;

const person = (value: unknown): Person => ({
	name: text(field(value, "name")),
	email: text(field(value, "email"))?.toLowerCase() ?? null,
});

function alternateTimes(listed: unknown) {
	if (!Array.isArray(listed))
		return { shown: [], unread: listed === undefined ? 0 : 1 };
	const parsed = listed.map(instant);
	const shown = parsed.filter((at) => at !== null).map(iso);
	return { shown, unread: parsed.length - shown.length };
}

function meetingFrom(
	row: unknown,
	{ start, end, title }: { start: number; end: number; title: string },
	times: string[],
): Meeting {
	const listed = field(row, "attendees");
	const attendees = Array.isArray(listed) ? listed.map(person) : [];
	const count = field(row, "attendee_count");
	return {
		start: iso(start),
		end: iso(end),
		title,
		location: text(field(row, "location")),
		organizer: person(field(row, "organizer")),
		attendees,
		attendee_count:
			typeof count === "number" && Number.isSafeInteger(count)
				? count
				: attendees.length,
		all_day: field(row, "all_day") === true,
		recurring: field(row, "recurring") === true,
		time_changed: field(row, "time_changed") === true,
		times,
		conflict: field(row, "conflict") === true,
		schedule_conflict: false,
		schedule_conflicts: [],
		schedule_conflicts_omitted: 0,
	};
}

const timed = (meeting: Meeting) =>
	!meeting.all_day && meeting.end > meeting.start;

// Meetings arrive sorted by start, so each one's overlaps follow it.
function markConflicts(meetings: Meeting[]) {
	for (const [i, a] of meetings.entries()) {
		if (!timed(a)) continue;
		for (const b of meetings.slice(i + 1)) {
			if (b.start >= a.end) break;
			if (!timed(b)) continue;
			a.schedule_conflict = b.schedule_conflict = true;
			// biome-ignore lint/complexity/useMathMinMax: ISO strings, not numbers.
			const overlap_end = a.end < b.end ? a.end : b.end;
			for (const [meeting, other] of [
				[a, b],
				[b, a],
			] as const) {
				if (meeting.schedule_conflicts.length < CONFLICTS_SHOWN)
					meeting.schedule_conflicts.push({
						title: other.title,
						start: other.start,
						end: other.end,
						overlap_start: b.start,
						overlap_end,
					});
				else meeting.schedule_conflicts_omitted++;
			}
		}
	}
}

function warningNote(warning: unknown) {
	const count = field(warning, "count");
	const n =
		typeof count === "number" && Number.isSafeInteger(count) && count > 0
			? count
			: 1;
	// The old lookup keyed on String(code), so ["trimmed"] counted too.
	const code = String(field(warning, "code"));
	const say = Object.hasOwn(WARNINGS, code) && WARNINGS[code];
	return say
		? say(n)
		: "This calendar has a gap the brief cannot describe. Check Outlook.";
}

function reviewFrom(row: unknown) {
	const start = instant(field(row, "start"));
	const end = instant(field(row, "end"));
	const key = field(row, "key");
	const title = text(field(row, "title"));
	const prompt = text(field(row, "prompt"));
	const valid =
		field(row, "state") === "needs_review" &&
		typeof key === "string" &&
		/^[a-f0-9]{16}$/.test(key) &&
		start !== null &&
		end !== null &&
		end > start;
	return valid && title && prompt
		? { key, title, start, end, state: "needs_review" as const, prompt }
		: null;
}

// Null when the partner never published a snapshot, so each caller says that
// its own way.
export function meetingsFromSnapshot(snapshot: unknown, now: Date) {
	if (snapshot === undefined || snapshot === null) return null;
	const nowMs = now.getTime();
	const observed = instant(field(snapshot, "observed_at"));
	const rows = field(snapshot, "items");
	const schema = field(snapshot, "schema");
	if (schema !== SCHEMA || observed === null || !Array.isArray(rows))
		return UNAVAILABLE;
	let malformed = 0;
	let unread = 0;
	const meetings: Meeting[] = [];
	for (const row of rows) {
		const start = instant(field(row, "start"));
		const end = instant(field(row, "end"));
		const title = text(field(row, "title"));
		if (start === null || end === null || end < start || !title) malformed++;
		else if (end > nowMs && start < nowMs + 7 * DAY_MS) {
			const times = alternateTimes(field(row, "times"));
			meetings.push(meetingFrom(row, { start, end, title }, times.shown));
			unread += times.unread;
		}
	}
	meetings.sort(
		(a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title),
	);
	markConflicts(meetings);

	const stale = nowMs - observed > 18 * HOUR_MS;
	const future = observed > nowMs;
	const listed = field(snapshot, "follow_up_reviews");
	const parsed = Array.isArray(listed) ? listed.map(reviewFrom) : [];
	const valid = parsed.filter((review) => review !== null);
	const reviews = valid
		.filter(
			(review) =>
				!stale &&
				!future &&
				review.end <= Math.min(observed, nowMs) &&
				review.end > nowMs - DAY_MS,
		)
		.map((review) => ({
			...review,
			start: iso(review.start),
			end: iso(review.end),
		}))
		.sort((a, b) => b.end.localeCompare(a.end) || a.key.localeCompare(b.key));
	const malformedReviews =
		parsed.length -
		valid.length +
		(listed !== undefined && !Array.isArray(listed) ? 1 : 0);

	const warnings = field(snapshot, "warnings");
	const notes = (Array.isArray(warnings) ? warnings : []).map(warningNote);
	if (malformed)
		notes.push(
			`${malformed} stored ${plural(malformed, "meeting", "meetings")} could not be shown.`,
		);
	if (unread)
		notes.push(
			`${unread} stored alternate ${plural(unread, "time", "times")} could not be shown. Check Outlook for the current time.`,
		);
	if (meetings.length > SHOWN)
		notes.push(`Only the first ${SHOWN} meetings are shown.`);
	if (reviews.length)
		notes.push(
			"These are scheduled meetings, not confirmed attendance. Confirm each happened before recording an outcome or next step.",
		);
	if (malformedReviews)
		notes.push(
			`${malformedReviews} stored meeting outcome ${plural(malformedReviews, "review", "reviews")} could not be shown.`,
		);
	if (reviews.length > SHOWN)
		notes.push(`Only the first ${SHOWN} meeting outcome reviews are shown.`);
	if (future)
		notes.push(
			"This calendar's observation time is in the future. Refresh Outlook before reviewing meetings.",
		);
	if (stale)
		notes.push(
			"This calendar was last read from Outlook more than 18 hours ago.",
		);

	const partial = notes.length > 0;
	return {
		state: partial ? "partial" : meetings.length ? "ready" : "empty",
		source: "outlook_local_store",
		notes,
		observed_at: iso(observed),
		sources: {
			outlook_calendar: {
				state: stale ? "stale" : partial ? "partial" : "ready",
			},
		},
		...(malformed ? { malformed_items: malformed } : {}),
		items: meetings.slice(0, SHOWN),
		...(listed !== undefined
			? { follow_up_reviews: reviews.slice(0, SHOWN) }
			: {}),
	} as const;
}
