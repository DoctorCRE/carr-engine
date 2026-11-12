import { sql } from "kysely";

type OpportunityEvent = {
	date: string;
	date_type: "date";
	date_basis: "enumeration" | "registry_update" | "publication";
	source: "nppes" | "pecos";
	record_key: string;
	revision: string;
	source_url: string;
	published_on: string;
	observed_at: string;
	meaning: string;
	uncertainty: string;
};

// A lead's registry dates, as `jsonb` printed them. Unknown means no source
// supports a date, never that the evidence was bad.
export type OpportunityTiming = {
	events: OpportunityEvent[];
	status: "unknown" | "supported";
	contract: "lead-opportunity-timing.v1";
	record_added_at: string;
};

// Each registry record's newest revision, for the one live party holding its
// NPI, from feeds that are available. The revision is picked before the NPI
// match, so a corrected record cannot revive an old match.
export const timingEvents = sql<{ party_id: string; events: unknown }>`(
	select p.party_id, jsonb_agg(jsonb_build_object(
		'date', e.evidence_date::text, 'date_type', 'date', 'date_basis', e.date_basis,
		'source', e.source, 'record_key', e.record_key, 'revision', e.id::text,
		'source_url', e.source_url, 'published_on', e.published_on::text,
		'observed_at', e.recorded_at,
		'meaning', case e.kind when 'enumeration' then 'NPI enumerated'
			when 'registry_update' then 'NPPES registry updated'
			when 'pecos_correction' then 'Public PECOS evidence corrected'
			else 'Public PECOS enrollment observed' end,
		'uncertainty', 'Practice opening and real-estate decision unverified')
		order by e.source, e.record_key) as events
	from (select distinct on (source, record_key) * from practice_origination_event
		order by source, record_key, id desc) e
	join (select npi, any_value(id) as party_id from party
		where npi is not null and merged_into is null and deleted_at is null
		group by npi having count(*) = 1) p on p.npi = e.npi
	join practice_origination_feed f on f.source = e.source and f.status = 'available'
	where e.source in ('nppes', 'pecos')
	group by p.party_id)`;

// Reads the board's lead as `w` and its `timingEvents` join as `timing`.
export const opportunityTiming = sql`jsonb_build_object(
	'contract', 'lead-opportunity-timing.v1', 'record_added_at', w.created_at,
	'status', case when timing.events is null then 'unknown' else 'supported' end,
	'events', coalesce(timing.events, '[]'))`;

const INSTANT =
	/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const BASES = new Map([
	["nppes", new Set(["enumeration", "registry_update"])],
	["pecos", new Set(["publication"])],
]);

function isCalendarDate(value: string | undefined) {
	return (
		value !== undefined &&
		/^\d{4}-\d{2}-\d{2}$/.test(value) &&
		Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
		new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
	);
}

function isInstant(value: string) {
	const match = INSTANT.exec(value);
	return (
		!!match &&
		isCalendarDate(match[1]) &&
		Number(match[2]) < 24 &&
		Number(match[3]) < 60 &&
		Number(match[4]) < 60 &&
		Number(match[5] ?? 0) < 24 &&
		Number(match[6] ?? 0) < 60 &&
		Number.isFinite(Date.parse(value))
	);
}

const isFilled = (value: string) => value.trim().length > 0;

const isEvent = (event: OpportunityEvent) =>
	isCalendarDate(event.date) &&
	isCalendarDate(event.published_on) &&
	isInstant(event.observed_at) &&
	!!BASES.get(event.source)?.has(event.date_basis) &&
	isFilled(event.record_key) &&
	isFilled(event.source_url);

// The SQL fixes every other field, so only stored values can fail the old
// check, and one failure refused the whole board.
export const isServable = (timing: OpportunityTiming) =>
	isInstant(timing.record_added_at) && timing.events.every(isEvent);
