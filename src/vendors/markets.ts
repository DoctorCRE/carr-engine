import { sql } from "kysely";
import type { Reader } from "../reader.ts";

type Reviewed = { source: string; reviewed_by: string; reviewed_at: string };

type Membership = Reviewed & {
	market_slug: string;
	vendor_id: string;
	office_presence: boolean;
	service_coverage: string | null;
};

type RegionalReference = Reviewed & {
	market_slug: string;
	regional_slug: string;
	note: string;
	market_kind: "market";
	regional_kind: "regional";
};

// Every column of `vendor_market`, as `to_jsonb` sends it.
type Market = Reviewed & {
	slug: string;
	name: string;
	kind: "market" | "regional";
	boundary: string;
	aliases: string[];
	vendor_count: number;
	memberships: Membership[];
	regional_references: RegionalReference[];
};

type Finding = {
	finding_id: string | null;
	observed_at: string | null;
	expires_on: string | null;
};

type Person = {
	company: { id: string; name: string } | null;
	contact: {
		id: string;
		name: string;
		email: string | null;
		phone: string | null;
		cell: string | null;
	};
	office:
		| (Finding & {
				street_address: string;
				city: string;
				state: string;
				source: string;
		  })
		| null;
	research: Finding & {
		status: "not_researched" | "office_verified" | "needs_review";
	};
};

type Vendor = {
	id: string;
	ref: string | null;
	category: string;
	name: string;
	people: Person[];
	market_slugs: string[];
};

export type VendorMarkets = {
	ok: true;
	schema_version: "vendor-markets.v1";
	state: "empty" | "ready";
	selected_market: string | null;
	markets: Market[];
	vendors: Vendor[];
};

const MARKET_CAP = 100;
const MEMBERSHIP_CAP = 5000;

// The old schema's check: 1 to 200 code points, at least one not a space.
export const isMarketName = (market: string) => {
	const length = [...market].length;
	return length >= 1 && length <= 200 && /\S/u.test(market);
};

const filled = (key: string) =>
	sql`jsonb_typeof(f.value->${key}) = 'string' and btrim(f.value->>${key}) <> ''`;

// A person's latest address finding counts as an office only when every one
// of these holds.
const officeVerified = sql`coalesce(f.value->'found' = 'true'::jsonb
	and not f.proposes_correction
	and f.value->>'epistemic_status' = 'source_backed'
	and coalesce(f.value->>'internal', 'false') = 'false'
	and f.value->>'location_type' = 'office'
	and ${filled("street_address")} and ${filled("city")} and ${filled("state")}
	and btrim(f.source) <> '' and f.observed_at <= statement_timestamp()
	and (f.expires_on is null or f.expires_on >= current_date), false)`;

const people = sql`(select coalesce(jsonb_agg(jsonb_build_object(
		'company', a.company,
		'contact', jsonb_build_object('id', c.id, 'name', c.name, 'email', c.email,
			'phone', c.phone, 'cell', c.cell),
		'office', case when f.verified then jsonb_build_object(
			'street_address', f.value->>'street_address', 'city', f.value->>'city',
			'state', f.value->>'state', 'finding_id', f.flag_id, 'source', f.source,
			'observed_at', f.observed_at, 'expires_on', f.expires_on) end,
		'research', jsonb_build_object(
			'status', case when f.flag_id is null then 'not_researched'
				when f.verified then 'office_verified' else 'needs_review' end,
			'finding_id', f.flag_id, 'observed_at', f.observed_at, 'expires_on', f.expires_on)
	) order by c.id), '[]')
	from v_vendor_assignment_context a
	cross join jsonb_array_elements(a.contacts) listed
	join party c on c.id = (listed->>'id')::uuid and btrim(c.name) <> ''
	left join lateral (select f.*, ${officeVerified} as verified
		from (select flag_id, value, source, observed_at, expires_on, proposes_correction
			from v_record_flag_subject
			where subject_type = 'party' and subject_id = c.id and kind = 'address'
			order by observed_at desc, flag_id desc limit 1) f) f on true
	where a.id = v.id)`;

type Registry = {
	market_count: number;
	membership_count: number;
	selected_market: string | null;
	markets: Market[];
	vendors: Vendor[];
};

// One row more than each cap is read, so an over-cap registry is refused, never cut.
const registry = (alias: string | null) => sql<Registry>`with
	markets as materialized (
		select * from vendor_market order by slug limit ${MARKET_CAP + 1}),
	memberships as materialized (
		select m.* from vendor_market_membership m
		join vendor v on v.id = m.vendor_id and v.merged_into is null
		join party p on p.id = v.party_id and p.merged_into is null and p.deleted_at is null
		order by m.market_slug, m.vendor_id limit ${MEMBERSHIP_CAP + 1})
	select (select count(*)::int from markets) as market_count,
		(select count(*)::int from memberships) as membership_count,
		(select market_slug from vendor_market_key where key = ${alias}) as selected_market,
		coalesce((select jsonb_agg(to_jsonb(m) || jsonb_build_object(
			'aliases', coalesce((select jsonb_agg(k.key order by k.key)
				from vendor_market_key k where k.market_slug = m.slug), '[]'),
			'vendor_count', (select count(distinct x.vendor_id)::int
				from memberships x where x.market_slug = m.slug),
			'memberships', coalesce((select jsonb_agg(to_jsonb(x) order by x.vendor_id)
				from memberships x where x.market_slug = m.slug), '[]'),
			'regional_references', coalesce((select jsonb_agg(to_jsonb(r) order by r.regional_slug)
				from vendor_market_regional_reference r where r.market_slug = m.slug), '[]')
		) order by m.slug) from markets m), '[]') as markets,
		coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'ref', v.vendor_ref,
			'category', v.category, 'name', p.name, 'people', ${people},
			'market_slugs', (select jsonb_agg(x.market_slug order by x.market_slug)
				from memberships x where x.vendor_id = v.id)) order by v.id)
		from vendor v join party p on p.id = v.party_id
		where v.id in (select vendor_id from memberships)), '[]') as vendors`;

export async function readVendorMarkets(
	db: Reader,
	market: string | null,
): Promise<
	| VendorMarkets
	| { error: "vendor_market_capacity_exceeded" | "vendor_market_not_found" }
> {
	const alias = market === null ? null : market.trim().toLowerCase();
	const [found] = (await registry(alias).execute(db)).rows;
	if (!found) throw new Error("The registry query returned no row");
	if (
		found.market_count > MARKET_CAP ||
		found.membership_count > MEMBERSHIP_CAP
	)
		return { error: "vendor_market_capacity_exceeded" };
	if (
		alias !== null &&
		found.market_count > 0 &&
		found.selected_market === null
	)
		return { error: "vendor_market_not_found" };
	return {
		ok: true,
		schema_version: "vendor-markets.v1",
		state: found.market_count === 0 ? "empty" : "ready",
		selected_market: found.selected_market,
		markets: found.markets,
		vendors: found.vendors,
	};
}
