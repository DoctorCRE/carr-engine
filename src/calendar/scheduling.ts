import type { Meeting, meetingsFromSnapshot } from "./meetings.ts";

type Section = NonNullable<ReturnType<typeof meetingsFromSnapshot>>;
type Shown = Extract<Section, { sources: unknown }>;

const DAY_MS = 86_400_000;
const MINIMUM_MS = 30 * 60_000;
// Gaps the snapshot reports that still leave its stored meetings complete.
const HARMLESS = new Set([
	"responses_unverified",
	"group_invites_not_shown",
	"recurring_unverified",
	"follow_up_trimmed",
	"canceled_hidden",
]);

const iso = (ms: number) => new Date(ms).toISOString();

function harmless(warning: unknown) {
	if (typeof warning !== "object" || warning === null || !("code" in warning))
		return false;
	const count = "count" in warning ? warning.count : undefined;
	const counted =
		count === undefined ||
		(typeof count === "number" && Number.isSafeInteger(count) && count >= 1);
	return (
		typeof warning.code === "string" && HARMLESS.has(warning.code) && counted
	);
}

function complete(snapshot: object, section: Shown, now: number) {
	const warnings = "warnings" in snapshot ? snapshot.warnings : undefined;
	return (
		section.sources.outlook_calendar.state !== "stale" &&
		Date.parse(section.observed_at) <= now &&
		!("malformed_items" in section) &&
		section.items.length < 100 &&
		section.items.every(
			(m) => !m.time_changed && !m.conflict && m.end > m.start,
		) &&
		(warnings === undefined ||
			(Array.isArray(warnings) && warnings.every(harmless)))
	);
}

function openings(meetings: readonly Meeting[], from: number, to: number) {
	const found: { start: string; end: string }[] = [];
	const gap = (start: number, end: number) => {
		if (end - start >= MINIMUM_MS)
			found.push({ start: iso(start), end: iso(end) });
	};
	const busy = meetings
		.map((m) => [Date.parse(m.start), Date.parse(m.end)] as const)
		.filter(([start, end]) => end > start && start < to && end > from)
		.sort((a, b) => a[0] - b[0]);
	let cursor = from;
	for (const [start, end] of busy) {
		gap(cursor, Math.min(start, to));
		cursor = Math.max(cursor, Math.min(end, to));
	}
	gap(cursor, to);
	return found;
}

// Candidate openings of half an hour or more in the next day, offered only
// when the snapshot leaves no stored meeting in doubt.
export function scheduling(snapshot: unknown, section: Section, now: Date) {
	const from = now.getTime();
	const to = from + DAY_MS;
	const context = {
		window: { start: iso(from), end: iso(to) },
		minimum_duration_minutes: 30,
		note: "Candidate openings from stored meetings, not confirmed availability. May include overnight hours. Check Outlook before booking.",
	};
	const unavailable = (reason: string) => ({
		...context,
		state: "unavailable",
		reason,
		items: [],
	});
	if (!("sources" in section) || typeof snapshot !== "object" || !snapshot)
		return unavailable("source_unavailable");
	if (!complete(snapshot, section, from))
		return unavailable("calendar_coverage_insufficient");
	const items = openings(section.items, from, to);
	const state = !items.length
		? "empty"
		: section.state === "partial"
			? "partial"
			: "ready";
	return { ...context, state, items };
}
