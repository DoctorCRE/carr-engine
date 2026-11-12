import assert from "node:assert/strict";
import { test } from "node:test";
import { type Kysely, sql } from "kysely";
import type { DB } from "../database.d.ts";
import { withRollback } from "../test-rollback.ts";
import { readFind } from "./find.ts";

// Every seeded name is made up. Statements are plain SQL so one fixture
// reads top to bottom: parties, their roles, deals, then links.
async function seed(tx: Kysely<DB>) {
	await sql`insert into actor (slug, kind, display_name)
		values ('find-partner', 'human', 'Example')`.execute(tx);
	await sql`create temp table fixture on commit drop as
		select id as actor from actor where slug = 'find-partner'`.execute(tx);
	for (const statement of [
		sql`insert into contact_state (slug, label, contactable, sort) values ('active', 'Example', true, 1) on conflict do nothing`,
		sql`insert into lead_stage (slug, label) values ('find-new', 'Example')`,
		sql`insert into vendor_disposition (slug, label, workable, sort) values ('active', 'Example', true, 1) on conflict do nothing`,
		sql`insert into deal_type_ref (slug, label, sort) values ('find-lease', 'Example', 1)`,
		sql`insert into deal_phase (slug, label) values ('find-open', 'Example')`,
		sql`insert into party_link_kind (slug, label, sort) values ('referred', 'Example', 1)`,
	])
		await statement.execute(tx);
}

const party = (
	tx: Kysely<DB>,
	n: number,
	kind: "person" | "org",
	name: string,
	extra: { email?: string; merged_into?: number } = {},
) =>
	sql`insert into party (id, kind, name, ref, email, merged_into, created_by, updated_by)
		select ${uuid(n)}::uuid, ${kind}, ${name}, ${`P-${n}`}, ${extra.email ?? null},
		${extra.merged_into ? uuid(extra.merged_into) : null}::uuid, actor, actor from fixture`.execute(
		tx,
	);
const client = (tx: Kysely<DB>, n: number, ref: string | null) =>
	sql`insert into client (id, party_id, roster_ref, created_by, updated_by)
		select ${uuid(n)}::uuid, ${uuid(n)}::uuid, ${ref}, actor, actor from fixture`.execute(
		tx,
	);
const lead = (tx: Kysely<DB>, n: number, ref: string, converted?: number) =>
	sql`insert into lead (id, party_id, registry_ref, stage, client_id, created_by, updated_by)
		select ${uuid(n)}::uuid, ${uuid(n)}::uuid, ${ref}, 'find-new',
		${converted ? uuid(converted) : null}::uuid, actor, actor from fixture`.execute(
		tx,
	);
const vendor = (tx: Kysely<DB>, n: number, ref: string) =>
	sql`insert into vendor (id, party_id, vendor_ref, category, created_by, updated_by)
		select ${uuid(n)}::uuid, ${uuid(n)}::uuid, ${ref}, 'cpa', actor, actor from fixture`.execute(
		tx,
	);
const deal = (tx: Kysely<DB>, n: number, client: number, name: string) =>
	sql`insert into deal (id, client_id, name, deal_type, phase, closed_on, created_by, updated_by)
		select ${uuid(n)}::uuid, ${uuid(client)}::uuid, ${name}, 'find-lease', 'find-open',
		'2026-03-08', actor, actor from fixture`.execute(tx);
const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("each list answers in the old keys, order and note", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "org", "Ardenwood Clinic");
		await client(tx, 1, "C-1");
		await party(tx, 2, "person", "Dr. Ardenwood");
		await lead(tx, 2, "L-2", 1);
		await party(tx, 3, "org", "Ardenwood Partners");
		await party(tx, 4, "person", "Example Vendor");
		await vendor(tx, 4, "V-4");
		await deal(tx, 11, 1, "Ardenwood Clinic Lease");
		await deal(tx, 12, 1, "Example Other Deal");
		await sql`insert into party_link (from_party, to_party, kind, note, source, created_by)
			select ${uuid(2)}::uuid, ${uuid(4)}::uuid, 'referred', 'Example note', 'example', actor
			from fixture`.execute(tx);
		const dealJson = (name: string) =>
			`{"name":"${name}","phase":"find-open","owner":null,"client_ref":"C-1","invoiced_on":null,"closed_on":"2026-03-08","lane":null,"outcome":null}`;
		assert.equal(
			JSON.stringify(await readFind(tx, "Ardenwood")),
			`{"parties":[{"name":"Dr. Ardenwood","city":null,"specialty":null,"org_name":null,"ref":"L-2","kind":"lead","merged":false},{"name":"Ardenwood Clinic","city":null,"specialty":null,"org_name":null,"ref":"C-1","kind":"client","merged":false}],"deals":[${dealJson("Ardenwood Clinic Lease")}],"connections":[{"from_ref":"L-2","from_name":"Dr. Ardenwood","kind":"referred","to_ref":"V-4","to_name":"Example Vendor","note":"Example note"}],"organizations":[{"name":"Ardenwood Partners","live_rows":1,"refs":["P-3"],"retired_aliases":0,"retired_refs":[],"retired_refs_truncated":false,"live_as_role":0,"role_refs":[],"all_retired":false}],"lead_client_links":[{"lead_ref":"L-2","lead_name":"Dr. Ardenwood","client_ref":"C-1","client_name":"Ardenwood Clinic","link_basis":"conversion","either_merged":false}],"deals_via_link":[${dealJson("Example Other Deal")}],"note":"No retired aliases among these matches — every ref listed is live. lead_client_links carries 1 lead/client pair(s) touching this search, resolved by exact key and never by name. link_basis says which: \`conversion\` is lead.client_id, the pointer set when the lead became that client; \`same_party\` is one person holding both records; \`same_org\` is the lead sitting under the client's practice, which answers \\"is this practice already a client\\" and is NOT a conversion. deals_via_link carries 1 deal(s) that this search would otherwise have missed entirely: they are filed under the linked client, whose name does not contain the search term. \`deals\` is still the name-match list and the two are never blended."}`,
		);
	}));

test("each list matches by its own rule, with % and _ as wildcards", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "person", "Marlowe Example", {
			email: " Zoe@Mail.TEST ",
		});
		await client(tx, 1, "C-1");
		await party(tx, 2, "person", "Marlow Exampel");
		await lead(tx, 2, "L-2");
		await party(tx, 3, "person", "Zq Vendor");
		await vendor(tx, 3, "V-3");
		await deal(tx, 11, 1, "Example Lease 100% Done");
		await deal(tx, 12, 1, "Example Lease");
		await sql`insert into party_link (from_party, to_party, kind, source, created_by)
			select ${uuid(1)}::uuid, ${uuid(3)}::uuid, 'referred', 'example', actor
			from fixture`.execute(tx);
		const find = (query: string) => readFind(tx, query);
		const refs = async (query: string) =>
			(await find(query)).parties.map((p) => p.ref);
		const deals = async (query: string) =>
			(await find(query)).deals.map((d) => d.name);
		assert.deepEqual(await refs("Marlowe Example"), ["C-1", "L-2"]);
		assert.deepEqual(await refs("ZOE@mail.test  "), ["C-1"]);
		assert.deepEqual(await refs("zoe@mail.tes"), []);
		assert.deepEqual(await refs("M_rlowe"), ["C-1"]);
		assert.deepEqual(await deals("Lease%Done"), ["Example Lease 100% Done"]);
		assert.deepEqual(await deals("Le_se"), [
			"Example Lease",
			"Example Lease 100% Done",
		]);
		assert.deepEqual(await deals("Lease "), ["Example Lease 100% Done"]);
		const links = async (query: string) =>
			(await find(query)).connections.map((c) => [c.from_ref, c.to_ref]);
		assert.deepEqual(await links("C-_"), [["C-1", "V-3"]]);
		assert.deepEqual(await links("C-"), []);
		assert.deepEqual(await links("zq vendor"), [["C-1", "V-3"]]);
	}));

test("lists keep their caps, with merged last and the engine's fixed tie-break", () =>
	withRollback(async (tx) => {
		await seed(tx);
		for (let n = 111; n >= 100; n--) {
			await party(
				tx,
				n,
				"person",
				"Example Cap",
				n === 100 ? { merged_into: 111 } : {},
			);
			await client(tx, n, `C-${n}`);
		}
		for (let n = 1; n <= 7; n++)
			await party(tx, n, "org", `Example Cap Org ${n}`);
		for (let n = 200; n < 221; n++) {
			await party(tx, n, "person", `Example Lead ${n}`);
			await lead(tx, n, `L-${n}`, 101);
		}
		for (let n = 1; n <= 22; n++)
			await deal(
				tx,
				300 + n,
				101,
				`Example Cap Deal ${String(n).padStart(2, "0")}`,
			);
		await sql`insert into party_link (from_party, to_party, kind, source, created_at, created_by)
			select ${uuid(101)}::uuid, p.id, 'referred', 'example', timestamptz '2026-01-01', actor
			from fixture, party p where p.id <> ${uuid(101)}::uuid and p.name in ('Example Cap', 'Example Lead 200')
			union all select ${uuid(1)}::uuid, ${uuid(2)}::uuid, 'referred', 'example', timestamptz '2026-01-02', actor
			from fixture`.execute(tx);
		const found = await readFind(tx, "Example Cap");
		const range = (from: number, to: number, name: (n: number) => string) =>
			Array.from({ length: to - from + 1 }, (_, i) => name(from + i));
		assert.deepEqual(
			found.parties.map((p) => p.ref),
			range(101, 110, (n) => `C-${n}`),
		);
		assert.deepEqual(
			found.organizations.map((o) => o.name),
			range(1, 5, (n) => `Example Cap Org ${n}`),
		);
		const dealName = (n: number) =>
			`Example Cap Deal ${String(n).padStart(2, "0")}`;
		assert.deepEqual(
			found.deals.map((d) => d.name),
			range(1, 5, dealName),
		);
		assert.deepEqual(
			found.connections.map((c) => c.to_ref ?? c.to_name),
			[
				"Example Cap Org 2",
				...range(100, 111, (n) => `C-${n}`).filter((ref) => ref !== "C-101"),
			],
		);
		assert.deepEqual(
			found.lead_client_links.map((l) => l.lead_ref),
			range(200, 219, (n) => `L-${n}`),
		);
		assert.deepEqual(
			found.deals_via_link.map((d) => d.name),
			range(6, 20, dealName),
		);
	}));

test("live and retired rows are counted apart, and the note says which", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "org", "Example Retired Group");
		for (let n = 2; n <= 12; n++)
			await party(tx, n, "org", "Example Retired Group", { merged_into: 1 });
		await party(tx, 20, "org", "Example Promoted Practice");
		await client(tx, 20, "C-20");
		for (const n of [21, 22])
			await party(tx, n, "org", "Example Promoted Practice", {
				merged_into: 20,
			});
		await party(tx, 30, "org", "Example Orphan Name", { merged_into: 1 });
		const found = await readFind(tx, "Example");
		assert.equal(
			JSON.stringify(found.organizations),
			`[{"name":"Example Orphan Name","live_rows":0,"refs":[],"retired_aliases":1,"retired_refs":["P-30"],"retired_refs_truncated":false,"live_as_role":0,"role_refs":[],"all_retired":true},{"name":"Example Retired Group","live_rows":1,"refs":["P-1"],"retired_aliases":11,"retired_refs":["P-10","P-11","P-12","P-2","P-3","P-4","P-5","P-6","P-7","P-8"],"retired_refs_truncated":true,"live_as_role":0,"role_refs":[],"all_retired":false},{"name":"Example Promoted Practice","live_rows":0,"refs":[],"retired_aliases":2,"retired_refs":["P-21","P-22"],"retired_refs_truncated":false,"live_as_role":1,"role_refs":["C-20"],"all_retired":false}]`,
		);
		assert.ok(found.note.startsWith("LIVE and RETIRED are counted separately"));
		assert.match(
			found.note,
			/ "Example Promoted Practice" has no live PARTY row, .* Write to C-20, not to a retired P- ref\. Every row under "Example Orphan Name" is retired, .* we do not know them\.$/,
		);
	}));
