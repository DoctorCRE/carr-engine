import { sql } from "kysely";
import {
	type Meeting,
	meetingsFromSnapshot,
	UNAVAILABLE,
} from "../calendar/meetings.ts";
import { scheduling } from "../calendar/scheduling.ts";
import { attempt, storedSnapshot } from "../calendar/snapshot.ts";
import type { Reader } from "../reader.ts";
import { UUID } from "../uuid.ts";
import { latestAddress, office, research } from "./people.ts";

export const VIEWS = ["suggested", "research"] as const;
type View = (typeof VIEWS)[number];
export type MeetingsQuery = {
	view: View;
	q: string;
	limit: number;
	after: string[];
};
type Candidate = {
	vendor_id: string;
	contact: { id: string; email: string | null } | null;
};

const ZERO = "00000000-0000-0000-0000-000000000000";

// A held party is out of contact, an avoided vendor or a suppressed lead.
const restricted = sql`exists(select 1 from party held
	where held.id in (a.party_id, p.id, (a.company ->> 'id')::uuid)
	and ((held.contact_state <> 'active'
			and (held.contact_state_until is null or held.contact_state_until >= current_date))
		or exists(select 1 from vendor avoided where avoided.party_id = held.id
			and avoided.merged_into is null and avoided.disposition = 'avoid')
		or exists(select 1 from lead suppressed where suppressed.party_id = held.id
			and (coalesce(suppressed.suppressed, false) or suppressed.stage = 'do_not_contact'))))`;

// What a vendor's person lacks before a partner can be told to meet them.
const missing = sql`array_remove(array[
	case when nullif(btrim(p.name), '') is null then 'named_contact' end,
	case when nullif(btrim(a.company ->> 'name'), '') is null then 'company' end,
	case when vc.slug is null then 'category' end,
	case when not coalesce(vd.workable, false) then 'workable_vendor' end,
	case when v.out_of_market then 'in_market' end,
	case when nullif(btrim(v.offers), '') is null then 'meeting_reason' end,
	case when not coalesce(f.verified, false) then 'verified_office' end,
	case when ${restricted} then 'contact_permission' end], null)`;

function candidates(db: Reader, { view, q, limit, after }: MeetingsQuery) {
	const shown =
		view === "suggested"
			? sql`cardinality(missing) = 0`
			: sql`cardinality(missing) > 0`;
	const searched = q
		? sql`and strpos(lower(searched), lower(${q})) > 0`
		: sql``;
	return sql<{ total: number; items: Candidate[] }>`with candidate as (
		select a.id as vendor_id, coalesce(p.id, ${ZERO}::uuid) as contact_key,
			jsonb_build_object('vendor_id', a.id, 'ref', a.ref, 'party_id', a.party_id,
				'company', a.company,
				'contact', case when p.id is not null then jsonb_build_object('id', p.id,
					'name', p.name, 'email', p.email, 'phone', p.phone, 'cell', p.cell) end,
				'office', ${office}, 'research', ${research},
				'category', vc.slug, 'category_label', vc.label,
				'service_coverage', v.territory, 'reason', v.offers) as item,
			${missing} as missing,
			concat_ws(' ', a.ref, p.name, a.company ->> 'name', vc.slug, vc.label,
				v.territory, p.city, p.state, f.value ->> 'street_address',
				f.value ->> 'city', f.value ->> 'state') as searched
		from v_vendor_assignment_context a
		join vendor v on v.id = a.id
		left join vendor_category vc on vc.slug = coalesce(v.category_slug, v.category)
		left join vendor_disposition vd on vd.slug = v.disposition
		left join lateral (select p.* from jsonb_array_elements(a.contacts) listed
			join party p on p.id = (listed ->> 'id')::uuid) p on true
		${latestAddress(sql.ref("p.id"))}
	), matching as (
		select * from candidate where ${shown} ${searched}
	)
	select (select count(*)::int from matching) as total,
		coalesce(jsonb_agg(item || jsonb_build_object('missing', missing)
			order by vendor_id, contact_key), '[]') as items
	from (select * from matching
		where (vendor_id, contact_key) > (${after[0]}::uuid, ${after[1]}::uuid)
		order by vendor_id, contact_key limit ${limit + 1}) page`.execute(db);
}

const isId = (id: unknown) => typeof id === "string" && UUID.test(id);

// Where a page starts: the first, or after the row a cursor for the same
// view and search names.
export function pageAfter(cursor: string | undefined, view: View, q: string) {
	if (cursor === undefined) return [ZERO, ZERO];
	if (!cursor || cursor.length > 2000) return null;
	try {
		const token: Partial<Record<"v" | "view" | "q" | "after", unknown>> | null =
			JSON.parse(decodeURIComponent(atob(cursor)));
		const after = token?.after;
		const valid = token?.v === 1 && token.view === view && token.q === q;
		return valid &&
			Array.isArray(after) &&
			after.length === 2 &&
			after.every(isId)
			? after
			: null;
	} catch {
		return null;
	}
}

async function calendarFor(db: Reader, partner: string, now: Date) {
	const snapshot = await storedSnapshot(db, partner);
	// The old read answered a missing snapshot as it did an unreadable one.
	const section = meetingsFromSnapshot(snapshot, now) ?? UNAVAILABLE;
	const { items, ...calendar } = section;
	const planning = scheduling(snapshot, section, now);
	return { meetings: items, calendar: { ...calendar, scheduling: planning } };
}

// A person's meetings are those their email attends or organizes.
const attending = (meetings: readonly Meeting[], email: string | undefined) =>
	email
		? meetings.filter((meeting) =>
				[meeting.organizer, ...meeting.attendees].some(
					(p) => p.email === email,
				),
			)
		: [];

export async function readVendorMeetings(
	db: Reader,
	partner: string,
	query: MeetingsQuery,
) {
	const { view, q, limit } = query;
	const now = new Date();
	const found = await attempt(db, () => candidates(db, query));
	const page = found?.rows[0];
	if (!page) return null;
	const { meetings, calendar } = await calendarFor(db, partner, now);
	const items = page.items.slice(0, limit).map((item) => ({
		...item,
		possible_meetings: attending(
			meetings,
			item.contact?.email?.trim().toLowerCase(),
		),
	}));
	const last = items.at(-1);
	const has_more = page.items.length > limit;
	const next = last && [last.vendor_id, last.contact?.id || ZERO];
	return {
		schema: "vendor-meetings.v1",
		view,
		total: page.total,
		items,
		has_more,
		calendar,
		next_cursor:
			has_more && next
				? btoa(
						encodeURIComponent(JSON.stringify({ v: 1, view, q, after: next })),
					)
				: null,
		consistency: "live_keyset; restart after record changes",
	};
}
