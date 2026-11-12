import { sql } from "kysely";
import type { Reader } from "../reader.ts";
import {
	isServable,
	type OpportunityTiming,
	opportunityTiming,
	timingEvents,
} from "./opportunity-timing.ts";
import {
	type ContactInputs,
	EVIDENCE_LIMIT,
	type Finding,
	reachability,
} from "./reachability.ts";

// One `v_lead_workspace` row with its prospect fields and timing, as the old
// system serialized it. Only the fields the engine reads are named.
type WorkspaceLead = {
	[key: string]: unknown;
	id: string;
	base_version: number;
	stage: string;
	contact_state: string;
	est_lease_event: string | null;
	event_confidence: string | null;
	next_action_date: string | null;
	opportunity_timing: OpportunityTiming;
};
type Hold = { reason: "contact_ineligible" | "unsupported_stage" };

const CONTACTABLE_STATES = new Set(["active", "nurture"]);
const DEAL_OBJECTIVE =
	"Coordinate with the linked client and deal before creating competing follow-up.";
const OPEN_OBJECTIVES = new Map([
	[
		"new",
		"Verify identity and discover whether the practice has a real estate decision.",
	],
	[
		"qualified",
		"Confirm the decision window, decision makers and an appropriate introduction.",
	],
	[
		"outreach_active",
		"Follow the agreed next step and offer one useful reason to respond.",
	],
	[
		"engaged",
		"Understand requirements and agree the next decision with the practice.",
	],
	[
		"nurture_drip",
		"Respect the requested timing and return with useful, relevant information.",
	],
	["opportunity", DEAL_OBJECTIVE],
	["active_deal", DEAL_OBJECTIVE],
]);
const CLOSED_OBJECTIVES = new Map([
	[
		"closed_won",
		"Closed won. Coordinate any post-close follow-up with the owning partner.",
	],
	[
		"closed_lost",
		"Closed lost. Review the recorded close with the owning partner before any future outreach.",
	],
]);
const DISCOVERY = [
	"What has the practice already tried?",
	"What constraints and timing are firm?",
	"Who approves the decision?",
	"What would make the practice stop?",
	"What would success look like in 90 days?",
];

// Each list fetches one row past the limit so an overflow can refuse the board.
const partyFindings = sql<Finding[]>`coalesce((select jsonb_agg(to_jsonb(f)
		order by f.observed_at desc, f.flag_id)
	from (select flag_id, kind, found, expired, proposes_correction, source, observed_at,
		expires_on, value from v_record_flag_subject f
		where (f.subject_type = 'party' and f.subject_id = b.party_id)
			or exists (select from v_ref_index r where r.party_id = b.party_id
				and r.subject_type = f.subject_type and r.subject_id = f.subject_id)
		order by observed_at desc, flag_id limit ${EVIDENCE_LIMIT + 1}) f), '[]')`;
const contactInputs = sql<ContactInputs>`jsonb_build_object('party_id', b.party_id,
	'created_at', b.created_at, 'email', party.email, 'cell', null, 'phone', party.phone,
	'activities', coalesce((select jsonb_agg(to_jsonb(a) order by a.occurred_at desc, a.id)
	from (select id, lead_id, kind, connected, occurred_at, source, detail
		from v_lead_workspace_correspondence where lead_id = b.id
			and occurred_at >= b.created_at and occurred_at >= now() - interval '90 days'
			and occurred_at <= now()
		order by occurred_at desc, id limit ${EVIDENCE_LIMIT + 1}) a), '[]'))`;

// to_jsonb keeps the old key order (PostgreSQL's, by key length) and its
// number and timestamp text.
const leadsInBoardOrder = (db: Reader) =>
	db
		.selectFrom((eb) =>
			eb
				.selectFrom("v_lead_workspace as w")
				.leftJoin("v_lead_prospect_engagement as p", "p.lead_id", "w.id")
				.leftJoin(timingEvents.as("timing"), "timing.party_id", "w.party_id")
				.selectAll("w")
				.select([
					"p.prospect_client_id",
					"p.prospect_client_version",
					"p.prospect_engagement_status",
					opportunityTiming.as("opportunity_timing"),
				])
				.as("b"),
		)
		.innerJoin("party", "party.id", "b.party_id")
		.select(sql<WorkspaceLead>`to_jsonb(b)`.as("lead"))
		.select([partyFindings.as("findings"), contactInputs.as("contact")])
		.orderBy("b.stage_sort")
		.orderBy("b.score", (ob) => ob.desc().nullsLast())
		.orderBy("b.name")
		.orderBy("b.id")
		.execute();

// The view drops suppressed leads, and a do-not-contact stage is always
// suppressed, so neither old check can fail here.
function advise(lead: WorkspaceLead) {
	const contact_eligible = CONTACTABLE_STATES.has(lead.contact_state);
	const open = OPEN_OBJECTIVES.get(lead.stage);
	const closed = CLOSED_OBJECTIVES.get(lead.stage);
	const hold: Hold | null = !contact_eligible
		? { reason: "contact_ineligible" }
		: !open && !closed
			? { reason: "unsupported_stage" }
			: null;
	return {
		...lead,
		contact_eligible,
		handling_advice: hold
			? "Do not contact. Review the recorded restriction or terminal stage with the owning partner."
			: (closed ??
				`${open} Research the handed record before preparing an outreach draft.`),
		strategy: {
			basis: "stage_based_guidance",
			hold,
			objective: hold
				? "Resolve the recorded hold before any outreach."
				: (closed ?? open),
			discovery: DISCOVERY,
			decision_window: lead.est_lease_event,
			confidence: lead.event_confidence || "unrecorded",
			next_step: hold
				? "Ask the owning partner to review the hold."
				: lead.next_action_date
					? `Respect the recorded next action date ${lead.next_action_date}.`
					: "Agree a next step and date; silence is not consent.",
			channel:
				"Use a verified contact route. Keep outreach as a draft for a partner to send.",
			risk: "Do not infer personal circumstances, intent, or a confirmed lease expiry from a sourcing signal.",
			sent: false,
		},
	};
}

type Row = Awaited<ReturnType<typeof leadsInBoardOrder>>[number];

// The served lead: the row as `to_jsonb` printed it, then the old projection.
type BoardLead = WorkspaceLead &
	ReturnType<typeof advise> & {
		reachability: Awaited<ReturnType<typeof reachability>>;
	};

// The first lead in board order that fails a check refuses the whole board,
// in the old projection's order.
function refusal({ lead, findings, contact }: Row) {
	if (!isServable(lead.opportunity_timing))
		return "invalid_lead_opportunity_timing";
	if (findings.length > EVIDENCE_LIMIT)
		return "research_evidence_limit_exceeded";
	if (contact.activities.length > EVIDENCE_LIMIT)
		return "contact_evidence_limit_exceeded";
	return null;
}

export async function readLeadBoard(db: Reader) {
	const rows = await leadsInBoardOrder(db);
	for (const row of rows) {
		const error = refusal(row);
		if (error) return { error } as const;
	}
	const now = Date.now();
	return {
		schema_version: "lead-workspace.v1",
		generated_at: new Date(now).toISOString(),
		leads: await Promise.all(
			rows.map(async ({ lead, findings, contact }): Promise<BoardLead> => {
				const advised = advise(lead);
				return {
					...advised,
					reachability: await reachability(advised, findings, contact, now),
				};
			}),
		),
		last_search_at: null,
		search_run_coverage: "unavailable",
	};
}
