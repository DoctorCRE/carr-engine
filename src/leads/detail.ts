import { sql } from "kysely";
import type { Reader } from "../reader.ts";
import { UUID } from "../uuid.ts";
import { readLeadBoard } from "./board.ts";

type CorrespondenceCursor = { occurred_at: string; id: string };
export type HistoryCursors = {
	correspondence: CorrespondenceCursor | null;
	stageHistory: string | null;
};
type Page<Cursor> = {
	total: number;
	has_more: boolean;
	next_cursor: Cursor | null;
};

// One captured activity and one stage change, as `jsonb` printed them.
type Correspondence = CorrespondenceCursor & {
	kind: string;
	summary: string;
	detail: string | null;
	source: string;
	connected: boolean | null;
};
type StageChange = {
	event_id: string;
	mutation_order: string;
	occurred_at: string;
	prior_stage: string | null;
	stage: string;
	[key: string]: unknown;
};
type DetailFields = {
	phone: string | null;
	email: string | null;
	notes: string | null;
	correspondence_coverage: "captured_entries_only";
	history_limit: 100;
	correspondence: Correspondence[];
	stage_history: StageChange[];
	correspondence_page: Page<CorrespondenceCursor>;
	stage_history_page: Page<string>;
};

type Board = Exclude<
	Awaited<ReturnType<typeof readLeadBoard>>,
	{ error: string }
>;
type BoardLead = Board["leads"][number];

const INSTANT =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const BIGINT_MAX = 9223372036854775807n;
const NEXT_STEP: Record<BoardLead["reachability"]["research_state"], string> = {
	needs_review:
		"Review discrepancies against original sources before working this record.",
	verified:
		"Read the cited sources and confirm the practice decision before drafting outreach.",
	needs_research:
		"Check practice website, professional registry and public filings; record sourced findings with record-finding, including nothing found.",
};

const isCalendarDate = (day: string) => {
	const at = Date.parse(`${day}T00:00:00Z`);
	return Number.isFinite(at) && new Date(at).toISOString().startsWith(day);
};

function correspondenceCursor(text: string) {
	let cursor: unknown;
	try {
		cursor = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (
		typeof cursor !== "object" ||
		cursor === null ||
		Array.isArray(cursor) ||
		Object.keys(cursor).length !== 2 ||
		!("id" in cursor && "occurred_at" in cursor)
	)
		return undefined;
	const { id, occurred_at } = cursor;
	return typeof id === "string" &&
		UUID.test(id) &&
		typeof occurred_at === "string" &&
		INSTANT.test(occurred_at) &&
		isCalendarDate(occurred_at.slice(0, 10)) &&
		Number.isFinite(Date.parse(occurred_at))
		? { occurred_at, id }
		: undefined;
}

const isStageCursor = (text: string) =>
	/^[0-9]{1,19}$/.test(text) && BigInt(text) <= BIGINT_MAX;

// The correspondence cursor is the JSON of the last page's `next_cursor`.
// A cursor is refused when malformed, or sent without a lead to open.
export function historyCursors(
	params: URLSearchParams,
): HistoryCursors | undefined {
	const correspondence = params.get("correspondence_cursor");
	const stageHistory = params.get("stage_history_cursor");
	if (correspondence === null && stageHistory === null)
		return { correspondence: null, stageHistory: null };
	if (!params.get("lead_id") || params.get("workspace") !== "leads")
		return undefined;
	const parsed =
		correspondence === null ? null : correspondenceCursor(correspondence);
	return parsed === undefined ||
		(stageHistory !== null && !isStageCursor(stageHistory))
		? undefined
		: { correspondence: parsed, stageHistory };
}

// Each page fetches one row past 100 to tell whether an older page exists.
// The old detail also re-sent `est_lease_event` and `segment` from `lead`,
// the same values the board row already carries.
const detailFields = (
	db: Reader,
	leadId: string,
	{ correspondence, stageHistory }: HistoryCursors,
) =>
	sql<{
		id: string;
		fields: DetailFields;
	}>`with correspondence as materialized (
		select * from v_lead_workspace_correspondence where lead_id = ${leadId}::uuid
	), correspondence_tail as materialized (
		select * from correspondence where ${correspondence?.occurred_at ?? null}::timestamptz is null
			or (occurred_at, id) < (${correspondence?.occurred_at ?? null}::timestamptz, ${correspondence?.id ?? null}::uuid)
		order by occurred_at desc, id desc limit 101
	), correspondence_page as materialized (
		select * from correspondence_tail order by occurred_at desc, id desc limit 100
	), stage_history as materialized (
		select * from v_lead_workspace_stage_history where lead_id = ${leadId}::uuid
	), stage_tail as materialized (
		select * from stage_history where ${stageHistory}::bigint is null or mutation_order < ${stageHistory}::bigint
		order by mutation_order desc limit 101
	), stage_page as materialized (
		select * from stage_tail order by mutation_order desc limit 100
	) select l.id, jsonb_build_object('phone', p.phone, 'email', p.email, 'notes', l.notes,
		'correspondence_coverage', 'captured_entries_only', 'history_limit', 100,
		'correspondence', coalesce((select jsonb_agg(to_jsonb(a) - 'lead_id' order by a.occurred_at desc, a.id desc)
			from correspondence_page a), '[]'),
		'stage_history', coalesce((select jsonb_agg(to_jsonb(e) - 'lead_id'
				|| jsonb_build_object('mutation_order', e.mutation_order::text)
				order by e.mutation_order desc) from stage_page e), '[]'),
		'correspondence_page', jsonb_build_object('total', (select count(*) from correspondence),
			'has_more', (select count(*) > 100 from correspondence_tail),
			'next_cursor', case when (select count(*) > 100 from correspondence_tail) then
				(select jsonb_build_object('occurred_at', a.occurred_at, 'id', a.id)
				from correspondence_page a order by a.occurred_at, a.id limit 1) end),
		'stage_history_page', jsonb_build_object('total', (select count(*) from stage_history),
			'has_more', (select count(*) > 100 from stage_tail),
			'next_cursor', case when (select count(*) > 100 from stage_tail) then
				(select e.mutation_order::text from stage_page e order by e.mutation_order limit 1) end)
	) as fields
	from lead l join party p on p.id = l.party_id where l.id = ${leadId}::uuid`.execute(
		db,
	);

// jsonb prints an object's keys shortest first, then bytewise.
const inJsonbOrder = <T extends object>(value: T) =>
	Object.fromEntries(
		Object.entries(value).sort(
			([a], [b]) => a.length - b.length || (a < b ? -1 : 1),
		),
	) as T;

// The old detail merged the board row and the detail fields as one jsonb
// object, then appended the advice, the label and the research summary.
function openLead(lead: BoardLead, fields: DetailFields) {
	const { handling_advice, strategy, reachability, ...row } = lead;
	return {
		...inJsonbOrder({ ...row, ...fields }),
		handling_advice,
		strategy,
		reachability,
		research: {
			state: reachability.research_state,
			evidence: reachability.evidence,
			coverage: "recorded_findings_only",
			external_search_performed: false,
			next_step: NEXT_STEP[reachability.research_state],
		},
	};
}

// The whole board with one lead opened. A lead off the board opens as null.
export async function readLeadDetail(
	db: Reader,
	leadId: string,
	cursors: HistoryCursors,
) {
	// The id cast runs first, so a malformed id is refused before any board
	// limit, as in the old single statement.
	const [opened] = (await detailFields(db, leadId, cursors)).rows;
	const board = await readLeadBoard(db);
	if ("error" in board) return board;
	const lead = board.leads.find((l) => l.id === opened?.id);
	return {
		...board,
		detail: opened && lead ? openLead(lead, opened.fields) : null,
	};
}
