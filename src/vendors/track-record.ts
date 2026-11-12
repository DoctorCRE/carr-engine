import { sql } from "kysely";

type Entry = {
	id: string;
	kind: string;
	when: string;
	summary: string;
	detail: string | null;
};

type Introduction = {
	id: string;
	kind: string;
	from_name: string;
	to_name: string;
	note: string | null;
	occurred_at: string | null;
	via_party: string | null;
};

// A vendor's deals and contact, as `json_build_object` printed them.
export type TrackRecordFacts = {
	coverage_verified_at: string | null;
	deals_referred: number;
	deals_worked: number;
	won: number;
	lost: number;
	first_worked_at: string | null;
	last_contacted_at: string | null;
	last_contact_note: string | null;
	override: {
		tier: "Trial" | "Established" | "Proven";
		reason: string;
		recorded_by: string;
		recorded_at: string;
	} | null;
	recent_entries: Entry[];
	introductions: Introduction[];
};

// The one party-to-deal rule, shared with the Relationships map: evidence on
// the party's live vendor rows, plus the referrals it is credited with, on
// deals whose client is live. A referral date is UTC midnight in any zone.
export const associations = sql`(select e.party_id, e.deal_id, e.role, e.occurred_at, e.detail,
		d.outcome
	from (select ev.party_id, x.deal_id, x.role, x.occurred_at, x.evidence_ref as detail
			from vendor ev
			cross join lateral jsonb_to_recordset(coalesce(ev.deal_evidence, '[]'))
				as x(deal_id uuid, role text, occurred_at timestamptz, evidence_ref text)
			where ev.merged_into is null
		union all
		select r.referred_by, r.deal_id, 'referred',
			coalesce(r.occurred_on::timestamp at time zone 'UTC', r.created_at), r.note
		from party_link_deal r) e
	join deal d on d.id = e.deal_id
	join client dc on dc.id = d.client_id and dc.merged_into is null
	join party dp on dp.id = dc.party_id and dp.merged_into is null and dp.deleted_at is null)`;

const contacts = sql`a.vendor_id = v.id and a.kind in ('call', 'email_out', 'email_in', 'meeting', 'text')`;

// Join it laterally beside the vendor `v`. Coverage holds only while every
// live vendor row of the party is verified. Ties left unordered by the old
// read fall back to the id, highest first.
export const trackRecordFacts = sql<{
	last_deal_at: string | null;
	facts: TrackRecordFacts;
}>`(select max(e.occurred_at) as last_deal_at, json_build_object(
	'coverage_verified_at', max(c.oldest),
	'deals_referred', count(distinct e.deal_id) filter (where e.role = 'referred'),
	'deals_worked', count(distinct e.deal_id) filter (where e.role = 'worked'),
	'won', count(distinct e.deal_id) filter (where e.role = 'worked' and e.outcome = 'won'),
	'lost', count(distinct e.deal_id) filter (where e.role = 'worked' and e.outcome = 'lost'),
	'first_worked_at', min(e.occurred_at) filter (where e.role = 'worked'),
	'last_contacted_at', (select max(a.occurred_at) from activity a where ${contacts}),
	'last_contact_note', (select a.summary from activity a where ${contacts}
		order by a.occurred_at desc, a.id desc limit 1),
	'override', v.trust_override,
	'recent_entries', (select coalesce(json_agg(t.entry order by t.occurred_at desc, t.id desc), '[]')
		from (select a.occurred_at, a.id, json_build_object('id', a.id, 'kind', a.kind,
				'when', a.occurred_at, 'summary', a.summary, 'detail', a.detail) as entry
			from activity a where a.vendor_id = v.id
			order by a.occurred_at desc, a.id desc limit 20) t),
	'introductions', (select coalesce(json_agg(json_build_object('id', l.id, 'kind', l.kind,
			'from_name', fp.name, 'to_name', tp.name, 'note', l.note,
			'occurred_at', l.occurred_on, 'via_party', l.via_party) order by l.created_at desc, l.id desc), '[]')
		from party_link l
		join party fp on fp.id = l.from_party and fp.merged_into is null and fp.deleted_at is null
		join party tp on tp.id = l.to_party and tp.merged_into is null and tp.deleted_at is null
		left join party bp on bp.id = l.via_party
		where v.party_id in (l.from_party, l.to_party, l.via_party)
			and l.kind in ('intro', 'intro_received', 'introduced', 'can_introduce', 'intro_requested')
			and (l.via_party is null or (bp.merged_into is null and bp.deleted_at is null)))
) as facts
from (select case when bool_and(s.deal_history_verified_at is not null)
		then min(s.deal_history_verified_at) end as oldest
	from vendor s where s.party_id = v.party_id and s.merged_into is null) c
left join ${associations} e on e.party_id = v.party_id)`;

const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;
const TIERS = [
	{ tier: "Proven", years: 2, worked: 8, rate: 0.7, days: 180 },
	{ tier: "Established", years: 1, worked: 3, rate: 0.5, days: 365 },
] as const;
const INSTANT =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/;

// In microseconds: coverage recorded later in the clock's millisecond is
// still in the future. Infinite and BC times are no coverage.
function microseconds(value: string | null) {
	const match = value && INSTANT.exec(value);
	if (!match) return null;
	const micros = (match[1] ?? "").padEnd(6, "0").slice(3);
	return BigInt(Date.parse(value)) * 1000n + BigInt(micros);
}

// The SQL's counts are whole and won plus lost never exceeds worked, so the
// old checks on them cannot fail.
export function rateTrackRecord(facts: TrackRecordFacts, now: number) {
	const coverage = microseconds(facts.coverage_verified_at);
	if (coverage === null || coverage > BigInt(now) * 1000n)
		return {
			...facts,
			computed_tier: "Unrated",
			deals_worked: null,
			deals_referred: null,
			won: null,
			lost: null,
			win_rate: null,
			formula_version: "vendor-trust.v1",
		} as const;
	const years = facts.first_worked_at
		? (now - Date.parse(facts.first_worked_at)) / YEAR_MS
		: 0;
	const days = facts.last_contacted_at
		? (now - Date.parse(facts.last_contacted_at)) / DAY_MS
		: Number.POSITIVE_INFINITY;
	const resolved = facts.won + facts.lost;
	const win_rate = resolved ? facts.won / resolved : null;
	const earned = TIERS.find(
		(t) =>
			years >= t.years &&
			facts.deals_worked >= t.worked &&
			win_rate !== null &&
			win_rate >= t.rate &&
			days >= 0 &&
			days <= t.days,
	);
	return {
		...facts,
		computed_tier: earned?.tier ?? "Trial",
		win_rate,
		formula_version: "vendor-trust.v1",
	} as const;
}
