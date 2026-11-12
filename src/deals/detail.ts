import { type Kysely, sql } from "kysely";
import type { DB } from "../database.d.ts";
import { readChecklist } from "./checklist.ts";
import { resolveSubject } from "./resolve.ts";
import {
	asText,
	clientPortalUrlOf,
	phaseChangeOf,
	phaseStartedOn,
	phaseStartsOf,
	shortName,
	vendorsOf,
} from "./shared.ts";

const HISTORY_CAP = 500;
const PLACEHOLDERS = new Set([
	"sf_commission_placeholder",
	"sf_close_date_placeholder",
]);

export async function readDealDetail(
	db: Kysely<DB>,
	deal: string,
	actor: string,
) {
	const signedIn = await db
		.selectFrom("actor")
		.select("id")
		.where("slug", "=", actor)
		.executeTakeFirst();
	if (!signedIn) return { error: "unauthenticated" as const };
	const subject = await resolveSubject(db, deal);
	if ("error" in subject) return subject;
	if (subject.type !== "deal") return { error: "not_a_deal" as const };
	const id = subject.id;
	const record = (await liveDeal(db, id)) ?? (await archivedDeal(db, id));
	if (!record) return { error: "not_found" as const };

	const vendors = await vendorsOf(db, id).execute();
	const phaseChange = await phaseChangeOf(db, id).executeTakeFirst();
	const phaseStarts = await phaseStartsOf(db, id).execute();
	const thread = await db
		.selectFrom("v_deal_room_note")
		.select((eb) => [
			"id",
			"kind",
			"text",
			"actor",
			asText(eb.ref("created_at")).as("created_at"),
		])
		.where("deal_id", "=", id)
		.orderBy("created_at", "desc")
		.orderBy("id", "desc")
		.limit(HISTORY_CAP + 1)
		.execute();
	const criticalDates = await db
		.selectFrom("v_deal_room_critical_date")
		.select((eb) => [
			"id",
			"kind",
			asText(eb.ref("due_on")).as("due_on"),
			"note",
			"source",
			"status",
		])
		.where("deal_id", "=", id)
		.orderBy("due_on")
		.orderBy("id")
		.execute();
	const events = await db
		.selectFrom("v_deal_room_event")
		.select((eb) => [
			"id",
			asText(eb.ref("recorded_at")).as("recorded_at"),
			"actor",
			"verb",
			"field",
			"old_value",
			"new_value",
		])
		.where("subject_id", "=", id)
		.orderBy("recorded_at", "desc")
		.orderBy("id", "desc")
		.limit(HISTORY_CAP + 1)
		.execute();
	const actions = await db
		.selectFrom("v_deal_room_action")
		.select((eb) => [
			"id",
			"owner",
			"description",
			"item_title as title",
			"item_bullets as bullets",
			"source_ref",
			asText(eb.ref("due_on")).as("due_on"),
			"status",
			"version",
			asText(eb.ref("hold_until")).as("hold_until"),
			asText(eb.ref("updated_at")).as("updated_at"),
		])
		.where("deal_id", "=", id)
		.orderBy("created_order")
		.orderBy("id")
		.execute();
	const activities = await db
		.selectFrom("v_deal_room_activity as a")
		.select((eb) => [
			"a.id",
			asText(eb.ref("a.occurred_at")).as("occurred_at"),
			"a.actor",
			"a.kind",
			"a.summary",
			"a.detail",
			"a.source",
			"a.email_context",
		])
		.where("a.deal_id", "=", id)
		.orderBy("a.occurred_at", "desc")
		.orderBy("a.id", "desc")
		.limit(HISTORY_CAP + 1)
		.execute();
	const emails = await db
		.selectFrom("v_deal_room_activity")
		.select((eb) => [
			"id",
			sql<string | null>`email_context->>'conversation_id'`.as("thread"),
			sql<string | null>`email_context->>'subject'`.as("subject"),
			asText(eb.ref("occurred_at")).as("latest_message_at"),
		])
		.where("deal_id", "=", id)
		.where("kind", "in", ["email_in", "email_out"])
		.where("email_context", "is not", null)
		.orderBy("occurred_at", "desc")
		.orderBy("id", "desc")
		.execute();
	const participants = await db
		.selectFrom("v_deal_room_participant")
		.select(["role", "name", "actor", "party_id"])
		.where("deal_id", "=", id)
		.orderBy("role")
		.orderBy("name")
		.execute();
	const premises = await db
		.selectFrom("v_deal_room_premises")
		.select([
			"id",
			"label",
			"building_name",
			"address",
			"city",
			"state",
			"suite",
			"area_amount",
			"area_basis",
		])
		.where("deal_id", "=", id)
		.orderBy("created_at")
		.orderBy("suite")
		.execute();
	const rounds = await db
		.selectFrom("v_deal_room_negotiation")
		.select((eb) => [
			"round_no",
			"side",
			asText(eb.ref("proposed_on")).as("proposed_on"),
			"rate_amount",
			"rate_basis",
			"rate_norm_sf_yr",
			"ti_amount",
			"ti_basis",
			"free_rent_months",
			"term_months",
			"escalator",
			"opex_note",
			asText(eb.ref("expires_on")).as("expires_on"),
			"note",
			"source",
		])
		.where("deal_id", "=", id)
		.orderBy("round_no", "desc")
		.orderBy("proposed_on", "desc")
		.limit(6)
		.execute();
	const documents = await db
		.selectFrom("v_deal_room_document as d")
		.select((eb) => [
			"d.id",
			"d.sent_status",
			"d.lint_passed",
			"d.leak_check_passed",
			asText(eb.ref("d.prepared_at")).as("prepared_at"),
			"d.note",
		])
		.where("d.deal_id", "=", id)
		.orderBy("d.prepared_at", "desc")
		.limit(20)
		.execute();
	const lease = await db
		.selectFrom("v_deal_room_current_lease")
		.select((eb) => [
			"id",
			"version",
			"status",
			asText(eb.ref("executed_on")).as("executed_on"),
			asText(eb.ref("commencement_on")).as("commencement_on"),
			asText(eb.ref("expiration_on")).as("expiration_on"),
			"options_note",
			"evidence_kind",
			"evidence_ref",
			"source",
		])
		.where("deal_id", "=", id)
		.executeTakeFirst();
	const checklist = await readChecklist(
		db,
		{ ...record, id },
		lease ?? null,
		criticalDates,
	);

	return stripPlaceholders({
		schema_version: "deal-timeline.v1",
		checklist,
		lease: lease ?? null,
		deal_id: id,
		...record,
		vendors,
		...("operating_state" in record
			? { phase_change: phaseChange ?? null }
			: {}),
		phase_started_on: phaseStartedOn(phaseStarts),
		short_name: shortName({
			...record,
			market: "city" in record ? record.city : null,
		}),
		thread: thread.slice(0, HISTORY_CAP),
		thread_truncated: thread.length > HISTORY_CAP,
		critical_dates: criticalDates,
		next_actions: actions,
		item_schema_version: "deal-items.v1",
		items: actions
			.filter(
				(a) => a.title && !["dropped", "expired"].includes(String(a.status)),
			)
			.map(({ id, title, due_on, status, bullets, source_ref }) => ({
				id,
				title,
				due_on,
				status,
				bullets,
				source_ref,
			})),
		activities: activities.slice(0, HISTORY_CAP),
		activities_truncated: activities.length > HISTORY_CAP,
		email_threads: latestPerThread(emails),
		participants,
		premises,
		negotiation_rounds: rounds,
		documents,
		events: events.slice(0, HISTORY_CAP),
		events_truncated: events.length > HISTORY_CAP,
	});
}

function liveDeal(db: Kysely<DB>, id: string) {
	return db
		.selectFrom("v_deal_room_board as b")
		.innerJoin("v_deal_reconciliation_read as r", "r.id", "b.id")
		.innerJoin(
			"v_client_engagement_status as ce",
			"ce.client_id",
			"b.client_id",
		)
		.select((eb) => [
			"b.id",
			"b.name",
			"b.phase",
			"b.owner",
			"b.type",
			"b.market as city",
			"b.segment",
			"b.attention",
			asText(eb.ref("b.next_date")).as("next_date"),
			"b.next_step",
			eb
				.or([eb("b.next_step", "is", null), eb("b.next_date", "is", null)])
				.as("next_step_required"),
			"b.client_id",
			"b.client_ref",
			"b.client_name",
			"b.account_client_id",
			"b.account_client_ref",
			"b.account_name",
			"b.account_owner",
			"b.market_agent",
			asText(eb.ref("b.last_touch")).as("last_touch"),
			asText(eb.ref("b.last_review_at")).as("last_review_at"),
			"b.workspace_kind",
			"b.operating_state",
			"b.parking_reason",
			"b.parking_note",
			asText(eb.ref("b.invoiced_on")).as("invoiced_on"),
			asText(eb.ref("b.closed_on")).as("closed_on"),
			"b.lane",
			"b.outcome",
			clientPortalUrlOf(db, eb.ref("b.id")).as("client_portal_url"),
			asText(eb.ref("b.parked_at")).as("parked_at"),
			"b.parked_by",
			"r.salesforce_id",
			"r.base_version",
			"ce.client_status",
			"ce.client_version",
			"ce.prospect_engagement_status",
		])
		.where("b.id", "=", id)
		.executeTakeFirst();
}

function archivedDeal(db: Kysely<DB>, id: string) {
	return db
		.selectFrom("v_deal_board as b")
		.innerJoin("v_deal_reconciliation_read as r", "r.id", "b.id")
		.innerJoin(
			"v_client_engagement_status as ce",
			"ce.client_id",
			"b.client_id",
		)
		.leftJoin("v_client_account as a", "a.client_id", "b.client_id")
		.select((eb) => [
			"b.id",
			"b.name",
			"b.phase",
			"b.lead_owner as owner",
			"b.deal_type as type",
			"b.client_ref",
			"b.client_name",
			"b.client_id",
			"a.account_client_id",
			eb
				.case()
				.when("a.account_client_id", "is", null)
				.then(eb.val("team"))
				.else(eb.val("national_account"))
				.end()
				.as("workspace_kind"),
			asText(eb.ref("b.closed_on")).as("closed_on"),
			asText(eb.ref("b.invoiced_on")).as("invoiced_on"),
			"b.outcome",
			"b.lane",
			clientPortalUrlOf(db, eb.ref("b.id")).as("client_portal_url"),
			"r.salesforce_id",
			"r.base_version",
			"ce.client_status",
			"ce.client_version",
			"ce.prospect_engagement_status",
		])
		.where("b.id", "=", id)
		.executeTakeFirst();
}

function latestPerThread(
	emails: {
		id: string | null;
		thread: string | null;
		subject: string | null;
		latest_message_at: string | null;
	}[],
) {
	const latest = new Map<string, (typeof emails)[number]>();
	for (const email of emails) {
		const key = email.thread ? `thread:${email.thread}` : `email:${email.id}`;
		if (!latest.has(key)) latest.set(key, email);
	}
	return [...latest.values()].map((e) => ({
		conversation_id: e.thread || null,
		subject: e.subject,
		latest_message_at: e.latest_message_at,
	}));
}

function stripPlaceholders<T>(value: T): T {
	if (Array.isArray(value)) return value.map(stripPlaceholders) as T;
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !PLACEHOLDERS.has(key))
				.map(([key, nested]) => [key, stripPlaceholders(nested)]),
		) as T;
	return value;
}
