import { type Expression, type Kysely, sql } from "kysely";
import type { DB } from "../database.d.ts";
import { resolveSubject } from "./detail/resolve.ts";

const HISTORY_CAP = 500;
const PLACEHOLDERS = new Set([
	"sf_commission_placeholder",
	"sf_close_date_placeholder",
]);

const asText = (value: Expression<unknown>) =>
	sql<string | null>`to_jsonb(${value})#>>'{}'`;

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
	if (subject.type !== "deal")
		return { error: "not_a_deal" as const, resolved: subject };
	const id = subject.id;
	const record = (await liveDeal(db, id)) ?? (await archivedDeal(db, id));
	if (!record) return { error: "not_found" as const, table: "deal", id };

	const [vendors, phaseChange, phaseStarts, thread, criticalDates] =
		await Promise.all([
			db
				.selectFrom("v_deal_room_vendor")
				.select([
					"party_id",
					"role",
					"company",
					"contact",
					"note",
					"updated_at",
				])
				.where("deal_id", "=", id)
				.orderBy("role")
				.orderBy(sql`company->>'name'`)
				.orderBy(sql`contact->>'name'`)
				.orderBy("party_id")
				.execute(),
			db
				.selectFrom("v_deal_room_phase_change")
				.selectAll()
				.where("deal_id", "=", id)
				.executeTakeFirst(),
			db
				.selectFrom("v_deal_room_phase_start")
				.select((eb) => [
					"phase",
					asText(eb.ref("started_on")).as("started_on"),
				])
				.where("deal_id", "=", id)
				.execute(),
			db
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
				.execute(),
			db
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
				.execute(),
		]);
	const [events, actions, activities, emails] = await Promise.all([
		db
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
			.execute(),
		db
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
			.execute(),
		db
			.selectFrom("v_deal_room_activity")
			.select((eb) => [
				"id",
				asText(eb.ref("occurred_at")).as("occurred_at"),
				"actor",
				"kind",
				"summary",
				"detail",
				"source",
				"email_context",
			])
			.where("deal_id", "=", id)
			.orderBy("occurred_at", "desc")
			.orderBy("id", "desc")
			.limit(HISTORY_CAP + 1)
			.execute(),
		db
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
			.execute(),
	]);
	const [participants, premises, rounds, documents, lease] = await Promise.all([
		db
			.selectFrom("v_deal_room_participant")
			.select(["role", "name", "actor", "party_id"])
			.where("deal_id", "=", id)
			.orderBy("role")
			.orderBy("name")
			.execute(),
		db
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
			.execute(),
		db
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
			.execute(),
		db
			.selectFrom("v_deal_room_document")
			.select((eb) => [
				"id",
				"sent_status",
				"lint_passed",
				"leak_check_passed",
				asText(eb.ref("prepared_at")).as("prepared_at"),
				"note",
			])
			.where("deal_id", "=", id)
			.orderBy("prepared_at", "desc")
			.limit(20)
			.execute(),
		db
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
			.executeTakeFirst(),
	]);

	return stripPlaceholders({
		schema_version: "deal-timeline.v1",
		lease: lease ?? null,
		deal_id: id,
		...record,
		vendors,
		...("operating_state" in record
			? { phase_change: phaseChange ?? null }
			: {}),
		phase_started_on: Object.fromEntries(
			phaseStarts.map((s) => [s.phase, s.started_on]),
		),
		short_name: shortName(record),
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
			"r.salesforce_id",
			"r.base_version",
			"ce.client_status",
			"ce.client_version",
			"ce.prospect_engagement_status",
		])
		.where("b.id", "=", id)
		.executeTakeFirst();
}

function shortName(deal: {
	name: string | null;
	client_name: string | null;
	city?: string | null;
}) {
	const contact = (deal.client_name ?? "")
		.replace(/\s*\([^)]*\)\s*$/u, "")
		.trim();
	const doctor = /^Dr\.?\s+([\p{L}]+(?:[ .'-][\p{L}]+)*)$/u.exec(contact)?.[1];
	if (!doctor || !deal.city) return deal.name;
	return `Dr. ${doctor.split(/\s+/u).at(-1)}'s ${deal.city} Deal`;
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
