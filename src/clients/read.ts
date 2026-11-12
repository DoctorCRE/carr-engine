import { type Kysely, type RawBuilder, sql } from "kysely";
import type { DB } from "../database.d.ts";
import { failureKind } from "../failure.ts";
import { asText } from "../reader.ts";

export const PARTNERS = ["joe", "dell"] as const;
export const SORTS = [
	"name",
	"recent",
	"vertical",
	"deal_type",
	"last_deal_desc",
	"last_deal_asc",
] as const;
export const PIPELINES = ["any", "active", "other", "unknown"] as const;
export const CONTRACTS = [
	"vendor-directory.v1",
	"vendor-directory.v2",
] as const;
export const PAGE_SIZE = 25;

export type Contract = (typeof CONTRACTS)[number];
export type Dataset = keyof typeof DATASETS;
// The old query echo, in its key order.
export type ListQuery<D extends Dataset, Sort extends string> = {
	dataset: D;
	contract?: Contract;
	scope: "team" | "mine";
	q: string | null;
	owner: "all" | (typeof PARTNERS)[number];
	territory: string | null;
	sort: Sort;
	page: number;
	page_size: typeof PAGE_SIZE;
};
export type ClientQuery = ListQuery<"clients", (typeof SORTS)[number]> & {
	status: string | null;
	type: string | null;
	pipeline: (typeof PIPELINES)[number];
};
export type Stamp = { observedAt: Date; correlationId: string };

const STATUS = {
	QUERY_INVALID: 400,
	AUTHORIZATION_REFUSED: 403,
	RECORD_NOT_FOUND: 404,
	VIEWER_OWNER_UNKNOWN: 409,
	INTERNAL_ERROR: 500,
	DEPENDENCY_UNAVAILABLE: 503,
	DEPENDENCY_NOT_PROVISIONED: 503,
} as const;
type Dependency = "read_access" | "read_source" | "read_credential";
type RefusalBody = {
	error: keyof typeof STATUS;
	detail?: { parameter: string; reason?: string; limit?: number };
	dependency?: Dependency;
};

export class BusinessRefusal {
	readonly body: RefusalBody;
	readonly status: (typeof STATUS)[keyof typeof STATUS];
	constructor(body: RefusalBody) {
		this.body = body;
		this.status = STATUS[body.error];
	}
}

export const invalid = (detail: NonNullable<RefusalBody["detail"]>) =>
	new BusinessRefusal({ error: "QUERY_INVALID", detail });

// The old reader's SQLSTATE and driver codes for a read it could not run.
const UNPROVISIONED = new Map<string, Dependency>([
	["42501", "read_access"],
	["42P01", "read_source"],
	["42703", "read_source"],
	["3F000", "read_source"],
	["3D000", "read_source"],
	["28000", "read_credential"],
	["28P01", "read_credential"],
]);
const UNAVAILABLE = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"ENOTFOUND",
	"08000",
	"57P01",
]);

export function refusalOf(error: unknown) {
	if (error instanceof BusinessRefusal) return error;
	const code =
		typeof error === "object" && error !== null && "code" in error
			? String(error.code)
			: "";
	const dependency = UNPROVISIONED.get(code);
	if (dependency)
		return new BusinessRefusal({
			error: "DEPENDENCY_NOT_PROVISIONED",
			dependency,
		});
	if (UNAVAILABLE.has(code))
		return new BusinessRefusal({ error: "DEPENDENCY_UNAVAILABLE" });
	console.warn("read failed:", failureKind(error));
	return new BusinessRefusal({ error: "INTERNAL_ERROR" });
}

export const isOneOf = <T extends string>(
	allowed: readonly T[],
	value: string,
): value is T => (allowed as readonly string[]).includes(value);

const DATASETS = {
	clients: {
		source: "client",
		source_ref: "client+party+client_status+client_type",
		note: "Status and ETL are what someone entered on this record. They are shown as entered, and they are not proof that an agreement was signed or that anyone was put on the work.",
	},
	vendors: {
		source: "vendor",
		source_ref: "vendor+party+vendor_category+vendor_stage+vendor_disposition",
		note: "Stage, disposition and relationship level are what someone entered on this record. They are shown as entered, and they are not proof of a commitment either way.",
	},
};
const FRESH_FOR_MS = 60_000;
const NOT_IN_THIS_READ = [
	"assignments",
	"negotiations",
	"deals",
	"email",
	"documents",
	"history",
];

type Column = RawBuilder<unknown>;

const lastDealAt = sql<
	string | null
>`(select max(d.closed_on) from deal d where d.client_id = c.id)`;
const ORDER = {
	name: sql`lower(p.name) asc, c.id asc`,
	recent: sql`c.updated_at desc, c.id asc`,
	vertical: sql`lower(c.vertical) asc nulls last, lower(p.name), c.id`,
	deal_type: sql`lower(c.deal_type_label) asc nulls last, lower(p.name), c.id`,
	last_deal_desc: sql`${lastDealAt} desc nulls last, lower(p.name), c.id`,
	last_deal_asc: sql`${lastDealAt} asc nulls last, lower(p.name), c.id`,
};

const source = (dataset: Dataset, { observedAt, correlationId }: Stamp) => ({
	source: DATASETS[dataset].source,
	source_ref: DATASETS[dataset].source_ref,
	observed_at: observedAt.toISOString(),
	valid_until: new Date(observedAt.valueOf() + FRESH_FOR_MS).toISOString(),
	freshness: "fresh",
	correlation_id: correlationId,
	safe_explanation:
		"Fresh because this is a no-store request-time canonical database read of live business records; valid for 60 seconds.",
});

// The old list envelope, with the rows, facets and partial signal in between.
export function listAnswer<
	Body extends { rows: unknown[]; facets: object; partial: object | null },
>(
	viewer: string,
	query: ListQuery<Dataset, string>,
	total: number,
	body: Body,
	stamp: Stamp,
) {
	const page_count = Math.max(1, Math.ceil(total / PAGE_SIZE));
	return {
		viewer,
		dataset: query.dataset,
		query,
		total,
		page: query.page,
		page_size: PAGE_SIZE,
		page_count,
		out_of_range: query.page > page_count,
		...body,
		recorded_field_note: DATASETS[query.dataset].note,
		source: source(query.dataset, stamp),
	};
}

const PIPELINE = { active: true, other: false, unknown: null } as const;

const liveClients = (db: Kysely<DB>) =>
	db
		.selectFrom("client as c")
		.innerJoin("party as p", "p.id", "c.party_id")
		.leftJoin("client_status as cs", "cs.slug", "c.status")
		.leftJoin("client_type as ct", "ct.slug", "c.client_type")
		.where("c.merged_into", "is", null)
		.where("p.merged_into", "is", null)
		.where("p.deleted_at", "is", null);
export const partnerId = (db: Kysely<DB>, slug: string) =>
	db.selectFrom("actor").select("id").where("slug", "=", slug);

// Null, not false, when the record has an owner and the viewer has no actor row.
export const ownedByViewer = (owner: Column, viewerId: string | null) =>
	sql<boolean | null>`(${owner} is not null and ${owner} = ${viewerId}::uuid)`;

// The searcher's %, _ and \ match themselves.
export function searched(q: string, ref: Column) {
	const term = `%${q.replace(/([\\%_])/g, "\\$1")}%`;
	return sql<boolean>`(p.name ilike ${term} escape '\\' or ${ref} ilike ${term} escape '\\' or p.ref ilike ${term} escape '\\')`;
}

// The legacy shape, for a caller that names no contract.
const shaped = <Row extends { last_deal_at: unknown; deal_type: unknown }>(
	row: Row,
	contract: Contract | null | undefined,
) => {
	if (contract) return row;
	const { last_deal_at: _, deal_type: __, ...legacy } = row;
	return legacy;
};

export const viewerIdOf = async (db: Kysely<DB>, viewer: string) =>
	(await partnerId(db, viewer).executeTakeFirst())?.id ?? null;

function matchingClients(db: Kysely<DB>, query: ClientQuery, viewer: string) {
	const { q, owner, status, type, pipeline } = query;
	let clients = liveClients(db);
	if (query.scope === "mine")
		clients = clients.where("c.owner_id", "=", partnerId(db, viewer));
	if (owner !== "all")
		clients = clients.where("c.owner_id", "=", partnerId(db, owner));
	if (q !== null) clients = clients.where(searched(q, sql.ref("c.roster_ref")));
	if (status !== null) clients = clients.where("c.status", "=", status);
	if (type !== null) clients = clients.where("c.client_type", "=", type);
	if (pipeline !== "any")
		clients = clients.where("cs.is_active_pipeline", "is", PIPELINE[pipeline]);
	return clients;
}

export async function readClientList(
	db: Kysely<DB>,
	viewer: string,
	query: ClientQuery,
	stamp: Stamp,
) {
	const ownerId = await viewerIdOf(db, viewer);
	const matching = matchingClients(db, query, viewer);
	const { total } = await matching
		.select(sql<number>`count(*)::int`.as("total"))
		.executeTakeFirstOrThrow();
	const rows = await matching
		.select((eb) => [
			"c.id",
			"c.roster_ref as ref",
			"p.name",
			"p.kind as party_kind",
			"p.city",
			"p.state",
			"c.status as recorded_status",
			"cs.label as recorded_status_label",
			"cs.is_active_pipeline as recorded_status_active_pipeline",
			"c.etl_status as recorded_etl_status",
			"c.client_type as recorded_client_type",
			"ct.label as recorded_client_type_label",
			"c.vertical",
			lastDealAt.as("last_deal_at"),
			"c.deal_type_label as deal_type",
			"c.owner_label",
			ownedByViewer(sql.ref("c.owner_id"), ownerId).as("owned_by_viewer"),
			asText(eb.ref("c.updated_at")).as("updated_at"),
		])
		.orderBy(ORDER[query.sort])
		.limit(PAGE_SIZE)
		.offset((query.page - 1) * PAGE_SIZE)
		.execute();
	const statuses = await db
		.selectFrom("client_status")
		.select(["slug", "label", "is_active_pipeline"])
		.orderBy("sort")
		.orderBy("slug")
		.execute();
	const types = await db
		.selectFrom("client_type")
		.select(["slug", "label"])
		.orderBy("label")
		.orderBy("slug")
		.execute();
	if (query.scope === "mine" && ownerId === null)
		throw new BusinessRefusal({ error: "VIEWER_OWNER_UNKNOWN" });
	return listAnswer(
		viewer,
		query,
		total,
		{
			rows: rows.map((row) => shaped(row, query.contract)),
			facets: { statuses, types },
			// The status and type foreign keys always find a label, so the old
			// signal for an unlabelled code is always null.
			partial: null,
		},
		stamp,
	);
}

export async function readClient(
	db: Kysely<DB>,
	viewer: string,
	id: string,
	contract: Contract | null,
	stamp: Stamp,
) {
	const ownerId = await viewerIdOf(db, viewer);
	const record = await liveClients(db)
		.where("c.id", "=", id)
		.select((eb) => [
			"c.id",
			"c.roster_ref as ref",
			"p.name",
			"p.kind as party_kind",
			"p.city",
			"p.state",
			"p.county",
			"p.title",
			"p.specialty",
			"p.npi",
			"p.phone",
			"p.cell",
			"p.email",
			"p.contact_state",
			"p.contact_state_reason",
			"p.contact_state_until",
			"p.contact_state_cadence",
			"c.status as recorded_status",
			"cs.label as recorded_status_label",
			"cs.is_active_pipeline as recorded_status_active_pipeline",
			"cs.note as recorded_status_note",
			"c.etl_status as recorded_etl_status",
			"c.client_type as recorded_client_type",
			"ct.label as recorded_client_type_label",
			"c.vertical",
			lastDealAt.as("last_deal_at"),
			"c.deal_type_label as deal_type",
			"c.subtype",
			"c.acquisition_source",
			"c.acquisition_detail",
			"c.contact_label",
			"c.deal_type_label",
			"c.specialty_type_label",
			"c.possible_duplicate_label",
			"c.notes",
			"c.owner_label",
			ownedByViewer(sql.ref("c.owner_id"), ownerId).as("owned_by_viewer"),
			"c.version as record_version",
			asText(eb.ref("c.created_at")).as("created_at"),
			asText(eb.ref("c.updated_at")).as("updated_at"),
		])
		.executeTakeFirst();
	if (!record) throw new BusinessRefusal({ error: "RECORD_NOT_FOUND" });
	return {
		viewer,
		dataset: "clients",
		record: shaped(record, contract),
		partial: null,
		not_in_this_read: NOT_IN_THIS_READ,
		recorded_field_note: DATASETS.clients.note,
		source: source("clients", stamp),
	};
}
