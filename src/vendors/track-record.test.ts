import assert from "node:assert/strict";
import { test } from "node:test";
import { type Kysely, type RawBuilder, sql } from "kysely";
import type { DB } from "../database.d.ts";
import { asText } from "../reader.ts";
import { withRollback } from "../test-rollback.ts";
import { rateTrackRecord, trackRecordFacts } from "./track-record.ts";

type Spec = { won?: number; lost?: number; open?: number; contact?: string };
type Evidence = [deal: string, occurred_at: string];
type Id = { id: string };

const DAY = 86_400_000;
const NOW = "2026-06-01T12:00:00.000Z";
const VERIFIED = "2024-01-01T00:00:00Z";

async function seed(tx: Kysely<DB>) {
	const id = async (query: RawBuilder<Id>) => {
		const [row] = (await query.execute(tx)).rows;
		assert.ok(row);
		return row.id;
	};
	const actor = await id(sql<Id>`insert into actor (slug, kind, display_name)
		values ('trust-partner', 'human', 'Example') returning id`);
	await sql`insert into contact_state values ('active', 'Example', true, 1) on conflict do nothing;
		insert into vendor_disposition values ('active', 'Example', true, 1) on conflict do nothing;
		insert into activity_kind values ('call', 'Example', true), ('note', 'Example', false)
			on conflict do nothing;
		insert into party_link_kind values ('intro', 'Example', 1), ('knows', 'Example', 2)
			on conflict do nothing;
		insert into deal_type_ref values ('trust-lease', 'Example', 1);
		insert into deal_phase values ('trust-open', 'Example') on conflict do nothing`.execute(
		tx,
	);
	const party = (name = "Example Co", deleted_at: string | null = null) =>
		id(sql<Id>`insert into party (kind, name, deleted_at, created_by, updated_by)
			values ('person', ${name}, ${deleted_at}, ${actor}, ${actor}) returning id`);
	const deal = async (outcome: string | null, client = party()) =>
		id(sql<Id>`with c as (insert into client (party_id, created_by, updated_by)
				values (${await client}, ${actor}, ${actor}) returning id)
			insert into deal (client_id, name, deal_type, phase, outcome, created_by, updated_by)
			select c.id, 'Example Deal', 'trust-lease', 'trust-open', ${outcome}, ${actor}, ${actor}
			from c returning id`);
	const vendor = (
		party_id: string,
		evidence: Evidence[] = [],
		verified: string | null = VERIFIED,
		merged_into: string | null = null,
	) => {
		const entries = evidence.map(([deal_id, occurred_at]) => ({
			deal_id,
			role: "worked",
			occurred_at,
			evidence_kind: "entry",
			evidence_ref: "Example",
		}));
		return id(sql<Id>`insert into vendor (party_id, category, deal_evidence,
				deal_history_verified_at, merged_into, created_by, updated_by)
			values (${party_id}, 'lender', ${JSON.stringify(entries)}, ${verified},
				${merged_into}, ${actor}, ${actor}) returning id`);
	};
	const contact = (vendor_id: string, occurred_at: string, kind = "call") =>
		sql`insert into activity (vendor_id, occurred_at, kind, summary, actor_id)
			values (${vendor_id}, ${occurred_at}, ${kind}, ${`Example ${kind}`}, ${actor})`.execute(
			tx,
		);
	const link = (from: string, to: string, kind: string) =>
		id(sql<Id>`insert into party_link (from_party, to_party, kind, source, created_by, occurred_on)
			values (${from}, ${to}, ${kind}, 'Example', ${actor}, '2026-01-02') returning id`);
	const referral = (
		link_id: string,
		deal_id: string,
		by: string,
		on: string | null,
	) =>
		sql`insert into party_link_deal (link_id, deal_id, referred_by, occurred_on, note, created_by,
			created_at) values (${link_id}, ${deal_id}, ${by}, ${on}, 'Example', ${actor},
			'2025-03-04T05:06:07.123456Z')`.execute(tx);
	// A vendor whose deals all date from `worked_on`.
	const rated = async (
		spec: Spec,
		worked_on = "2024-06-01",
		verified: string | null = VERIFIED,
	) => {
		const outcomes = [
			...Array<string>(spec.won ?? 0).fill("won"),
			...Array<string>(spec.lost ?? 0).fill("lost"),
			...Array<null>(spec.open ?? 0).fill(null),
		];
		const deals = await Promise.all(outcomes.map((o) => deal(o)));
		const v = await vendor(
			await party(),
			deals.map((d): Evidence => [d, worked_on]),
			verified,
		);
		if (spec.contact) await contact(v, spec.contact);
		return v;
	};
	return { party, deal, vendor, contact, link, referral, rated };
}

async function rating(tx: Kysely<DB>, vendor: string, clock: string | number) {
	const row = await tx
		.selectFrom("vendor as v")
		.innerJoinLateral(trackRecordFacts.as("vr"), (join) => join.onTrue())
		.select(["vr.facts", asText(sql.ref("vr.last_deal_at")).as("last_deal_at")])
		.where("v.id", "=", vendor)
		.executeTakeFirstOrThrow();
	const now = typeof clock === "number" ? clock : Date.parse(clock);
	return { ...rateTrackRecord(row.facts, now), last_deal_at: row.last_deal_at };
}

// Two years of 365.25 days after a date-only "2024-06-01" read as UTC
// midnight is NOW, and the contact is 180 days before it.
const PROVEN = { won: 7, lost: 3, contact: "2025-12-03T12:00:00Z" };
// One such year after 2025-06-01 is 06:00 UTC, 365 days after the contact.
const ESTABLISHED = {
	won: 1,
	lost: 1,
	open: 1,
	contact: "2025-06-01T06:00:00Z",
};

test("each tier holds exactly at its thresholds and drops just past them", () =>
	withRollback(async (tx) => {
		const s = await seed(tx);
		const proven: [string, Spec, number, string][] = [
			["proven at every threshold", PROVEN, 0, "Proven"],
			["a millisecond short of two years", PROVEN, -1, "Established"],
			["contact a millisecond past 180 days", PROVEN, 1, "Established"],
			[
				"midnight UTC, the day before in Chicago",
				PROVEN,
				-DAY / 2,
				"Established",
			],
			["contact a millisecond ahead", PROVEN, -180 * DAY - 1, "Trial"],
			["win rate under 0.7", { ...PROVEN, lost: 4 }, 0, "Established"],
			["seven deals worked", { ...PROVEN, won: 5, lost: 2 }, 0, "Established"],
			["no contact", { won: 7, lost: 3 }, 0, "Trial"],
			[
				"no won or lost deal",
				{ ...PROVEN, won: 0, lost: 0, open: 10 },
				0,
				"Trial",
			],
			["no deals", { contact: PROVEN.contact }, 0, "Trial"],
		];
		for (const [name, spec, offset, tier] of proven) {
			const record = await rating(
				tx,
				await s.rated(spec),
				Date.parse(NOW) + offset,
			);
			assert.equal(record.computed_tier, tier, name);
		}
		const established: [string, Spec, number, string][] = [
			["established at every threshold", ESTABLISHED, 0, "Established"],
			["a millisecond short of a year", ESTABLISHED, -1, "Trial"],
			["contact a millisecond past 365 days", ESTABLISHED, 1, "Trial"],
			["win rate under 0.5", { ...ESTABLISHED, lost: 2, open: 0 }, 0, "Trial"],
			["two deals worked", { ...ESTABLISHED, open: 0 }, 0, "Trial"],
		];
		for (const [name, spec, offset, tier] of established) {
			const vendor = await s.rated(spec, "2025-06-01T00:00:00Z");
			const at = Date.parse("2026-06-01T06:00:00Z") + offset;
			assert.equal((await rating(tx, vendor, at)).computed_tier, tier, name);
		}
	}));

test("a vendor is unrated unless every live row of its party was verified by the clock", () =>
	withRollback(async (tx) => {
		const s = await seed(tx);
		const tier = async (vendor: string, clock = NOW) =>
			(await rating(tx, vendor, clock)).computed_tier;
		const verifiedAt = (at: string | null) => s.rated(PROVEN, undefined, at);
		assert.equal(await tier(await verifiedAt(null)), "Unrated");
		assert.equal(await tier(await verifiedAt("infinity")), "Unrated");
		assert.equal(await tier(await verifiedAt(NOW)), "Proven");
		const later = await verifiedAt("2026-06-01T12:00:00.000001Z");
		assert.equal(await tier(later), "Unrated");
		assert.equal(await tier(later, "2026-06-01T12:00:00.001Z"), "Established");

		const shared = await s.rated(PROVEN);
		const { party_id } = await tx
			.selectFrom("vendor")
			.select("party_id")
			.where("id", "=", shared)
			.executeTakeFirstOrThrow();
		await s.vendor(party_id, [], null, shared);
		assert.equal(await tier(shared), "Proven");
		await s.vendor(party_id, [], null);
		assert.partialDeepStrictEqual(await rating(tx, shared, NOW), {
			computed_tier: "Unrated",
			deals_worked: null,
			won: null,
			win_rate: null,
			first_worked_at: "2024-06-01T00:00:00+00:00",
		});
	}));

test("deals count once per party, from live rows and referrals on live clients", () =>
	withRollback(async (tx) => {
		const s = await seed(tx);
		const party = await s.party();
		const [worked, gone, dated, undated] = await Promise.all([
			s.deal("won"),
			s.deal("won", s.party("Example Gone", NOW)),
			s.deal(null),
			s.deal("lost"),
		]);
		await s.vendor(party, [
			[worked, "2025-01-01"],
			[gone, "2024-01-01"],
		]);
		const vendor = await s.vendor(party, [[worked, "2025-02-01T10:00:00Z"]]);
		await s.vendor(party, [[undated, "2025-01-01"]], null, vendor);
		const link = await s.link(party, await s.party(), "knows");
		await s.referral(link, dated, party, "2026-03-04");
		await s.referral(link, undated, party, null);
		assert.partialDeepStrictEqual(await rating(tx, vendor, NOW), {
			deals_worked: 1,
			deals_referred: 2,
			won: 1,
			lost: 0,
			win_rate: 1,
			first_worked_at: "2025-01-01T00:00:00+00:00",
			last_deal_at: "2026-03-04T00:00:00+00:00",
		});
	}));

test("the track record keeps the old keys, contact and introductions", () =>
	withRollback(async (tx) => {
		const s = await seed(tx);
		const party = await s.party();
		const vendor = await s.vendor(party);
		await s.contact(vendor, "2026-05-01T09:00:00.123456Z");
		await s.contact(vendor, "2026-05-20T00:00:00Z", "note");
		const intro = await s.link(party, await s.party("Example Other"), "intro");
		await s.link(party, await s.party(), "knows");
		await s.link(await s.party("Example Gone", NOW), party, "intro");
		const { last_deal_at: _, ...record } = await rating(tx, vendor, NOW);
		assert.equal(
			Object.keys(record).join(" "),
			"coverage_verified_at deals_referred deals_worked won lost first_worked_at last_contacted_at last_contact_note override recent_entries introductions computed_tier win_rate formula_version",
		);
		assert.partialDeepStrictEqual(record, {
			coverage_verified_at: "2024-01-01T00:00:00+00:00",
			last_contacted_at: "2026-05-01T09:00:00.123456+00:00",
			last_contact_note: "Example call",
			override: null,
			computed_tier: "Trial",
			formula_version: "vendor-trust.v1",
		});
		assert.deepEqual(
			record.recent_entries.map((e) => e.when),
			["2026-05-20T00:00:00+00:00", "2026-05-01T09:00:00.123456+00:00"],
		);
		assert.deepEqual(record.introductions, [
			{
				id: intro,
				kind: "intro",
				from_name: "Example Co",
				to_name: "Example Other",
				note: null,
				occurred_at: "2026-01-02",
				via_party: null,
			},
		]);
	}));

test("introductions and entries that tie on time come highest id first", () =>
	withRollback(async (tx) => {
		const s = await seed(tx);
		const party = await s.party();
		const vendor = await s.vendor(party);
		const [low, high] = [
			"00000000-0000-4000-8000-00000000000a",
			"00000000-0000-4000-8000-00000000000b",
		];
		for (const id of [low, high]) {
			await sql`insert into party_link (id, from_party, to_party, kind, source, created_by, created_at)
				select ${id}, ${party}, ${await s.party(`Example ${id}`)}, 'intro', 'Example', created_by,
				'2026-01-01T00:00:00Z' from party where id = ${party}`.execute(tx);
			await sql`insert into activity (id, vendor_id, occurred_at, kind, summary, actor_id)
				select ${id}, ${vendor}, '2026-01-01T00:00:00Z', 'note', 'Example', created_by
				from party where id = ${party}`.execute(tx);
		}
		const record = await rating(tx, vendor, NOW);
		assert.deepEqual(
			[
				record.introductions.map((i) => i.id),
				record.recent_entries.map((e) => e.id),
			],
			[
				[high, low],
				[high, low],
			],
		);
	}));
