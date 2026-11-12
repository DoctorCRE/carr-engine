import { sql } from "kysely";
import { asText, type Reader } from "../reader.ts";

const PARTIES = 10;
const ORGANIZATIONS = 5;
const DEALS = 5;
const CONNECTIONS = 12;
const LINKS = 20;
const RETIRED_REFS = 10;

type Organization = ReturnType<typeof toOrganization>;
type Link = Awaited<ReturnType<typeof linksTo>>[number];
type FindDeal = Awaited<ReturnType<typeof dealsNamed>>[number];

// The query goes into ilike unescaped, as the old system sent it, so % and _
// stay wildcards. Trigram % uses the server's default threshold of 0.3.
const nameMatches = (query: string) =>
	sql<boolean>`(display_name % ${query} or display_name ilike ${`%${query}%`}
		or party_id in (select id from party where lower(trim(email)) = lower(trim(${query}))))`;
const similarity = (query: string) => sql`similarity(display_name, ${query})`;
const subjectRef = sql<string>`coalesce(ref, subject_id::text)`;

const dealColumns = (db: Reader) =>
	db
		.selectFrom("v_deal_board")
		.select((eb) => [
			"name",
			"phase",
			"lead_owner as owner",
			"client_ref",
			asText(eb.ref("invoiced_on")).as("invoiced_on"),
			asText(eb.ref("closed_on")).as("closed_on"),
			"lane",
			"outcome",
		]);

// Orders past the old system's own are the engine's tie-breaks (decision 13).
const partiesMatching = (db: Reader, query: string) =>
	db
		.selectFrom("v_ref_index")
		.select([
			"display_name as name",
			"city",
			"specialty",
			"org_name",
			subjectRef.as("ref"),
			"subject_type as kind",
			"merged",
		])
		.where("subject_type", "in", ["lead", "client", "vendor"])
		.where(nameMatches(query))
		.orderBy("merged")
		.orderBy(similarity(query), "desc")
		.orderBy("ref")
		.orderBy("kind")
		.limit(PARTIES)
		.execute();

const organizationsMatching = (db: Reader, query: string) =>
	db
		.selectFrom("v_ref_index")
		.select([
			"display_name as name",
			sql<number>`count(*) filter (where not merged and subject_type = 'party')::int`.as(
				"live_rows",
			),
			sql<number>`count(*) filter (where merged and subject_type = 'party')::int`.as(
				"retired_aliases",
			),
			sql<string[]>`coalesce(array_agg(${subjectRef} order by ${subjectRef})
				filter (where not merged and subject_type = 'party'), '{}')`.as("refs"),
			sql<(string | null)[]>`coalesce((array_agg(ref order by ref)
				filter (where merged and subject_type = 'party'))[1:${sql.lit(RETIRED_REFS)}], '{}')`.as(
				"retired_refs",
			),
			sql<number>`count(*) filter (where not merged and subject_type <> 'party')::int`.as(
				"live_as_role",
			),
			sql<string[]>`coalesce(array_agg(${subjectRef} order by ${subjectRef})
				filter (where not merged and subject_type <> 'party'), '{}')`.as(
				"role_refs",
			),
		])
		.where(nameMatches(query))
		.groupBy("display_name")
		.having(sql<boolean>`count(*) filter (where subject_type = 'party') > 0`)
		.orderBy(similarity(query), "desc")
		.orderBy("display_name")
		.limit(ORGANIZATIONS)
		.execute();

const dealsNamed = (db: Reader, query: string) =>
	dealColumns(db)
		.where("name", "ilike", `%${query}%`)
		.orderBy("name")
		.orderBy("id")
		.limit(DEALS)
		.execute();

const connectionsOf = (db: Reader, query: string) =>
	db
		.selectFrom("v_party_graph")
		.select(["from_ref", "from_name", "kind", "to_ref", "to_name", "note"])
		.where((eb) =>
			eb.or([
				eb("from_name", "ilike", `%${query}%`),
				eb("to_name", "ilike", `%${query}%`),
				eb("from_ref", "ilike", query),
				eb("to_ref", "ilike", query),
			]),
		)
		.orderBy("linked_at", "desc")
		.orderBy("from_name")
		.orderBy("to_name")
		.orderBy("from_ref")
		.orderBy("to_ref")
		.orderBy("kind")
		.orderBy("note")
		.limit(CONNECTIONS)
		.execute();

const linksTo = (db: Reader, refs: string[]) =>
	db
		.selectFrom("v_lead_client_best")
		.select([
			"lead_ref",
			"lead_name",
			"client_ref",
			"client_name",
			"link_basis",
			"either_merged",
		])
		.where((eb) =>
			eb.or([eb("lead_ref", "in", refs), eb("client_ref", "in", refs)]),
		)
		.orderBy("link_basis")
		.orderBy("lead_ref")
		.orderBy("lead_id")
		.limit(LINKS)
		.execute();

const dealsOfClients = (db: Reader, refs: string[]) =>
	dealColumns(db)
		.where("client_ref", "in", refs)
		.orderBy("client_ref")
		.orderBy("name")
		.orderBy("id")
		.limit(LINKS)
		.execute();

const toOrganization = (
	org: Awaited<ReturnType<typeof organizationsMatching>>[number],
) => ({
	name: org.name,
	live_rows: org.live_rows,
	refs: org.refs,
	retired_aliases: org.retired_aliases,
	retired_refs: org.retired_refs,
	retired_refs_truncated: org.retired_aliases > org.retired_refs.length,
	live_as_role: org.live_as_role,
	role_refs: org.role_refs,
	all_retired: org.live_rows === 0 && org.live_as_role === 0,
});

export async function readFind(db: Reader, query: string) {
	const parties = await partiesMatching(db, query);
	const organizations = (await organizationsMatching(db, query)).map(
		toOrganization,
	);
	const deals = await dealsNamed(db, query);
	const connections = await connectionsOf(db, query);
	const matched = [
		...parties.flatMap((party) => (party.ref ? [party.ref] : [])),
		...organizations.flatMap((org) => [...org.refs, ...org.role_refs]),
	];
	const links = matched.length > 0 ? await linksTo(db, matched) : [];
	const clients = [
		...new Set(
			links.flatMap((link) => (link.client_ref ? [link.client_ref] : [])),
		),
	];
	const named = new Set(deals.map((deal) => deal.name));
	const viaLink =
		clients.length > 0
			? (await dealsOfClients(db, clients)).filter((d) => !named.has(d.name))
			: [];
	return {
		parties,
		deals,
		connections,
		organizations,
		lead_client_links: links,
		deals_via_link: viaLink,
		note: noteOn(
			parties.filter((party) => party.merged).length,
			organizations,
			links,
			viaLink,
		),
	};
}

const RETIRED_SEEN =
	"LIVE and RETIRED are counted separately here and are never blended. `refs` / `live_rows` (and any row with merged:false) are the survivors — those are the refs write verbs take. `retired_refs` / `retired_aliases` and any row with merged:true are tombstones of completed merges: they stay listed so a note, email or document citing an old ref is still navigable, but they are not duplicates and are never a write target.";
const NONE_RETIRED =
	"No retired aliases among these matches — every ref listed is live.";

// The old system's fixed sentences, printed verbatim by the Search page.
function noteOn(
	retiredParties: number,
	organizations: Organization[],
	links: Link[],
	viaLink: FindDeal[],
) {
	const retired =
		retiredParties +
		organizations.reduce((n, org) => n + org.retired_aliases, 0);
	const notes = [retired > 0 ? RETIRED_SEEN : NONE_RETIRED];
	const promoted = organizations.filter(
		(org) => org.live_rows === 0 && org.live_as_role > 0,
	);
	if (promoted.length > 0)
		notes.push(
			promoted
				.map((org) => {
					const refs = org.role_refs.join(", ");
					return `"${org.name}" has no live PARTY row, but it is not gone: the survivor is live in this same result under ${refs}. It stopped indexing as a bare party when it gained that record, which is how this index works — it indexes subjects, not roles. Write to ${refs}, not to a retired P- ref.`;
				})
				.join(" "),
		);
	const orphans = organizations.filter((org) => org.all_retired);
	if (orphans.length > 0)
		notes.push(
			`Every row under ${orphans.map((org) => `"${org.name}"`).join(", ")} is retired, and nothing under that name is live anywhere: that merge's survivor carries a DIFFERENT name and is not in this result. Search the survivor's name, or catch-me-up one of the retired refs to see where it went. This is not a claim that we do not know them.`,
		);
	if (links.length === 0) return notes.join(" ");
	const conversions = links.filter((l) => l.link_basis === "conversion");
	const sameOrg = links.filter((l) => l.link_basis === "same_org");
	notes.push(
		`lead_client_links carries ${links.length} lead/client pair(s) touching this search, resolved by exact key and never by name. link_basis says which: \`conversion\` is lead.client_id, the pointer set when the lead became that client; \`same_party\` is one person holding both records; \`same_org\` is the lead sitting under the client's practice, which answers "is this practice already a client" and is NOT a conversion.${conversions.length > 0 ? "" : " None of these is a conversion pointer."}${sameOrg.length > 0 ? " Read the same_org rows as neighbours, not as the same record." : ""}`,
	);
	if (viaLink.length > 0)
		notes.push(
			`deals_via_link carries ${viaLink.length} deal(s) that this search would otherwise have missed entirely: they are filed under the linked client, whose name does not contain the search term. \`deals\` is still the name-match list and the two are never blended.`,
		);
	return notes.join(" ");
}
