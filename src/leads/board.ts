import { sql } from "kysely";
import type { Reader } from "../reader.ts";

// One `v_lead_workspace` row with its prospect fields, as the old system
// serialized it. Only the fields the advice reads are named.
type WorkspaceLead = Record<string, unknown> & {
	stage: string;
	contact_state: string;
	est_lease_event: string | null;
	event_confidence: string | null;
	next_action_date: string | null;
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

// to_jsonb keeps the old key order (PostgreSQL's, by key length) and its
// number and timestamp text.
const leadsInBoardOrder = (db: Reader) =>
	db
		.selectFrom((eb) =>
			eb
				.selectFrom("v_lead_workspace as w")
				.leftJoin("v_lead_prospect_engagement as p", "p.lead_id", "w.id")
				.selectAll("w")
				.select([
					"p.prospect_client_id",
					"p.prospect_client_version",
					"p.prospect_engagement_status",
				])
				.as("b"),
		)
		.select(sql<WorkspaceLead>`to_jsonb(b)`.as("lead"))
		.orderBy("b.stage_sort")
		.orderBy("b.score", (ob) => ob.desc().nullsLast())
		.orderBy("b.name")
		.orderBy("b.id")
		.execute();

// The view drops suppressed leads, so the old suppressed hold never shows here.
function advise<T extends WorkspaceLead>(lead: T) {
	const contact_eligible =
		lead.stage !== "do_not_contact" &&
		CONTACTABLE_STATES.has(lead.contact_state);
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

// Each lead still lacks the old `opportunity_timing` and `reachability` keys.
export async function readLeadBoard(db: Reader) {
	const rows = await leadsInBoardOrder(db);
	return {
		schema_version: "lead-workspace.v1",
		generated_at: new Date().toISOString(),
		leads: rows.map(({ lead }) => advise(lead)),
		last_search_at: null,
		search_run_coverage: "unavailable",
	};
}
