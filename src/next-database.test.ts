import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { url } from "./test-rollback.ts";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CLIENT = id(1);
const AGENT = id(2);
const PROPERTY = id(3);
const ELSEWHERE = id(4);
const DEAL = id(5);
const MISSING = id(99);
const LENDERS = [id(6), id(7)];

const SEED = `
insert into role (slug, label) values
	('client', 'Client'), ('listing_agent', 'Listing agent'), ('lender', 'Lender');
insert into party (id, kind, name) values
	('${CLIENT}', 'company', 'Example Dental Group'), ('${AGENT}', 'person', 'Avery Example'),
	('${LENDERS[0]}', 'company', 'Example Bank'), ('${LENDERS[1]}', 'company', 'Example Credit Union');
insert into party_role values ('${CLIENT}', 'client'), ('${AGENT}', 'listing_agent');
insert into property (id, address) values
	('${PROPERTY}', '100 Example Way, Springfield'), ('${ELSEWHERE}', '200 Example Way, Springfield');
insert into deal (id, name) values ('${DEAL}', 'Example Dental Springfield Deal');
insert into deal_property values ('${DEAL}', '${PROPERTY}');
insert into deal_party values ('${DEAL}', '${CLIENT}', 'client'), ('${DEAL}', '${AGENT}', 'listing_agent');
`;

// Our LOI, the landlord's counter, our response, and their acceptance of it.
// biome-ignore format: one row per round
const ROUNDS = [
	["client", CLIENT, "2026-03-02", "countered", 32, 60, 40, 3, "2026-07-01", null],
	["listing_agent", AGENT, "2026-03-09", "countered", 34.5, 84, 25, 2, "2026-08-01", null],
	["client", CLIENT, "2026-03-12", "accepted", 33.5, 84, 30, 2, "2026-08-01", "Example exclusive use"],
] as const;
const rounds = ROUNDS.map(
	(
		[from_role, from_party_id, day, status, rent, term, ti, free, start, other],
		i,
	) => ({
		id: id(100 + i),
		property_id: PROPERTY,
		round: i + 1,
		answers_round: i || null,
		from_party_id,
		from_role,
		offered_at: `${day}T15:00:00+00:00`,
		status,
		rent_per_sf_yr: rent,
		term_months: term,
		ti_per_sf: ti,
		free_rent_months: free,
		escalation_pct: 3,
		commencement_on: start,
		other_terms: other,
		documents: [
			{
				id: id(200 + i),
				name: `LOI round ${i + 1}.pdf`,
				r2_key: `example/loi-${i + 1}.pdf`,
			},
		],
	}),
);

const offer = (
	round: number,
	answers: number,
	from: string,
	role: string,
	at = PROPERTY,
) =>
	`insert into offer (deal_id, property_id, round, answers_round, from_party_id, from_role, offered_at)
	values ('${DEAL}', '${at}', ${round}, ${answers}, '${from}', '${role}', now())`;

const RULES: Record<string, [sql: string, constraint: string][]> = {
	"a link to a record that does not exist is refused": [
		[
			`insert into deal_party values ('${DEAL}', '${MISSING}', 'client')`,
			"deal_party_party_id_fkey",
		],
		[`delete from party where id = '${AGENT}'`, "party_role_party_id_fkey"],
	],
	"the role list refuses a role it does not hold": [
		[
			`insert into party_role values ('${AGENT}', 'mayor')`,
			"party_role_role_fkey",
		],
		[
			`insert into deal_party values ('${DEAL}', '${AGENT}', 'mayor')`,
			"deal_party_role_fkey",
		],
	],
	"the same link is stored once": [
		[
			`insert into deal_party values ('${DEAL}', '${AGENT}', 'listing_agent')`,
			"deal_party_pkey",
		],
	],
	"a person or company has a known kind": [
		[
			"insert into party (kind, name) values ('household', 'Example')",
			"party_kind_check",
		],
	],
	"a round number is used once per deal and answers an earlier round": [
		[offer(3, 2, AGENT, "listing_agent"), "offer_deal_id_round_key"],
		[offer(4, 4, AGENT, "listing_agent"), "offer_check"],
		[offer(9, 8, AGENT, "listing_agent"), "offer_deal_id_answers_round_fkey"],
	],
	"a round comes from someone on the deal about a property it is considering": [
		[
			offer(4, 3, CLIENT, "listing_agent"),
			"offer_deal_id_from_party_id_from_role_fkey",
		],
		[
			offer(4, 3, AGENT, "listing_agent", ELSEWHERE),
			"offer_deal_id_property_id_fkey",
		],
	],
	"an earlier round is never rewritten, and one round per deal is accepted": [
		[
			"update offer set rent_per_sf_yr = 30 where round = 1",
			"offer_keeps_its_terms",
		],
		[
			"update offer set status = 'accepted' where round = 1",
			"offer_one_accepted_per_deal",
		],
	],
};

// Its own database, because this schema's trigger would change the count database.test.ts reads.
const name = `engine_next_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Client({ connectionString: url });
const target = new URL(url);
target.pathname = `/${name}`;
const connect = async () => {
	const client = new pg.Client({
		connectionString: target.href,
		options: "-c search_path=next -c TimeZone=UTC",
	});
	await client.connect();
	return client;
};
let db: pg.Client;

before(async () => {
	await admin.connect();
	await admin.query(`create database "${name}"`);
	db = await connect();
	const schema = await readFile(
		new URL("../schema/next.sql", import.meta.url),
		"utf8",
	);
	await db.query(`create schema next; ${schema} ${SEED}`);
	for (const { documents, ...round } of rounds) {
		await db.query(
			"insert into offer select * from jsonb_populate_record(null::offer, $1)",
			[{ ...round, deal_id: DEAL, status: "open" }],
		);
		for (const document of documents)
			await db.query(
				`with saved as (insert into document
					select * from jsonb_populate_record(null::document, $1) returning id)
				insert into offer_document select $2, id from saved`,
				[document, round.id],
			);
		if (round.answers_round)
			await db.query("update offer set status = 'countered' where round = $1", [
				round.answers_round,
			]);
	}
	await db.query("update offer set status = 'accepted' where round = 3");
});

after(async () => {
	await db.end();
	await admin.query(`drop database "${name}" with (force)`);
	await admin.end();
});

test("everything about the LOI deal comes back in one read, rounds in order", async () => {
	const { rows } = await db.query("select everything_about_deal($1) as deal", [
		DEAL,
	]);
	assert.deepEqual(rows[0].deal, {
		deal: { id: DEAL, name: "Example Dental Springfield Deal" },
		properties: [{ id: PROPERTY, address: "100 Example Way, Springfield" }],
		parties: [
			{
				id: CLIENT,
				kind: "company",
				name: "Example Dental Group",
				role: "client",
			},
			{
				id: AGENT,
				kind: "person",
				name: "Avery Example",
				role: "listing_agent",
			},
		],
		offers: rounds,
	});
});

test("the property, the client and the listing agent each lead to the deal", async () => {
	const { rows } = await db.query(
		`select deal_id from deal_property where property_id = $1
		union all select deal_id from deal_party where party_id in ($2, $3)`,
		[PROPERTY, CLIENT, AGENT],
	);
	assert.deepEqual(rows, [
		{ deal_id: DEAL },
		{ deal_id: DEAL },
		{ deal_id: DEAL },
	]);
});

for (const [rule, cases] of Object.entries(RULES))
	test(rule, async () => {
		for (const [sql, constraint] of cases)
			await assert.rejects(db.query(sql), { constraint });
	});

test("a document holds a pointer to object storage, never the file", async () => {
	const { rows } = await db.query(
		"select column_name from information_schema.columns where table_schema = 'next' and data_type = 'bytea'",
	);
	assert.deepEqual(rows, []);
});

test("two partners adding different lenders to one deal at once both keep them", async () => {
	const writers = [await connect(), await connect()];
	try {
		for (const writer of writers) await writer.query("begin");
		await writers[1]?.query("set local lock_timeout = '1s'");
		for (const [i, writer] of writers.entries())
			await writer.query("insert into deal_party values ($1, $2, 'lender')", [
				DEAL,
				LENDERS[i],
			]);
		for (const writer of writers) await writer.query("commit");
		const { rows } = await db.query(
			"select party_id from deal_party where role = 'lender' order by party_id",
		);
		assert.deepEqual(
			rows.map((row) => row.party_id),
			LENDERS,
		);
	} finally {
		await Promise.all(writers.map((writer) => writer.end()));
	}
});
