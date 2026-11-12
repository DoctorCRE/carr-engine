import { type Kysely, sql } from "kysely";
import type { DB } from "../database.d.ts";
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

type Contract = (typeof CONTRACTS)[number];
// The old query echo, in its key order.
export type ClientQuery = {
	dataset: "clients";
	contract?: Contract;
	scope: "team" | "mine";
	q: string | null;
	owner: "all" | (typeof PARTNERS)[number];
	territory: null;
	sort: (typeof SORTS)[number];
	page: number;
	page_size: typeof PAGE_SIZE;
	status: string | null;
	type: string | null;
	pipeline: (typeof PIPELINES)[number];
};
export type Stamp = { observedAt: Date; correlationId: string };

const STATUS = {
	QUERY_INVALID: 400,
	AUTHORIZATION_REFUSED: 403,
	VIEWER_OWNER_UNKNOWN: 409,
	INTERNAL_ERROR: 500,
	DEPENDENCY_UNAVAILABLE: 503,
	DEPENDENCY_NOT_PROVISIONED: 503,
} as const;
export type Dependency = "read_access" | "read_source" | "read_credential";
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

const NOTE =
	"Status and ETL are what someone entered on this record. They are shown as entered, and they are not proof that an agreement was signed or that anyone was put on the work.";
const FRESH_FOR_MS = 60_000;

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

const source = ({ observedAt, correlationId }: Stamp) => ({
	source: "client",
	source_ref: "client+party+client_status+client_type",
	observed_at: observedAt.toISOString(),
	valid_until: new Date(observedAt.valueOf() + FRESH_FOR_MS).toISOString(),
	freshness: "fresh",
	correlation_id: correlationId,
	safe_explanation:
		"Fresh because this is a no-store request-time canonical database read of live business records; valid for 60 seconds.",
});

const liveClients = (db: Kysely<DB>) =>
	db
		.selectFrom("client as c")
		.innerJoin("party as p", "p.id", "c.party_id")
		.leftJoin("client_status as cs", "cs.slug", "c.status")
		.leftJoin("client_type as ct", "ct.slug", "c.client_type")
		.where("c.merged_into", "is", null)
		.where("p.merged_into", "is", null)
		.where("p.deleted_at", "is", null);
const partnerId = (db: Kysely<DB>, slug: string) =>
	db.selectFrom("actor").select("id").where("slug", "=", slug);

// Null, not false, when the client has an owner and the viewer has no actor row.
const ownedByViewer = (viewerId: string | null) =>
	sql<
		boolean | null
	>`(c.owner_id is not null and c.owner_id = ${viewerId}::uuid)`;

// The searcher's %, _ and \ match themselves.
const likeTerm = (q: string) => `%${q.replace(/([\\%_])/g, "\\$1")}%`;

function matchingClients(db: Kysely<DB>, query: ClientQuery, viewer: string) {
	const { q, owner, status, type, pipeline } = query;
	let clients = liveClients(db);
	if (query.scope === "mine")
		clients = clients.where("c.owner_id", "=", partnerId(db, viewer));
	if (owner !== "all")
		clients = clients.where("c.owner_id", "=", partnerId(db, owner));
	if (q !== null) {
		const term = likeTerm(q);
		clients = clients.where(
			sql<boolean>`(p.name ilike ${term} escape '\\' or c.roster_ref ilike ${term} escape '\\' or p.ref ilike ${term} escape '\\')`,
		);
	}
	if (status !== null) clients = clients.where("c.status", "=", status);
	if (type !== null) clients = clients.where("c.client_type", "=", type);
	if (pipeline === "active" || pipeline === "other")
		clients = clients.where(
			"cs.is_active_pipeline",
			"=",
			pipeline === "active",
		);
	if (pipeline === "unknown")
		clients = clients.where("cs.is_active_pipeline", "is", null);
	return clients;
}

// The legacy shape, for a caller that names no contract.
function shaped<Row extends { last_deal_at: unknown; deal_type: unknown }>(
	row: Row,
	contract: Contract | undefined,
) {
	if (contract) return row;
	const { last_deal_at: _, deal_type: __, ...legacy } = row;
	return legacy;
}

export async function readClientList(
	db: Kysely<DB>,
	viewer: string,
	query: ClientQuery,
	stamp: Stamp,
) {
	const ownerId = (await partnerId(db, viewer).executeTakeFirst())?.id ?? null;
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
			ownedByViewer(ownerId).as("owned_by_viewer"),
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
	const page_count = Math.max(1, Math.ceil(total / PAGE_SIZE));
	return {
		viewer,
		dataset: "clients",
		query,
		total,
		page: query.page,
		page_size: PAGE_SIZE,
		page_count,
		out_of_range: query.page > page_count,
		rows: rows.map((row) => shaped(row, query.contract)),
		facets: { statuses, types },
		// The status and type foreign keys always find a label, so the old
		// signal for an unlabelled code is always null.
		partial: null,
		recorded_field_note: NOTE,
		source: source(stamp),
	};
}
