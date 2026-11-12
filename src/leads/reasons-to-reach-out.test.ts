import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "kysely";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import type { Reader } from "../reader.ts";
import { withRollback } from "../test-rollback.ts";
import worker from "../worker.ts";
import { readReasonsToReachOut } from "./reasons-to-reach-out.ts";

const PARTNER = "00000000-0000-4000-8000-000000000001";
const FINGERPRINT = "0".repeat(64);
const read = (tx: Reader, limit = 25, before_id: string | null = null) =>
	readReasonsToReachOut(tx, { limit, before_id });

// Every seeded name, address and number is made up.
async function seed(tx: Reader) {
	await sql`insert into actor (id, slug, kind, display_name)
		values (${PARTNER}, 'reasons-partner', 'human', 'Example')`.execute(tx);
	await sql`insert into contact_state (slug, label, contactable, sort)
		values ('active', 'Example', true, 1)`.execute(tx);
	await sql`insert into practice_origination_feed (source, checkpoint, published_on,
		status, detail, updated_at) values
		('nppes', 'example-checkpoint', '2026-03-01', 'available', 'Example detail',
			'2026-03-02 04:05:06.789999+00'),
		('formation-fl', null, null, 'available', 'Example', now())`.execute(tx);
}

type Event = {
	key: string;
	name?: string;
	city?: string;
	published_on?: string;
	facts?: Record<string, unknown>;
};
async function nppes(tx: Reader, e: Event) {
	const { rows } = await sql<{
		id: string;
	}>`insert into practice_origination_event
		(source, record_key, fingerprint, npi, name, city, state, kind, evidence_date,
			date_basis, source_url, facts, published_on, recorded_at, recorded_by)
		values ('nppes', ${e.key}, ${FINGERPRINT}, ${e.key}, ${e.name ?? `Example Practice ${e.key}`},
			${e.city ?? "Exampleton"}, 'AL', 'enumeration', '2026-02-27', 'enumeration',
			${`https://npiregistry.cms.hhs.gov/provider-view/${e.key}`},
			${JSON.stringify(e.facts ?? {})}, ${e.published_on ?? "2026-03-01"},
			'2026-03-08 07:30:00.123456+00', ${PARTNER})
		returning id::text`.execute(tx);
	return rows[0]?.id ?? "";
}

async function formation(
	tx: Reader,
	key: string,
	facts: Record<string, string>,
) {
	await sql`insert into practice_origination_event (source, record_key, fingerprint,
		document_number, filing_on, name, city, state, kind, evidence_date, date_basis,
		source_url, facts, published_on, recorded_by)
		values ('formation-fl', ${key}, ${FINGERPRINT}, ${key}, '2026-02-27',
			${`Example Dental ${key}`}, 'Exampleton', 'FL', 'formation_candidate', '2026-02-27',
			'filing', 'https://dos.fl.gov/sunbiz/other-services/data-downloads/daily-data/',
			${JSON.stringify(facts)}, '2026-03-01', ${PARTNER})`.execute(tx);
}

type Party = { name: string; npi?: string; city?: string; client?: string };
async function party(tx: Reader, p: Party) {
	const { rows } = await sql<{
		id: string;
	}>`insert into party (kind, name, city, state,
		npi, created_by, updated_by)
		values ('org', ${p.name}, ${p.city ?? "Exampleton"}, 'AL', ${p.npi ?? null},
			${PARTNER}, ${PARTNER}) returning id`.execute(tx);
	const id = rows[0]?.id ?? "";
	if (p.client)
		await sql`insert into client (party_id, roster_ref, created_by, updated_by)
			values (${id}, ${p.client}, ${PARTNER}, ${PARTNER})`.execute(tx);
	return id;
}

const routes = async (tx: Reader) =>
	Object.fromEntries(
		(await read(tx)).cards.map((c) => [c.record_key, c.route] as const),
	);

test("one card per record, newest first, paged by before_id", () =>
	withRollback(async (tx) => {
		await seed(tx);
		const first = await nppes(tx, { key: "1000000001" });
		const b = await nppes(tx, { key: "1000000002" });
		const a = await nppes(tx, {
			key: "1000000001",
			published_on: "2026-03-05",
		});
		const c = await nppes(tx, { key: "1000000003" });
		const page = async (limit: number, before: string | null = null) => {
			const answer = await read(tx, limit, before);
			return [answer.cards.map((card) => card.id), answer.next_cursor];
		};
		assert.deepEqual(await page(2), [[c, a], a]);
		assert.deepEqual(await page(2, a), [[b], null]);
		assert.deepEqual(await page(3), [[c, a, b], null]);
		assert.deepEqual(await page(2, c), [[a, b], null]);
		assert.deepEqual(await page(1, b), [[], null]);
		assert.ok(!(await read(tx)).cards.some((card) => card.id === first));
	}));

test("a card keeps the old keys, order and text forms", () =>
	withRollback(async (tx) => {
		await seed(tx);
		const id = await nppes(tx, {
			key: "1000000001",
			facts: { specialty: "Example", address: "1 Example Way" },
		});
		const client = await party(tx, {
			name: "Example Clinic",
			npi: "1000000001",
			client: "C-EXAMPLE",
		});
		const clientId = (
			await sql<{
				id: string;
			}>`select id from client where party_id = ${client}`.execute(tx)
		).rows[0]?.id;
		const [card] = (await read(tx)).cards;
		assert.equal(
			JSON.stringify(card),
			JSON.stringify({
				id,
				source: "nppes",
				record_key: "1000000001",
				npi: "1000000001",
				name: "Example Practice 1000000001",
				city: "Exampleton",
				state: "AL",
				kind: "enumeration",
				document_number: null,
				filing_on: null,
				evidence_date: "2026-02-27",
				date_basis: "enumeration",
				source_url: "https://npiregistry.cms.hhs.gov/provider-view/1000000001",
				facts: { address: "1 Example Way", specialty: "Example" },
				published_on: "2026-03-01",
				recorded_at: "2026-03-08T07:30:00.123Z",
				route: "relationship_follow_up",
				client_refs: ["C-EXAMPLE"],
				client_ids: [clientId],
				why_now: "NPI enumerated on 2026-02-27",
			}),
		);
	}));

test("a card routes by NPI, by name with city and state, and by street address", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await nppes(tx, { key: "1000000001" });
		await nppes(tx, { key: "1000000002", facts: { mailing_only: true } });
		await nppes(tx, { key: "1000000003" });
		await nppes(tx, { key: "1000000004", name: "Example Name Match" });
		await nppes(tx, {
			key: "1000000005",
			facts: { address: "100 example st ste 2, Exampleton AL 36500" },
		});
		await nppes(tx, { key: "1000000006" });
		await party(tx, { name: "Example A", npi: "1000000001", client: "C-1" });
		await party(tx, { name: "Example B", npi: "1000000002", client: "C-2" });
		await party(tx, { name: "Example C", npi: "1000000003" });
		await party(tx, { name: "EXAMPLE NAME MATCH", city: "exampleton" });
		const addressed = await party(tx, { name: "Example E" });
		await sql`insert into record_flag (subject_type, subject_id, kind, value, source, created_by)
			values ('party', ${addressed}, 'address', ${JSON.stringify({
				found: true,
				epistemic_status: "source_backed",
				street_address:
					"100 Example Street, Suite 2, Exampleton, AL 36500-1234",
			})}, 'example', ${PARTNER})`.execute(tx);
		assert.deepEqual(await routes(tx), {
			"1000000001": "relationship_follow_up",
			"1000000002": "identity_review",
			"1000000003": "identity_review",
			"1000000004": "identity_review",
			"1000000005": "identity_review",
			"1000000006": "research",
		});
	}));

test("Florida filings sharing a registered agent's address go to identity review", () =>
	withRollback(async (tx) => {
		await seed(tx);
		const agent = "9 Example Rd, Exampleton FL";
		await formation(tx, "EXAMPLE00001", { registered_agent_address: agent });
		await formation(tx, "EXAMPLE00002", {
			registered_agent_address: "9 example road exampleton fl",
		});
		await formation(tx, "EXAMPLE00003", {
			address: "5 Example Ave",
			registered_agent_address: "5 example avenue",
		});
		await formation(tx, "EXAMPLE00004", {
			address: "6 Example Ave",
			registered_agent_address: "7 Example Ave",
		});
		assert.deepEqual(await routes(tx), {
			EXAMPLE00001: "identity_review",
			EXAMPLE00002: "identity_review",
			EXAMPLE00003: "identity_review",
			EXAMPLE00004: "research",
		});
		assert.equal(
			(await read(tx)).cards[0]?.why_now,
			"Healthcare-name research candidate filed on 2026-02-27; practice identity and opening unverified",
		);
	}));

test("coverage lists every configured source, imported or not", () =>
	withRollback(async (tx) => {
		await seed(tx);
		const { coverage } = await read(tx);
		assert.deepEqual(
			coverage.map((s) => [s.source, s.status, s.checkpoint]),
			[
				["nppes", "available", "example-checkpoint"],
				["pecos", "unavailable", null],
				["formation-al", "unavailable", null],
				["formation-fl", "unavailable", null],
				["recorder-escambia-fl", "unavailable", null],
				["recorder-baldwin-al", "unavailable", null],
				["recorder-other", "uncovered", null],
			],
		);
		const [imported, unread] = coverage.map((s) => JSON.stringify(s));
		assert.match(
			imported ?? "",
			/,"recovery":"[^"]+","checkpoint":"example-checkpoint","published_on":"2026-03-01","status":"available","detail":"Example detail","updated_at":"2026-03-02T04:05:06.789Z"}$/,
		);
		assert.match(
			unread ?? "",
			/^{"source":"pecos","enabled":true,.*,"recovery":"[^"]+","status":"unavailable","checkpoint":null}$/,
		);
	}));

const reasons = (search: string, connectionString: string) =>
	worker.request(
		`https://app.example.test/api/engine/reasons-to-reach-out${search}`,
		{ headers: { Cookie: "__Host-dealroom_session=made-up-session" } },
		{
			CARR: {
				fetch: async () =>
					Response.json({
						actor: { slug: "reasons-partner", display: "Example Partner" },
						csrf_token: "made-up-csrf",
					}),
			},
			DATABASE: { connectionString },
		},
	);

async function refusal(response: Response) {
	const { correlation_id, ...body } = (await response.json()) as {
		correlation_id: string;
	};
	assert.match(correlation_id, /^[0-9a-f-]{36}$/);
	return [response.status, body];
}

const generic = {
	error: "unhandled_verb_failure",
	hint: "The operation failed. Quote the correlation_id when reporting it.",
};

test("reasons to reach out refuse unknown fields, then a non-number, then the old schema's misses", async () => {
	const refused = async (search: string) =>
		refusal(await reasons(search, "postgres://made-up@127.0.0.1:1/none"));
	assert.deepEqual(await refused("?limit=x&cursor=1&%24bad=2"), [
		400,
		{
			error: "unregistered_operation_fields",
			hint: "Remove fields outside the documented input.",
			fields: ["cursor"],
		},
	]);
	for (const limit of ["x", "", "Infinity"])
		assert.deepEqual(await refused(`?limit=${limit}`), [
			400,
			{
				error: "invalid_number",
				hint: "Supply a numeric value for the named fields.",
				fields: ["limit"],
			},
		]);
	for (const search of [
		"?limit=0",
		"?limit=101",
		"?limit=2.5",
		"?before_id=",
		"?before_id=0",
		"?before_id=01",
		"?before_id=-1",
		`?before_id=${"1".repeat(20)}`,
	])
		assert.deepEqual(await refused(search), [400, generic], search);
});

test("reasons to reach out answer over HTTP and fail an id past bigint as the old read did", () =>
	withSnapshot(async (url) => {
		const db = new pg.Client({ connectionString: url });
		await db.connect();
		try {
			await db.query(`insert into actor (slug, kind, display_name)
				values ('reasons-partner', 'human', 'Example')`);
		} finally {
			await db.end();
		}
		const answered = await reasons("?limit=%201e1%20&before_id=12", url);
		assert.equal(answered.status, 200);
		assert.deepEqual(Object.keys((await answered.json()) as object), [
			"ok",
			"contract",
			"cards",
			"next_cursor",
			"coverage",
			"outreach_started",
		]);
		assert.deepEqual(
			await refusal(await reasons(`?before_id=${"9".repeat(19)}`, url)),
			[500, { ...generic, verb: "list-practice-origination" }],
		);
	}));
