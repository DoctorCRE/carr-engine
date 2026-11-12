import { type Kysely, type QueryCreator, sql } from "kysely";
import type { DB } from "../database.d.ts";

export type ClientFitFilters = {
	vertical: string | null;
	city: string | null;
	state: string | null;
};
type Evidence = { deal_id: string; closed_on: string; deal_name: string };

const PROFILE_LIMIT = 1000;

export async function readClientFit(db: Kysely<DB>, filters: ClientFitFilters) {
	const profiles = await profilesOf(db, filters).execute();
	// The old system refused rather than cut the list short.
	if (profiles.length > PROFILE_LIMIT)
		return { error: "too_many_profiles" } as const;
	return {
		schema_version: "ideal-client-profile.v1",
		coverage: "recorded_closed_won_only",
		profiles: profiles.map((profile) => ({
			...profile,
			hypothesis: "Historical fit, not a prediction or qualification rule.",
		})),
	};
}

const wins = (db: QueryCreator<DB>) =>
	db
		.selectFrom("deal as d")
		.innerJoin("client as cl", "cl.id", "d.client_id")
		.innerJoin("party as p", "p.id", "cl.party_id")
		.select([
			"d.id",
			"d.name",
			"d.client_id",
			"d.deal_type",
			"d.closed_on",
			"d.city",
			"p.state",
			sql<
				string | null
			>`coalesce(nullif(cl.vertical, ''), nullif(d.segment, ''), nullif(p.specialty, ''))`.as(
				"vertical",
			),
		])
		.where("d.phase", "=", "closed")
		.where("d.outcome", "=", "won")
		.where("d.closed_on", "<=", sql<string>`current_date`)
		.where("cl.merged_into", "is", null)
		.where("p.merged_into", "is", null)
		.where("p.deleted_at", "is", null);

const profilesOf = (
	db: Kysely<DB>,
	{ vertical, city, state }: ClientFitFilters,
) =>
	db
		.with("wins", wins)
		.selectFrom("wins")
		.select((eb) => [
			"vertical",
			"deal_type",
			"city",
			"state",
			eb.cast<number>(eb.fn.countAll(), "integer").as("won_deals"),
			eb
				.cast<number>(eb.fn.count("client_id").distinct(), "integer")
				.as("clients"),
			sql<
				Evidence[]
			>`jsonb_agg(jsonb_build_object('deal_id', id, 'closed_on', closed_on, 'deal_name', name) order by closed_on, id)`.as(
				"evidence",
			),
		])
		.$if(vertical !== null, (q) => q.where("vertical", "=", vertical))
		.$if(city !== null, (q) => q.where("city", "=", city))
		.$if(state !== null, (q) => q.where("state", "=", state))
		.groupBy(["vertical", "deal_type", "city", "state"])
		.orderBy("won_deals", "desc")
		.orderBy("vertical")
		.orderBy("deal_type")
		.orderBy("city")
		.orderBy("state")
		.limit(PROFILE_LIMIT + 1);
