import { sql } from "kysely";
import { isoMillis } from "../answer.ts";
import { resolveSubject } from "../deals/resolve.ts";
import type { Reader } from "../reader.ts";
import { readFind } from "../search/find.ts";

const CANDIDATE_CAP = 25;
const CALENDAR_CAP = 5000;

type Found = Awaited<ReturnType<typeof readFind>>;
type Candidate = { kind: string; name: string; target: string };

// The ref columns the old calendar history matched an activity on.
const SUBJECT_COLUMN: Record<string, string> = {
	deal: "deal_id",
	client: "client_id",
	lead: "lead_id",
	vendor: "vendor_id",
	party: "party_id",
};

const TOOL_CALL_MARKERS = ["<parameter", "</parameter", "<invoke", "</invoke"];

// The old door refused a value carrying its own closing tag, or a marker
// outside a backtick pair on one line.
export function hasToolCallMarkup(field: string, value: string) {
	if (value.includes(`</${field}>`)) return true;
	return TOOL_CALL_MARKERS.some((marker) => {
		for (
			let at = value.indexOf(marker);
			at !== -1;
			at = value.indexOf(marker, at + 1)
		) {
			const before = value.lastIndexOf("`", at);
			const after = value.indexOf("`", at);
			if (
				before === -1 ||
				after === -1 ||
				value.slice(before, after).includes("\n")
			)
				return true;
		}
		return false;
	});
}

const REF_KINDS = [
	[/^L-/i, "lead"],
	[/^C-/i, "client"],
	[/^[VT]-/i, "vendor"],
	[/^P-/i, "party"],
] as const;

const kindFromRef = (ref: string) =>
	REF_KINDS.find(([pattern]) => pattern.test(ref))?.[1] ?? "record";

// Live refs once each, then every name-matched deal, in the old JavaScript order.
function candidatesOf(found: Found): Candidate[] {
	const byRef = new Map<string, Candidate>();
	const add = (ref: string, name: string | null, kind: string | null) => {
		const target = ref.trim();
		if (target && !byRef.has(target))
			byRef.set(target, {
				kind: kind || kindFromRef(target),
				name: name || target,
				target,
			});
	};
	for (const party of found.parties)
		if (party.merged === false) add(party.ref, party.name, party.kind);
	for (const org of found.organizations)
		for (const ref of [...org.refs, ...org.role_refs])
			add(ref, org.name, kindFromRef(ref));
	const deals = found.deals.flatMap((deal) => {
		const name = deal.name?.trim();
		return name ? [{ kind: "deal", name, target: name }] : [];
	});
	return [...byRef.values(), ...deals].sort(
		(a, b) =>
			a.target.localeCompare(b.target) ||
			a.kind.localeCompare(b.kind) ||
			a.name.localeCompare(b.name),
	);
}

function notFound(query: string, found: Found) {
	const retired =
		found.parties.filter((party) => party.merged === true).length +
		found.organizations.reduce((n, org) => n + org.retired_aliases, 0);
	return {
		state: "not_found" as const,
		query,
		candidates: [],
		retired_matches: retired,
		hint: retired
			? "Only retired aliases matched; search the survivor name or call catch-me-up with a known retired ref."
			: "No live record matched this name.",
	};
}

const ambiguous = (query: string, candidates: Candidate[]) => ({
	state: "needs_disambiguation" as const,
	query,
	candidate_count: candidates.length,
	candidates: candidates.slice(0, CANDIDATE_CAP),
	candidates_truncated: candidates.length > CANDIDATE_CAP,
	hint: "Choose one exact target and call catch-me-up; this verb never guesses.",
});

// The old timeline had no tie-break; the engine's is decision 16.
const timeline = (db: Reader, type: string, id: string, limit: number) =>
	db
		.selectFrom("v_subject_timeline")
		.select([
			"entry_kind",
			isoMillis(sql.ref("occurred_at")).as("occurred_at"),
			"actor",
			"verb",
			"summary",
			"detail",
			"owed",
		])
		.where("subject_type", "=", type)
		.where("subject_id", "=", id)
		.orderBy("v_subject_timeline.occurred_at", "desc")
		.orderBy("entry_kind")
		.orderBy("id")
		.limit(limit)
		.execute();

// Calendar captures this partner logged against the subject.
const calendarHistory = (
	db: Reader,
	partner: string,
	type: string,
	id: string,
) =>
	db
		.selectFrom("v_calendar_capture_receipt as r")
		.innerJoin("activity as a", (join) =>
			join.on(sql`a.id::text`, "=", sql.ref("r.activity_id")),
		)
		.innerJoin("actor", "actor.id", "r.actor_id")
		.select([
			"r.idempotency_key as key",
			sql<string>`a.id::text`.as("activity_id"),
			"a.summary",
		])
		.where("actor.slug", "=", partner)
		.where(sql.ref(`a.${SUBJECT_COLUMN[type]}`), "=", id)
		.orderBy("r.idempotency_key")
		.limit(CALENDAR_CAP + 1)
		.execute();

export async function readRecentActivity(
	db: Reader,
	partner: string,
	query: string,
	limit: number,
) {
	const found = await readFind(db, query);
	const candidates = candidatesOf(found);
	const [match] = candidates;
	if (!match) return notFound(query, found);
	if (candidates.length > 1) return ambiguous(query, candidates);
	// The old catch-me-up door checked the target it was handed.
	if (hasToolCallMarkup("ref", match.target))
		return { error: "tool_call_markup_in_value" as const };
	const subject = await resolveSubject(db, match.target);
	if ("error" in subject) return subject;
	const calendar = await calendarHistory(db, partner, subject.type, subject.id);
	if (calendar.length > CALENDAR_CAP)
		return { error: "calendar_history_too_large" as const };
	return {
		state: "completed" as const,
		query,
		match,
		catch_up: {
			subject,
			timeline: await timeline(db, subject.type, subject.id, limit),
			calendar_history: calendar,
		},
	};
}
