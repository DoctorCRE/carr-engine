import { sql } from "kysely";
import { BusinessRefusal } from "../clients/read.ts";
import type { Reader } from "../reader.ts";
import { associations } from "../vendors/track-record.ts";

// Only the fields the suggestions read; every other key passes through.
type Node = {
	id: string;
	restricted?: boolean;
	contact_state: string;
	contact_state_until?: string | null;
};
type Edge = {
	id: string;
	to: string;
	via: string | null;
	from: string;
	kind: string;
	when: string | null;
	detail: string | null;
	summary: string | null;
};
type Referral = { won: number; lost: number; deals: number; node_id: string };
type Snapshot = { edges: Edge[]; nodes: Node[]; referrals: Referral[] };

const SCHEMA = "carr-relationship-network.v1";
// Two of the app's 60-second refreshes.
const VALID_FOR_MS = 120_000;
const MAX_NODES = 5000;
const MAX_EDGES = 20_000;
const INTRODUCED = ["introduced", "intro", "intro_received", "intro_requested"];

// Built as jsonb, as the old read was, so keys print in jsonb's order. A
// person or company takes each field from its first vendor row, else client
// row, else lead row, one field at a time.
const network = sql<Snapshot>`(with live as (
	select p.id, coalesce(v.id, c.id, l.id, p.id) as record_id,
		coalesce(v.vendor_ref, c.roster_ref, l.registry_ref, p.ref) as ref, p.name,
		case when v.id is not null then 'vendor' when c.id is not null then 'client'
			when l.id is not null then 'lead' else 'contact' end as kind,
		coalesce(v.territory, p.city) as territory,
		coalesce(v.verticals, array_remove(array[coalesce(c.vertical, l.segment)], null)) as verticals,
		a.slug as owner, coalesce(v.offers, c.notes, l.notes) as summary,
		p.contact_state, p.contact_state_until,
		exists (select from lead x where x.party_id = p.id
				and (x.suppressed or x.stage = 'do_not_contact'))
			or exists (select from vendor x where x.party_id = p.id and x.merged_into is null
				and x.disposition = 'avoid') as restricted
	from party p
	left join lateral (select * from vendor x where x.party_id = p.id and x.merged_into is null
		order by x.id limit 1) v on true
	left join lateral (select * from client x where x.party_id = p.id and x.merged_into is null
		order by x.id limit 1) c on true
	left join lateral (select * from lead x where x.party_id = p.id order by x.id limit 1) l on true
	left join actor a on a.id = coalesce(v.owner_id, c.owner_id, l.owner_id)
	where p.merged_into is null and p.deleted_at is null
), links as (
	select l.* from party_link l
	join live f on f.id = l.from_party
	join live t on t.id = l.to_party
	left join live b on b.id = l.via_party
	where (l.via_party is null or b.id is not null) and l.kind in ('knows', 'works_with',
		'can_introduce', 'intro_requested', 'introduced', 'intro', 'intro_received', 'referral', 'referred')
), deals as (
	select d.id, d.name, d.city, d.owner, d.phase, d.outcome, c.party_id, c.vertical from deal d
	join client c on c.id = d.client_id and c.merged_into is null
	join live p on p.id = c.party_id
), credited as (
	select a.* from ${associations} a join live p on p.id = a.party_id
), nodes as (
	select jsonb_build_object('id', 'party:' || p.id, 'record_id', p.record_id, 'ref', p.ref,
		'name', p.name, 'kind', p.kind, 'territory', p.territory, 'verticals', p.verticals,
		'owner', p.owner, 'summary', p.summary, 'contact_state', p.contact_state,
		'contact_state_until', p.contact_state_until, 'restricted', p.restricted) as item
		from live p where p.kind <> 'contact'
		or exists (select from links l where p.id in (l.from_party, l.to_party, l.via_party))
	union all
	select jsonb_build_object('id', 'deal:' || d.id, 'record_id', d.id, 'name', d.name, 'kind', 'deal',
		'territory', d.city, 'verticals', array_remove(array[d.vertical], null), 'owner', d.owner,
		'summary', d.phase, 'outcome', d.outcome, 'contact_state', 'active') from deals d
), edges as (
	select jsonb_build_object('id', 'link:' || l.id, 'from', 'party:' || l.from_party,
		'to', 'party:' || l.to_party, 'via', 'party:' || l.via_party, 'kind', l.kind,
		'when', coalesce(l.occurred_on::timestamptz, l.created_at),
		'summary', left(coalesce(l.note, ''), 180), 'detail', l.note) as item from links l
	union all
	select jsonb_build_object('id', 'client-deal:' || d.id, 'from', 'party:' || d.party_id,
		'to', 'deal:' || d.id, 'via', null, 'kind', 'client_deal', 'when', null,
		'summary', d.phase, 'detail', null) from deals d
	union all
	select jsonb_build_object('id', 'evidence:' || a.party_id || ':' || a.deal_id || ':' || a.role,
		'from', 'party:' || a.party_id, 'to', 'deal:' || a.deal_id, 'via', null, 'kind', a.role,
		'when', min(a.occurred_at), 'summary', a.role, 'detail', string_agg(distinct a.detail, E'\\n'))
	from credited a group by a.party_id, a.deal_id, a.role
), referrals as (
	select jsonb_build_object('node_id', 'party:' || p.id, 'deals', count(distinct a.deal_id),
		'won', count(distinct a.deal_id) filter (where a.outcome = 'won'),
		'lost', count(distinct a.deal_id) filter (where a.outcome = 'lost')) as item
	from live p
	join credited a on a.party_id = p.id and a.role = 'referred'
	where p.kind in ('vendor', 'client') group by p.id
)
select jsonb_build_object(
	'nodes', coalesce((select jsonb_agg(item order by item->>'name', item->>'id') from nodes), '[]'),
	'edges', coalesce((select jsonb_agg(item order by item->>'id') from edges), '[]'),
	'referrals', coalesce((select jsonb_agg(item order by item->>'node_id') from referrals), '[]')))`;

export const readNetwork = async (db: Reader) =>
	(await db.selectNoFrom(network.as("snapshot")).executeTakeFirstOrThrow())
		.snapshot;

const held = (node: Node, today: string) =>
	node.restricted === true ||
	(Boolean(node.contact_state) &&
		node.contact_state !== "active" &&
		(!node.contact_state_until || node.contact_state_until >= today));

const samePair = (a: Edge, b: Edge) =>
	(a.from === b.from && a.to === b.to) || (a.from === b.to && a.to === b.from);

// An introduction worth offering: a noted `can_introduce` link between two
// people neither held nor already introduced, through a broker not held.
export function projectNetwork(snapshot: Snapshot, observedAt: Date) {
	if (snapshot.nodes.length > MAX_NODES || snapshot.edges.length > MAX_EDGES)
		throw new BusinessRefusal({ error: "DEPENDENCY_UNAVAILABLE" });
	const observed_at = observedAt.toISOString();
	const today = observed_at.slice(0, 10);
	const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
	const free = (id: string) => {
		const node = nodes.get(id);
		return node !== undefined && !held(node, today);
	};
	const suggestions = snapshot.edges
		.filter(
			(edge) =>
				edge.kind === "can_introduce" &&
				edge.detail?.trim() &&
				free(edge.from) &&
				free(edge.to) &&
				(edge.via === null || free(edge.via)) &&
				!snapshot.edges.some(
					(other) => INTRODUCED.includes(other.kind) && samePair(edge, other),
				),
		)
		// The old Worker's localeCompare, which is not byte order.
		.sort(
			(a, b) =>
				(b.when ?? "").localeCompare(a.when ?? "") || a.id.localeCompare(b.id),
		)
		.map((edge) => ({
			id: edge.id,
			from: edge.from,
			to: edge.to,
			via: edge.via,
			reason: edge.summary,
			detail: edge.detail,
			when: edge.when,
		}));
	return {
		schema: SCHEMA,
		observed_at,
		valid_until: new Date(observedAt.valueOf() + VALID_FOR_MS).toISOString(),
		...snapshot,
		referrals: snapshot.referrals.map((row) => ({
			...row,
			win_rate: row.won + row.lost ? row.won / (row.won + row.lost) : null,
		})),
		suggestions,
	};
}
