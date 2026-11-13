import { type Kysely, sql } from "kysely";
import {
	BusinessRefusal,
	type Contract,
	type ListQuery,
	listAnswer,
	ownedByViewer,
	PAGE_SIZE,
	partnerId,
	recordAnswer,
	SORTS,
	type Stamp,
	searched,
	viewerIdOf,
} from "../clients/read.ts";
import type { DB } from "../database.d.ts";
import { asText, inJsonbOrder } from "../reader.ts";
import { people } from "./people.ts";
import { rateTrackRecord, trackRecordFacts } from "./track-record.ts";

export const VENDOR_SORTS = [...SORTS, "territory"] as const;
export type VendorQuery = ListQuery<
	"vendors",
	(typeof VENDOR_SORTS)[number]
> & {
	category: string | null;
	stage: string | null;
	disposition: string | null;
};

// The legacy `category` column has no lookup key; `category_slug` does.
const category = sql<string>`coalesce(v.category_slug, v.category)`;
const vertical = sql<
	string | null
>`nullif(array_to_string(v.verticals, ', '), '')`;
const ORDER = {
	name: sql`lower(p.name) asc, v.id asc`,
	recent: sql`v.updated_at desc, v.id asc`,
	vertical: sql`lower(${vertical}) asc nulls last, lower(p.name), v.id`,
	deal_type: sql`lower(vc.label) asc nulls last, lower(p.name), v.id`,
	last_deal_desc: sql`vr.last_deal_at desc nulls last, lower(p.name), v.id`,
	last_deal_asc: sql`vr.last_deal_at asc nulls last, lower(p.name), v.id`,
	territory: sql`lower(v.territory) asc nulls last, lower(p.name), v.id`,
};

const liveVendors = (db: Kysely<DB>) =>
	db
		.selectFrom("vendor as v")
		.innerJoin("party as p", "p.id", "v.party_id")
		.leftJoin("vendor_category as vc", (join) =>
			join.on("vc.slug", "=", category),
		)
		.leftJoin("vendor_stage as vs", "vs.slug", "v.stage")
		.leftJoin("vendor_disposition as vd", "vd.slug", "v.disposition")
		.leftJoin(
			"vendor_relationship_level as vrl",
			"vrl.level",
			"v.relationship_level",
		)
		.where("v.merged_into", "is", null)
		.where("p.merged_into", "is", null)
		.where("p.deleted_at", "is", null);

const withTrackRecord = (vendors: ReturnType<typeof liveVendors>) =>
	vendors.innerJoinLateral(trackRecordFacts.as("vr"), (join) => join.onTrue());

const V2 = "vendor-directory.v2";

// v2 adds the vendor's people and, as the old read did, passes the whole row
// through jsonb, which reorders its keys.
const contracted = <Row>(row: Row, contract: Contract) =>
	contract === V2 ? inJsonbOrder(row) : row;

// Stage, disposition and level have foreign keys, so only the category can
// be a code with no label.
function unlabelled(rows: { recorded_category_label: string | null }[]) {
	const count = rows.filter((r) => r.recorded_category_label === null).length;
	return count
		? {
				kind: "unlabelled_recorded_codes",
				count,
				fields: ["recorded_category"],
				note: "Some entries use a code that is not in the current list of options. The stored value is shown exactly as it is, and has not been renamed.",
			}
		: null;
}

function matchingVendors(db: Kysely<DB>, query: VendorQuery, viewer: string) {
	const { q, owner, territory } = query;
	let vendors = liveVendors(db);
	if (query.scope === "mine")
		vendors = vendors.where("v.owner_id", "=", partnerId(db, viewer));
	if (owner !== "all")
		vendors = vendors.where("v.owner_id", "=", partnerId(db, owner));
	if (territory !== null)
		vendors = vendors.where("v.territory", "=", territory);
	if (q !== null) vendors = vendors.where(searched(q, sql.ref("v.vendor_ref")));
	if (query.category !== null)
		vendors = vendors.where(category, "=", query.category);
	if (query.stage !== null)
		vendors = vendors.where("v.stage", "=", query.stage);
	if (query.disposition !== null)
		vendors = vendors.where("v.disposition", "=", query.disposition);
	return vendors;
}

export async function readVendorList(
	db: Kysely<DB>,
	viewer: string,
	query: VendorQuery,
	stamp: Stamp,
) {
	const ownerId = await viewerIdOf(db, viewer);
	const matching = matchingVendors(db, query, viewer);
	const { total } = await matching
		.select(sql<number>`count(*)::int`.as("total"))
		.executeTakeFirstOrThrow();
	const rows = await withTrackRecord(matching)
		.select((eb) => [
			"v.id",
			"v.vendor_ref as ref",
			"p.name",
			"p.kind as party_kind",
			"p.city",
			"p.state",
			category.as("recorded_category"),
			"vc.label as recorded_category_label",
			"v.stage as recorded_stage",
			"vs.label as recorded_stage_label",
			"v.disposition as recorded_disposition",
			"vd.label as recorded_disposition_label",
			"vd.workable as recorded_disposition_workable",
			"v.relationship_level",
			"vrl.label as relationship_level_label",
			"v.referral_active",
			"v.is_target",
			"v.out_of_market",
			"v.last_touch",
			"vr.facts as relationship",
			vertical.as("vertical"),
			"vc.label as deal_type",
			asText(eb.ref("vr.last_deal_at")).as("last_deal_at"),
			"v.territory",
			"v.owner_label",
			ownedByViewer(sql.ref("v.owner_id"), ownerId).as("owned_by_viewer"),
			asText(eb.ref("v.updated_at")).as("updated_at"),
		])
		.$if(query.contract === V2, (qb) => qb.select(people.as("people")))
		.orderBy(ORDER[query.sort])
		.limit(PAGE_SIZE)
		.offset((query.page - 1) * PAGE_SIZE)
		.execute();
	const lookup = (table: "vendor_category" | "vendor_stage") =>
		db
			.selectFrom(table)
			.select(["slug", "label"])
			.orderBy("sort")
			.orderBy("slug")
			.execute();
	const facets = {
		categories: await lookup("vendor_category"),
		stages: await lookup("vendor_stage"),
		dispositions: await db
			.selectFrom("vendor_disposition")
			.select(["slug", "label", "workable"])
			.orderBy("sort")
			.orderBy("slug")
			.execute(),
	};
	const territories = query.contract
		? await liveVendors(db)
				.where("v.territory", "<>", "")
				.select(["v.territory as slug", "v.territory as label"])
				.distinct()
				.orderBy("v.territory")
				.execute()
		: null;
	if (query.scope === "mine" && ownerId === null)
		throw new BusinessRefusal({ error: "VIEWER_OWNER_UNKNOWN" });
	const now = stamp.observedAt.valueOf();
	return listAnswer(
		viewer,
		query,
		total,
		{
			rows: rows.map((row) => {
				if (query.contract) {
					const shaped = contracted(row, query.contract);
					return {
						...shaped,
						relationship: rateTrackRecord(shaped.relationship, now),
					};
				}
				const {
					relationship,
					vertical,
					deal_type,
					last_deal_at,
					territory,
					...legacy
				} = row;
				return legacy;
			}),
			facets: territories ? { ...facets, territories } : facets,
			partial: unlabelled(rows),
		},
		stamp,
	);
}

export async function readVendor(
	db: Kysely<DB>,
	viewer: string,
	id: string,
	contract: Contract | null,
	stamp: Stamp,
) {
	const ownerId = await viewerIdOf(db, viewer);
	const record = await withTrackRecord(liveVendors(db))
		.where("v.id", "=", id)
		.select((eb) => [
			"v.id",
			"v.vendor_ref as ref",
			"p.name",
			"p.kind as party_kind",
			"p.city",
			"p.state",
			"p.county",
			"p.title",
			"p.phone",
			"p.cell",
			"p.email",
			"p.contact_state",
			"p.contact_state_reason",
			"p.contact_state_until",
			"p.contact_state_cadence",
			category.as("recorded_category"),
			"vc.label as recorded_category_label",
			"v.stage as recorded_stage",
			"vs.label as recorded_stage_label",
			"v.disposition as recorded_disposition",
			"vd.label as recorded_disposition_label",
			"vd.workable as recorded_disposition_workable",
			"v.relationship_level",
			"vrl.label as relationship_level_label",
			"vrl.note as relationship_level_note",
			"v.verticals",
			"v.territory",
			"v.offers",
			"v.seeking",
			"v.rivalry_group",
			"v.originated",
			"v.referral_active",
			"v.is_target",
			"v.out_of_market",
			"v.last_touch",
			"vr.facts as relationship",
			"v.loan_programs",
			"v.intro_notes",
			"v.links_label",
			"v.owner_label",
			ownedByViewer(sql.ref("v.owner_id"), ownerId).as("owned_by_viewer"),
			"v.version as record_version",
			asText(eb.ref("v.created_at")).as("created_at"),
			asText(eb.ref("v.updated_at")).as("updated_at"),
		])
		.$if(contract === V2, (qb) => qb.select(people.as("people")))
		.executeTakeFirst();
	if (!record) throw new BusinessRefusal({ error: "RECORD_NOT_FOUND" });
	const partial = unlabelled([record]);
	if (contract) {
		const shaped = contracted(record, contract);
		const now = stamp.observedAt.valueOf();
		return recordAnswer(
			"vendors",
			viewer,
			{ ...shaped, relationship: rateTrackRecord(shaped.relationship, now) },
			partial,
			stamp,
		);
	}
	// The legacy shape keeps the territory, moved to the end.
	const { relationship, loan_programs, territory, ...legacy } = record;
	return recordAnswer(
		"vendors",
		viewer,
		{ ...legacy, territory },
		partial,
		stamp,
	);
}
