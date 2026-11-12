import { type Kysely, sql } from "kysely";
import type { DB } from "../database.d.ts";
import { asText } from "../reader.ts";

type DealType = "lease" | "renewal" | "purchase" | "land";
type Status =
	| "not_recorded"
	| "complete"
	| "received"
	| "upcoming"
	| "due"
	| "overdue";

// The doctrine sections the template cites. A changed or retired section
// switches the checklist off until the template is reviewed.
// biome-ignore format: one row per section reads as a table.
export const SOURCES = [
	{ document: "deal-room-kit", section_id: "5f8a3cbd-fe89-4557-b3f4-5b0bbc53276c", version: 1, content_hash: "fe11a8c2bf371dcab98a0fba969594df46ee64c6a8be047dba9b6befc3dc6424" },
	{ document: "deal-room-kit", section_id: "7e263aa0-9823-477b-86e3-bd8cf0c32003", version: 1, content_hash: "6d1a03dacdff6d1ae8b5b0ca333f4fd98bcb0f380fa57f99ccaff8cff4a8d14e" },
	{ document: "diligence-and-valuation", section_id: "6c8354dd-576c-4dfe-8a56-791215172cd4", version: 1, content_hash: "656f92cd4c998a1296657d039e471f4811ba135c95b5e2fe22e180b757306f34" },
	{ document: "diligence-and-valuation", section_id: "13b3a132-36df-433e-b23e-4231ff35c753", version: 1, content_hash: "2fbd0c3894eee7c0c32b39d4ff1f4294df0f84fdc62a5b26c991959319155f2a" },
	{ document: "diligence-and-valuation", section_id: "20689402-d87e-4bb6-a048-4cfc03cf2c70", version: 1, content_hash: "86db20b306896890d675190438c6d6a038992a888843645eb349c6f373d78ca3" },
] as const;

const [KIT, KIT_TOURS, DILIGENCE, LAND, SELLER] = SOURCES;
const ANY = null;
const LEASED: DealType[] = ["lease", "renewal"];
const OWNED: DealType[] = ["purchase", "land"];
type Source = (typeof SOURCES)[number];
type RecordSource = { request?: string; record_verb: string };
const recordedBy = (record_verb: string): RecordSource => ({
	request: "per-deal standard checklist",
	record_verb,
});
type Row = [
	id: string,
	label: string,
	types: DealType[] | null,
	source: Source | RecordSource,
];
// biome-ignore format: one row per item reads as a table.
const PHASES: { id: string; label: string; rows: Row[] }[] = [
	{
		id: "research",
		label: "Research",
		rows: [
			["representation", "Signed representation agreement", ANY, KIT],
			["requirements", "Completed intake and requirements", ANY, KIT],
			["current_lease_abstraction", "Current lease abstraction", ["renewal"], KIT],
			["purchase_lease_analysis", "Purchase versus lease analysis", OWNED, KIT],
			["financing_prework", "Lender and financing pre-work", OWNED, KIT],
		],
	},
	{
		id: "site_selection",
		label: "Site selection",
		rows: [
			["market_survey", "Market survey and alternatives", ANY, KIT],
			["tour_notes", "Tours and tour notes", ["lease", ...OWNED], KIT_TOURS],
			["renewal_analysis", "Renewal versus relocation analysis", ["renewal"], KIT],
		],
	},
	{
		id: "negotiation",
		label: "Negotiation / LOI",
		rows: [
			["loi_submission", "RFP / LOI versions and submission", ANY, KIT_TOURS],
			["loi_grid", "Live terms comparison and counters", ANY, KIT],
			["business_terms", "Agreed business terms", ANY, KIT],
		],
	},
	{
		id: "legal",
		label: "Legal / lease",
		rows: [
			["contract_draft", "Lease / PSA draft to attorney", ANY, KIT],
			["attorney_comments", "Attorney review and comments", ANY, KIT_TOURS],
			["legal_review", "Healthcare lease review", LEASED, KIT],
			["ti_scope", "TI scope and bids versus allowance", LEASED, KIT_TOURS],
			["earnest_money", "Earnest money / escrow", OWNED, DILIGENCE],
			["title_commitment", "Title commitment and review", OWNED, DILIGENCE],
			["inspections", "Client inspections and objections", OWNED, DILIGENCE],
			["survey", "ALTA survey", OWNED, DILIGENCE],
			["environmental", "Environmental review and Phase I / II as needed", OWNED, DILIGENCE],
			["insurance_restrictions", "Insurance, restrictions and seller documents", OWNED, DILIGENCE],
			["appraisal", "Appraisal", OWNED, DILIGENCE],
			["financing_commitment", "Financing commitment", OWNED, DILIGENCE],
			["critical_dates_document", "Attorney critical dates document", OWNED, DILIGENCE],
			["commission_agreement", "Seller commission agreement", OWNED, SELLER],
			["feasibility", "Soil and site feasibility", ["land"], LAND],
			["entitlements", "Plans, utilities and city approvals", ["land"], LAND],
		],
	},
	{
		id: "closing",
		label: "Closing",
		rows: [
			["executed_lease", "Executed lease / amendment", LEASED, KIT],
			["purchase_close", "Purchase closing and executed documents", OWNED, KIT],
			["commencement_letter", "Commencement letter and possession dates", LEASED, KIT_TOURS],
			["executed_comp", "Executed comp recorded", ANY, KIT],
			["expiration_recorded", "Lease expiration recorded for renewal", LEASED, KIT],
			["entity_structure", "Entity / lease-back structure for CPA", OWNED, KIT],
			["move_in", "Move-in", ["lease"], KIT],
			["check_in_90_day", "90-day check-in", ["lease"], KIT],
		],
	},
	{
		id: "invoice",
		label: "Invoice",
		rows: [
			["invoice_recorded", "Invoice recorded", ANY, recordedBy("record-deal-invoice")],
			["commission_received", "Commission receipt recorded", ANY, recordedBy("record-commission-receipt")],
		],
	},
];
// Items the partners record as facts, not documents a client sends.
const NOT_DOCUMENTS = new Set([
	"executed_comp",
	"expiration_recorded",
	"move_in",
	"check_in_90_day",
	"invoice_recorded",
	"commission_received",
]);

type Request = Awaited<ReturnType<typeof requestsOf>>[number];
type Item = {
	id: string;
	label: string;
	status: Status;
	due_on: string | null;
	evidence_ref: string | null;
	owner: string | null;
	document_type: string | null;
	source: Source | RecordSource;
	request?: Request;
};
type Deal = {
	id: string;
	owner: string | null;
	type: string | null;
	invoiced_on: string | null;
};
type Facts = {
	deal: Deal;
	lease: {
		status: string | null;
		evidence_ref: string | null;
		executed_on: string | null;
		expiration_on: string | null;
	} | null;
	criticalDates: {
		id: string | null;
		kind: string | null;
		due_on: string | null;
		source: string | null;
		status: string | null;
	}[];
	sections: { id: string; status: string; body_hash: string | null }[];
	commissions: {
		commission_id: string;
		status: string;
		received_on: string | null;
	}[];
	requests: Request[];
	today: string;
};

// PostgreSQL prints every finite AD date this way; infinity and BC do not count.
const isDate = (value: string | null): value is string =>
	value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);

const dueStatus = (due_on: string, today: string): Status =>
	due_on < today ? "overdue" : due_on === today ? "due" : "upcoming";

const DEAL_TYPES = new Map<string | null, DealType>([
	["startup", "lease"],
	["relocation", "lease"],
	["expansion", "lease"],
	["additional_office", "lease"],
	["lease", "lease"],
	["renewal", "renewal"],
	["purchase", "purchase"],
	["land", "land"],
]);

function evidenceOf({ deal, lease, commissions }: Facts) {
	const evidence = new Map<string, string>();
	if (lease?.status === "current" && lease.evidence_ref) {
		if (isDate(lease.executed_on))
			evidence.set("executed_lease", lease.evidence_ref);
		if (isDate(lease.expiration_on))
			evidence.set("expiration_recorded", lease.evidence_ref);
	}
	if (isDate(deal.invoiced_on))
		evidence.set(
			"invoice_recorded",
			`deal:${deal.id}:invoiced_on:${deal.invoiced_on}`,
		);
	if (
		commissions.length > 0 &&
		commissions.every((c) => c.status === "received" && isDate(c.received_on))
	)
		evidence.set(
			"commission_received",
			commissions.map((c) => `commission:${c.commission_id}`).join(", "),
		);
	return evidence;
}

function settle(
	item: Item,
	evidence: string | undefined,
	request: Request | undefined,
	today: string,
): Item {
	const complete = evidence && {
		status: "complete" as const,
		evidence_ref: evidence,
	};
	if (!request) return { ...item, ...complete };
	const progress =
		complete ||
		(request.status === "fulfilled"
			? {
					status: "received" as const,
					evidence_ref: request.evidence_filename || "Received document",
				}
			: { status: dueStatus(request.due_on, today) });
	return {
		...item,
		...progress,
		owner: request.owner,
		due_on: request.due_on,
		request,
	};
}

function criticalDateItems({ deal, criticalDates, today }: Facts): Item[] {
	return criticalDates.flatMap((date) =>
		date.status === "open" && date.source?.trim() && isDate(date.due_on)
			? [
					{
						id: `critical-date:${date.id}`,
						label: (date.kind ?? "").replaceAll("_", " "),
						status: dueStatus(date.due_on, today),
						due_on: date.due_on,
						evidence_ref: date.source,
						owner: deal.owner || null,
						document_type: null,
						source: { record_verb: "add-critical-date" },
					},
				]
			: [],
	);
}

export function checklistOf(facts: Facts) {
	const type = DEAL_TYPES.get(facts.deal.type) ?? null;
	const cited = SOURCES.every(({ section_id, content_hash }) =>
		facts.sections.some(
			(s) =>
				s.id === section_id &&
				s.status === "active" &&
				s.body_hash === content_hash,
		),
	);
	const head = {
		schema_version: "deal-checklist.v1",
		template_state: !cited
			? "source_changed"
			: type
				? "current"
				: "deal_type_unknown",
		deal_type: type,
		sources: SOURCES,
		observed_on: facts.today,
	};
	const evidence = evidenceOf(facts);
	const requests = new Map(facts.requests.map((r) => [r.row_key, r]));
	const phases = (cited ? PHASES : []).map(({ id, label, rows }) => ({
		id,
		label,
		items: [
			...rows
				.filter(([, , types]) => !types || (type && types.includes(type)))
				.map(([itemId, itemLabel, , source]) =>
					settle(
						{
							id: itemId,
							label: itemLabel,
							status: "not_recorded",
							due_on: null,
							evidence_ref: null,
							owner: facts.deal.owner || null,
							document_type: NOT_DOCUMENTS.has(itemId) ? null : itemId,
							source,
						},
						evidence.get(itemId),
						requests.get(itemId),
						facts.today,
					),
				),
			...(id === "legal" ? criticalDateItems(facts) : []),
		],
	}));
	const due_items = phases
		.flatMap((phase) => phase.items)
		.filter((item) => item.status === "due" || item.status === "overdue")
		.sort(
			(a, b) =>
				(a.due_on ?? "").localeCompare(b.due_on ?? "") ||
				a.id.localeCompare(b.id),
		);
	return { ...head, phases, due_items, requests_state: "current" };
}

const requestsOf = (db: Kysely<DB>, deal: string) =>
	db
		.selectFrom("v_requirement_request")
		.select((eb) => [
			"id",
			"row_key",
			"owner",
			asText(eb.ref("due_on")).as("due_on"),
			"document_type",
			"satisfied",
			"receipts",
			"status",
			// The old answer sent this as a JavaScript Date.
			sql<
				string | null
			>`to_char(fulfilled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
				"fulfilled_at",
			),
			"fulfilled_by",
			"evidence_attachment_id",
			"evidence_filename",
		])
		// The table admits a single tenant, so no tenant filter is needed.
		.where("deal_id", "=", deal)
		.orderBy("row_key")
		.$narrowType<{ row_key: string; owner: string; due_on: string }>()
		.execute();

export async function readChecklist(
	db: Kysely<DB>,
	deal: Deal,
	lease: Facts["lease"],
	criticalDates: Facts["criticalDates"],
) {
	const sections = await db
		.selectFrom("doctrine_section")
		.select(["id", "status", "body_hash"])
		.where(
			"id",
			"in",
			SOURCES.map((s) => s.section_id),
		)
		.execute();
	const commissions = await db
		.selectFrom("commission")
		.select((eb) => [
			"id as commission_id",
			"status",
			asText(eb.ref("received_on")).as("received_on"),
		])
		.where("deal_id", "=", deal.id)
		.orderBy("id")
		.execute();
	const requests = await requestsOf(db, deal.id);
	const { today } = await db
		.selectNoFrom(asText(sql`carr_business_date()`).as("today"))
		.$narrowType<{ today: string }>()
		.executeTakeFirstOrThrow();
	return checklistOf({
		deal,
		lease,
		criticalDates,
		sections,
		commissions,
		requests,
		today,
	});
}
