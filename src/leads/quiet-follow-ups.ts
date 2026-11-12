import { sql } from "kysely";
import type { Reader } from "../reader.ts";

export type Cadence = { lead_days: number; vendor_days: number };

type Proposal = {
	subject_type: "lead" | "vendor";
	subject_id: string;
	party_id: string;
	ref: string | null;
	name: string;
	owner_id: string | null;
	anchor_on: string;
	basis: "created_at" | "last_contact";
	next_action_date: string | null;
	client_id: string | null;
	interval_days: number;
	due_on: string;
	owner: string | null;
	days_overdue: number;
};

const LIMIT = 1000;
const OPEN_STAGES = [
	"new",
	"qualified",
	"outreach_active",
	"engaged",
	"nurture_drip",
];
const CONTACTABLE_STATES = ["active", "nurture"];

const liveContactable = sql`p.merged_into is null and p.deleted_at is null
	and p.contact_state = any(${CONTACTABLE_STATES}::text[])`;

// Dates and "today" are America/Chicago calendar days, from carr_business_date.
const proposals = (db: Reader, cadence: Cadence, ownerSlug: string | null) =>
	sql<Proposal>`with subjects as (
		select 'lead'::text as subject_type, l.id as subject_id, l.party_id,
			l.registry_ref as ref, p.name, l.owner_id,
			greatest(l.last_touch, t.last_touch) as touched_on, l.created_at,
			l.next_action_date, c.id as client_id, ${cadence.lead_days}::int as interval_days
		from lead l
		join party p on p.id = l.party_id
		left join client c on c.id = l.client_id
		left join v_last_touch t on t.subject_type = 'lead' and t.subject_id = l.id
		where not l.suppressed and l.stage = any(${OPEN_STAGES}::text[]) and ${liveContactable}
			and (l.client_id is null
				or (c.merged_into is null and coalesce(c.status, '') not in ('cold', 'paused')))
		union all
		select 'vendor', v.id, v.party_id, v.vendor_ref, p.name, v.owner_id,
			greatest(v.last_touch, t.last_touch), v.created_at,
			null, null, ${cadence.vendor_days}::int
		from vendor v
		join party p on p.id = v.party_id
		left join v_last_touch t on t.subject_type = 'vendor' and t.subject_id = v.id
		where v.merged_into is null and v.disposition = 'active' and ${liveContactable}
	), anchored as (
		select s.*, coalesce(touched_on, carr_business_date(created_at)) as anchor_on
		from subjects s
		where not exists (select 1 from next_action n where n.status = 'open'
			and ((n.subject_type = s.subject_type and n.subject_id = s.subject_id)
				or (n.subject_type = 'client' and n.subject_id = s.client_id)))
	), due as (
		select a.*, coalesce(next_action_date, anchor_on + interval_days) as due_on
		from anchored a
	)
	select d.subject_type, d.subject_id, d.party_id, d.ref, d.name, d.owner_id,
		to_char(d.anchor_on, 'YYYY-MM-DD') as anchor_on,
		case when d.touched_on is null then 'created_at' else 'last_contact' end as basis,
		d.next_action_date, d.client_id, d.interval_days,
		to_char(d.due_on, 'YYYY-MM-DD') as due_on, a.slug as owner,
		carr_business_date() - d.due_on as days_overdue
	from due d
	left join actor a on a.id = d.owner_id
	where d.due_on <= carr_business_date()
		and (${ownerSlug}::text is null or a.slug = ${ownerSlug}::text)
	order by d.due_on, d.subject_type, d.subject_id
	limit ${LIMIT + 1}`.execute(db);

export async function readQuietFollowUps(
	db: Reader,
	cadence: Cadence,
	ownerSlug: string | null,
) {
	const { rows } = await proposals(db, cadence, ownerSlug);
	if (rows.length > LIMIT) return { error: "limit_exceeded" } as const;
	return {
		schema_version: "quiet-follow-ups.v1",
		cadence,
		proposals: rows,
		sent: false,
		tasks_created: false,
	};
}
