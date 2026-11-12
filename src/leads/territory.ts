import { sql } from "kysely";
import type { Reader } from "../reader.ts";

export type TerritoryFilters = {
	vertical: string | null;
	city: string | null;
	state: string | null;
};

type Condition = "soft" | "balanced" | "tight";
type Evidence = {
	source: string;
	current: boolean;
	expired: boolean;
	flag_id: string;
	condition: Condition;
	expires_on: string | null;
	observed_at: string;
};
type Submarket = {
	city: string;
	state: string;
	evidence: Evidence[];
	condition: Condition | "unknown" | "conflicting";
};

const LIMIT = 1000;

const isCurrent = sql`f.found and not f.expired and f.expires_on is not null and f.observed_at <= now()`;

// The evidence is built as jsonb, as the old system did, so its keys come
// back in jsonb's order and observed_at as jsonb's timestamp text.
const submarkets = (db: Reader, { vertical, city, state }: TerritoryFilters) =>
	sql<Submarket>`with markets as (
		select distinct p.city, p.state from party p
		where p.merged_into is null and p.deleted_at is null
			and p.city is not null and p.state is not null and p.specialty is not null
			and (${vertical}::text is null or p.specialty = ${vertical})
			and (${city}::text is null or p.city = ${city})
			and (${state}::text is null or p.state = ${state})
	)
	select m.city, m.state, coalesce(e.items, '[]'::jsonb) as evidence,
		case when e.conditions is null then 'unknown'
			when cardinality(e.conditions) = 1 then e.conditions[1]
			else 'conflicting' end as condition
	from markets m
	cross join lateral (
		select jsonb_agg(jsonb_build_object('flag_id', f.flag_id,
				'condition', f.value->>'condition', 'source', f.source,
				'observed_at', f.observed_at, 'expires_on', f.expires_on,
				'expired', f.expired, 'current', ${isCurrent})
				order by f.observed_at desc, f.flag_id) as items,
			array_agg(distinct f.value->>'condition') filter (where ${isCurrent}) as conditions
		from v_record_flag_subject f
		where f.kind = 'submarket_state'
			and f.value->>'city' = m.city and f.value->>'state' = m.state
			and f.value->>'condition' in ('soft', 'balanced', 'tight')
	) e
	order by m.state, m.city
	limit ${LIMIT + 1}`.execute(db);

export async function readTerritory(db: Reader, filters: TerritoryFilters) {
	const { rows } = await submarkets(db, filters);
	// The old system refused rather than cut the list short.
	if (rows.length > LIMIT) return { error: "limit_exceeded" } as const;
	return {
		schema_version: "territory-state-board.v1",
		coverage: "recorded_geographies_only",
		submarkets: rows,
	};
}
