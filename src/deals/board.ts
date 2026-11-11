import { type Expression, expressionBuilder, type Kysely, sql } from "kysely";
import { jsonArrayFrom, jsonObjectFrom } from "kysely/helpers/postgres";
import type { DB } from "../database.d.ts";

type BoardInputs = {
	actor: string;
	workspace?: "team" | "national_account" | "all" | "" | null;
	account_client_id?: string | null;
};

const EDITABLE_FIELDS = [
	"phase",
	"owner",
	"attention",
	"next_date",
	"operating_state",
];
const eb = expressionBuilder<DB>();
const text = (value: Expression<unknown>) =>
	sql<string | null>`to_jsonb(${value})#>>'{}'`;

const vendors = (dealId: Expression<string | null>) =>
	jsonArrayFrom(
		eb
			.selectFrom("v_deal_room_vendor as v")
			.select(["party_id", "role", "company", "contact", "note", "updated_at"])
			.where("v.deal_id", "=", dealId)
			.orderBy("v.role")
			.orderBy(sql`v.company->>'name'`)
			.orderBy(sql`v.contact->>'name'`)
			.orderBy("v.party_id"),
	);

export function shortName(deal: {
	client_name: string | null;
	market: string | null;
	name: string | null;
}) {
	const contact = (deal.client_name ?? "")
		.replace(/\s*\([^)]*\)\s*$/u, "")
		.trim();
	const doctor = /^Dr\.?\s+(\p{L}+(?:[ .'-]\p{L}+)*)$/u.exec(contact)?.[1];
	if (!doctor || !deal.market) return deal.name;
	return `Dr. ${doctor.split(/\s+/u).at(-1)}'s ${deal.market} Deal`;
}

export async function readBoard(
	db: Kysely<DB>,
	{ actor, workspace, account_client_id }: BoardInputs,
) {
	const scope = workspace || "all";
	const account = account_client_id || null;
	const deals = await db
		.selectFrom("v_open_deal_room_board as b")
		.innerJoin("v_deal_reconciliation_read as r", "r.id", "b.id")
		.innerJoin(
			"v_client_engagement_status as ce",
			"ce.client_id",
			"b.client_id",
		)
		.select((q) => [
			"b.id",
			"b.name",
			"b.type",
			"b.phase",
			"b.owner",
			"b.attention",
			"r.base_version",
			vendors(q.ref("b.id")).as("vendors"),
			text(q.ref("b.next_date")).as("next_date"),
			"b.next_step",
			sql.lit("deal-items.v1").as("item_schema_version"),
			jsonArrayFrom(
				q
					.selectFrom("v_deal_room_action as i")
					.select(["i.id", "i.item_title as title"])
					.select((s) => text(s.ref("i.due_on")).as("due_on"))
					.select(["i.status", "i.item_bullets as bullets", "i.source_ref"])
					.whereRef("i.deal_id", "=", "b.id")
					.where("i.item_title", "is not", null)
					.where("i.status", "not in", ["dropped", "expired"])
					.orderBy("i.created_order")
					.orderBy("i.id"),
			).as("items"),
			jsonArrayFrom(
				q
					.selectFrom("v_deal_room_action as n")
					.select(["n.id", "n.item_id", "n.owner", "n.description"])
					.select((s) => text(s.ref("n.due_on")).as("due_on"))
					.whereRef("n.deal_id", "=", "b.id")
					.where("n.status", "=", "open")
					.where("n.item_title", "is", null)
					.orderBy("n.due_on", (o) => o.asc().nullsLast())
					.orderBy("n.id")
					.limit(3),
			).as("open_actions"),
			jsonObjectFrom(
				q
					.selectFrom(
						q
							.selectFrom("v_deal_room_activity as a")
							.select(["a.kind", "a.summary", "a.occurred_at", "a.id"])
							.select(sql<string | null>`null::bigint`.as("mutation_order"))
							.whereRef("a.deal_id", "=", "b.id")
							.unionAll(
								q
									.selectFrom("v_deal_room_event as e")
									.select(sql.lit("completed_action").as("kind"))
									.select(
										sql<
											string | null
										>`coalesce(nullif(e.new_value->>'outcome', ''),
											e.new_value->>'next_action', e.new_value->>'post_call_action')`.as(
											"summary",
										),
									)
									.select(["e.recorded_at as occurred_at", "e.id"])
									.select("e.mutation_order")
									.whereRef("e.subject_id", "=", "b.id")
									.where("e.verb", "in", [
										"complete-action",
										"complete-one-action",
									])
									.where(sql`e.new_value->>'status'`, "=", "done"),
							)
							.as("step"),
					)
					.select(["step.kind", "step.summary"])
					.select((s) => text(s.ref("step.occurred_at")).as("occurred_at"))
					.orderBy("step.occurred_at", "desc")
					.orderBy("step.mutation_order", (o) => o.desc().nullsLast())
					.orderBy("step.id", "desc")
					.limit(1),
			).as("last_step"),
			q
				.or([q("b.next_step", "is", null), q("b.next_date", "is", null)])
				.as("next_step_required"),
			"b.market",
			"b.segment",
			"b.client_id",
			"b.client_ref",
			"b.client_name",
			"ce.client_status",
			"ce.client_version",
			"ce.prospect_engagement_status",
			"b.account_client_id",
			"b.account_client_ref",
			"b.account_name",
			"b.account_owner",
			"b.market_agent",
			text(q.ref("b.last_touch")).as("last_touch"),
			text(q.ref("b.last_review_at")).as("last_review_at"),
			"b.workspace_kind",
			"b.operating_state",
			"b.parking_reason",
			"b.parking_note",
			text(q.ref("b.invoiced_on")).as("invoiced_on"),
			text(q.ref("b.closed_on")).as("closed_on"),
			"b.lane",
			"b.outcome",
			jsonObjectFrom(
				q
					.selectFrom("v_deal_room_phase_change as pc")
					.selectAll("pc")
					.whereRef("pc.deal_id", "=", "b.id"),
			).as("phase_change"),
			jsonArrayFrom(
				q
					.selectFrom("v_deal_room_phase_start as ps")
					.select("ps.phase")
					.select((s) => text(s.ref("ps.started_on")).as("started_on"))
					.whereRef("ps.deal_id", "=", "b.id"),
			).as("phase_started_on"),
			text(q.ref("b.parked_at")).as("parked_at"),
			"b.parked_by",
			jsonArrayFrom(
				q
					.selectFrom("v_deal_room_event as e")
					.distinctOn("e.field")
					.select(["e.field", "e.id"])
					.select((s) => text(s.ref("e.recorded_at")).as("recorded_at"))
					.where("e.subject_type", "=", "deal")
					.whereRef("e.subject_id", "=", "b.id")
					.where("e.field", "in", EDITABLE_FIELDS)
					.orderBy("e.field")
					.orderBy("e.recorded_at", "desc")
					.orderBy("e.id", "desc"),
			).as("field_base"),
		])
		.$if(scope !== "all", (q) => q.where("b.workspace_kind", "=", scope))
		.$if(account !== null, (q) => q.where("b.account_client_id", "=", account))
		.orderBy("b.attention", "desc")
		.orderBy("b.next_date", (o) => o.asc().nullsLast())
		.orderBy("b.name")
		.execute();
	return {
		schema_version: "local-deals-board.v2",
		actor,
		deals: deals.map((deal) => ({
			...deal,
			phase_started_on: Object.fromEntries(
				deal.phase_started_on.map((start) => [start.phase, start.started_on]),
			),
			field_base: Object.fromEntries(
				deal.field_base.map(({ field, ...base }) => [field, base]),
			),
			short_name: shortName(deal),
		})),
	};
}
