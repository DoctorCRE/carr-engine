import { type RawBuilder, sql } from "kysely";
import type { Reader } from "../reader.ts";
import { ORIGINATION_SOURCES } from "./origination-sources.ts";

export type Page = { limit: number; before_id: string | null };

type Kind =
	| "enumeration"
	| "registry_update"
	| "pecos_observation"
	| "pecos_correction"
	| "formation_candidate";

type Row = {
	id: string;
	source: string;
	record_key: string;
	npi: string | null;
	name: string;
	city: string;
	state: string;
	kind: Kind;
	document_number: string | null;
	filing_on: string | null;
	evidence_date: string;
	date_basis: string;
	source_url: string;
	facts: unknown;
	published_on: string;
	recorded_at: string;
	parties: number;
	npi_parties: number;
	clients: number;
	shared_agent: boolean;
	mailing_only: boolean;
	client_refs: string[];
	client_ids: string[];
};

const WHY: Record<Kind, string> = {
	formation_candidate: "Healthcare-name research candidate filed",
	enumeration: "NPI enumerated",
	registry_update: "NPPES registry updated",
	pecos_correction: "Public PECOS evidence corrected",
	pecos_observation: "Public PECOS enrollment observed",
};

// The old answer printed these driver Dates with JavaScript's toISOString.
const isoMillis = (stamp: RawBuilder<unknown>) =>
	sql<string>`to_char(${stamp} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const addressKey = (address: RawBuilder<unknown>) =>
	sql`practice_address_key(${address})`;

const events = (db: Reader, page: Page) =>
	sql<Row>`with latest as (
		select distinct on (source, record_key) *
		from practice_origination_event
		order by source, record_key, id desc
	), page as materialized (
		select * from latest
		where ${page.before_id}::bigint is null or id < ${page.before_id}::bigint
		order by id desc
		limit ${page.limit + 1}
	)
	select e.id::text as id, e.source, e.record_key, e.npi, e.name, e.city, e.state,
		e.kind, e.document_number, e.filing_on::text as filing_on,
		e.evidence_date::text as evidence_date, e.date_basis, e.source_url, e.facts,
		e.published_on::text as published_on, ${isoMillis(sql`e.recorded_at`)} as recorded_at,
		m.parties, m.npi_parties, m.clients,
		coalesce(e.source = 'formation-fl'
			and coalesce(e.facts->>'registered_agent_address', '') <> ''
			and (${addressKey(sql`e.facts->>'registered_agent_address'`)} = ${addressKey(sql`e.facts->>'address'`)}
				or exists (select 1 from latest other
					where other.source = 'formation-fl' and other.record_key <> e.record_key
					and ${addressKey(sql`other.facts->>'registered_agent_address'`)}
						= ${addressKey(sql`e.facts->>'registered_agent_address'`)})),
			false) as shared_agent,
		coalesce((e.facts->>'mailing_only')::boolean, false) as mailing_only,
		m.client_refs, m.client_ids
	from page e
	cross join lateral (
		select count(distinct p.id)::int as parties,
			count(distinct p.id) filter (where p.npi = e.npi)::int as npi_parties,
			count(distinct c.id)::int as clients,
			coalesce(array_agg(distinct c.roster_ref) filter (where c.roster_ref is not null), '{}') as client_refs,
			coalesce(array_agg(distinct c.id) filter (where c.id is not null), '{}') as client_ids
		from party p
		left join client c on c.party_id = p.id and c.merged_into is null
		where p.merged_into is null and p.deleted_at is null and (p.npi = e.npi
			or (lower(p.name) = lower(e.name) and lower(coalesce(p.city, '')) = lower(e.city)
				and p.state = e.state)
			or (coalesce(e.facts->>'address', '') <> '' and p.state = e.state
				and ${addressKey(sql`(select a.street_address from v_practice_origination_party_address a where a.party_id = p.id)`)}
					= ${addressKey(sql`e.facts->>'address'`)}))
	) m
	order by e.id desc`.execute(db);

function route(row: Row) {
	if (row.shared_agent) return "identity_review";
	if (
		row.parties === 1 &&
		row.npi_parties === 1 &&
		row.clients === 1 &&
		!row.mailing_only
	)
		return "relationship_follow_up";
	return row.parties > 0 ? "identity_review" : "research";
}

function card(row: Row) {
	const {
		parties,
		npi_parties,
		clients,
		shared_agent,
		mailing_only,
		client_refs,
		client_ids,
		...event
	} = row;
	const unverified =
		event.source === "formation-fl"
			? "; practice identity and opening unverified"
			: "";
	return {
		...event,
		route: route(row),
		client_refs,
		client_ids,
		why_now: `${WHY[event.kind]} on ${event.evidence_date}${unverified}`,
	};
}

const NOT_IMPORTED = { status: "unavailable", checkpoint: null } as const;

export async function readReasonsToReachOut(db: Reader, page: Page) {
	const feeds = await db
		.selectFrom("practice_origination_feed")
		.select([
			"source",
			"checkpoint",
			sql<string | null>`published_on::text`.as("published_on"),
			"status",
			"detail",
			isoMillis(sql`updated_at`).as("updated_at"),
		])
		.execute();
	const { rows } = await events(db, page);
	const cards = rows.slice(0, page.limit).map(card);
	return {
		ok: true,
		contract: "practice-origination.v1",
		cards,
		next_cursor: rows.length > page.limit ? (cards.at(-1)?.id ?? null) : null,
		coverage: ORIGINATION_SOURCES.map((source) => ({
			...source,
			...(source.enabled
				? (feeds.find((feed) => feed.source === source.source) ?? NOT_IMPORTED)
				: {
						// Florida's coverage text names its planned reach, not a status.
						status:
							source.source === "formation-fl"
								? "unavailable"
								: source.coverage,
						checkpoint: null,
					}),
		})),
		outreach_started: false,
	};
}
