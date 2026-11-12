import assert from "node:assert/strict";
import { test } from "node:test";
import { type Insertable, type Kysely, type RawBuilder, sql } from "kysely";
import type { DB } from "../database.d.ts";
import { withRollback } from "../test-rollback.ts";
import { readCaptureQueue } from "./capture-queue.ts";

const id = (n: number) => `00000000-0000-4000-8000-0000000000${n}`;
type Candidate = Partial<Insertable<DB["capture_candidate"]>> &
	Pick<Insertable<DB["capture_candidate"]>, "confidence">;

async function seed(tx: Kysely<DB>) {
	const actor = await tx
		.insertInto("actor")
		.values({ slug: "capture-partner", kind: "human", display_name: "Example" })
		.returning("id")
		.executeTakeFirstOrThrow();
	let sessions = 0;
	// The transaction's now() is fixed, so expiry is exact and needs no sleep.
	const session = async (expires_at: RawBuilder<string>) => {
		const n = ++sessions;
		return (
			await tx
				.insertInto("capture_session")
				.values({
					nonce: `example-nonce-${n}`,
					device_id: "example-device",
					actor_id: actor.id,
					mode: "meeting",
					started_at: "2026-03-08 07:00:00+00",
					consent_announced_at: "2026-03-08 07:00:00+00",
					session_token_hash: `example-hash-${n}`,
					expires_at,
					state_at: "2026-03-08 07:00:00+00",
				})
				.returning("id")
				.executeTakeFirstOrThrow()
		).id;
	};
	let items = 0;
	const candidate = (session_id: string, values: Candidate) =>
		tx
			.insertInto("capture_candidate")
			.values({
				session_id,
				idempotency_key: "example-key",
				batch_hash: "example-batch",
				item_index: items++,
				kind: "next_step",
				payload: JSON.stringify({ value: "Example step" }),
				evidence_quote: "Example quote",
				created_at: "2026-03-08 07:30:00+00",
				...values,
			})
			.execute();
	const live = await session(sql`now() + interval '1 hour'`);
	return { actor: actor.id, session, candidate, live };
}

// Sibling inserts' foreign keys are checked at the end of the statement.
const seedDeals = (tx: Kysely<DB>, a: string) =>
	sql`with cs as (insert into contact_state (slug, label, contactable, sort)
		values ('active', 'Example', true, 1)),
	t as (insert into deal_type_ref (slug, label, sort) values ('capture-lease', 'Example', 1)),
	ph as (insert into deal_phase (slug, label) values ('capture-open', 'Example')),
	p as (insert into party (kind, name, created_by, updated_by)
		values ('person', 'Example Capture Client', ${a}, ${a}) returning id),
	c as (insert into client (party_id, created_by, updated_by)
		select id, ${a}, ${a} from p returning id)
	insert into deal (id, name, client_id, deal_type, phase, created_by, updated_by)
	select v.id::uuid, v.name, c.id, 'capture-lease', 'capture-open', ${a}, ${a}
	from c, (values (${id(90)}, 'Example Capture Deal B'),
		(${id(91)}, 'Example Capture Deal A')) v(id, name)`.execute(tx);

test("pending candidates answer in the old keys, by confidence, then time, then id", () =>
	withRollback(async (tx) => {
		const { actor, candidate, live } = await seed(tx);
		await seedDeals(tx, actor);
		await candidate(live, {
			id: id(11),
			confidence: "0.9",
			created_at: "2026-03-08 07:31:00+00",
			payload: JSON.stringify({ value: "Example step", deal: id(90) }),
		});
		await candidate(live, {
			id: id(13),
			confidence: "0.90",
			created_at: "2026-03-08 07:30:00.123456+00",
			payload: JSON.stringify({ ref: id(91) }),
		});
		await candidate(live, {
			id: id(12),
			confidence: "0.9",
			created_at: "2026-03-08 07:30:00.123456+00",
			kind: "phase_move",
			payload: JSON.stringify({ deal: "example capture deal%" }),
		});
		await candidate(live, {
			id: id(14),
			confidence: "0.5",
			created_at: "2026-03-08 07:00:00+00",
			kind: "activity",
			payload: JSON.stringify({ text: "Example call" }),
			evidence_quote: "",
		});
		const row = (n: number, kind: string, rest: string) =>
			`{"id":"${id(n)}","session_id":"${live}","kind":"${kind}",${rest}}`;
		assert.equal(
			JSON.stringify(await readCaptureQueue(tx)),
			`{"candidates":[${[
				row(
					12,
					"phase_move",
					`"payload":{"deal":"example capture deal%"},"evidence_quote":"Example quote","confidence":0.9,"deal_name":"Example Capture Deal A","created_at":"2026-03-08T07:30:00.123456+00:00"`,
				),
				row(
					13,
					"next_step",
					`"payload":{"ref":"${id(91)}"},"evidence_quote":"Example quote","confidence":0.9,"deal_name":"Example Capture Deal A","created_at":"2026-03-08T07:30:00.123456+00:00"`,
				),
				row(
					11,
					"next_step",
					`"payload":{"deal":"${id(90)}","value":"Example step"},"evidence_quote":"Example quote","confidence":0.9,"deal_name":"Example Capture Deal B","created_at":"2026-03-08T07:31:00+00:00"`,
				),
				row(
					14,
					"activity",
					`"payload":{"text":"Example call"},"evidence_quote":"","confidence":0.5,"deal_name":null,"created_at":"2026-03-08T07:00:00+00:00"`,
				),
			].join(",")}]}`,
		);
	}));

test("only pending candidates of sessions expiring after now are queued", () =>
	withRollback(async (tx) => {
		const { actor, session, candidate, live } = await seed(tx);
		const quoted = async (session_id: string, evidence_quote: string) =>
			candidate(session_id, { confidence: "0.5", evidence_quote });
		await quoted(live, "Example live");
		await quoted(
			await session(sql`now() + interval '1 microsecond'`),
			"Example barely live",
		);
		await quoted(await session(sql`now()`), "Example expiring now");
		await quoted(
			await session(sql`now() - interval '1 day'`),
			"Example expired",
		);
		const resolved = {
			confidence: "0.5",
			resolved_by: actor,
			resolved_at: "2026-03-08 08:00:00+00",
		};
		await candidate(live, {
			...resolved,
			status: "skipped",
			evidence_quote: "Example skipped",
		});
		await candidate(live, {
			...resolved,
			status: "confirmed",
			resulting_ref: "D-1",
			evidence_quote: "Example confirmed",
		});
		const { candidates } = await readCaptureQueue(tx);
		assert.deepEqual(candidates.map((c) => c.evidence_quote).sort(), [
			"Example barely live",
			"Example live",
		]);
	}));

test("confidence prints as the old system's float, and float ties fall to time", () =>
	withRollback(async (tx) => {
		const { candidate, live } = await seed(tx);
		const confidences = [
			["0", "07:01"],
			["0.00000001", "07:02"],
			["0.1", "07:03"],
			["0.30000000000000000001", "07:05"],
			["0.3", "07:04"],
			["0.33333333333333333333", "07:06"],
			["0.90", "07:07"],
			["1.0", "07:09"],
			["1", "07:08"],
		] as const;
		for (const [confidence, at] of confidences)
			await candidate(live, {
				confidence,
				created_at: `2026-03-08 ${at}:00+00`,
				evidence_quote: confidence,
			});
		const { candidates } = await readCaptureQueue(tx);
		assert.equal(
			JSON.stringify(candidates.map((c) => c.confidence)),
			"[1,1,0.9,0.3333333333333333,0.3,0.3,0.1,1e-8,0]",
		);
		assert.deepEqual(
			candidates.map((c) => c.evidence_quote),
			[
				"1",
				"1.0",
				"0.90",
				"0.33333333333333333333",
				"0.3",
				"0.30000000000000000001",
				"0.1",
				"0.00000001",
				"0",
			],
		);
	}));
