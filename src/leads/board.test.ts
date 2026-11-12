import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "kysely";
import type { Reader } from "../reader.ts";
import { withRollback } from "../test-rollback.ts";
import { readLeadBoard } from "./board.ts";

// Every seeded name is made up.
async function seed(tx: Reader) {
	await sql`insert into actor (slug, kind, display_name)
		values ('leads-partner', 'human', 'Example')`.execute(tx);
	await sql`create temp table fixture on commit drop as
		select id as actor from actor where slug = 'leads-partner'`.execute(tx);
	for (const statement of [
		sql`insert into contact_state (slug, label, contactable, sort)
			values ('active', 'Example', true, 1), ('nurture', 'Example', true, 2),
			('paused', 'Example', false, 3) on conflict do nothing`,
		sql`insert into lead_stage (slug, label, sort) values ('new', 'New', 1),
			('qualified', 'Qualified', 2), ('closed_won', 'Won', 3), ('archived', 'Archived', 4)
			on conflict (slug) do update set label = excluded.label, sort = excluded.sort`,
		sql`insert into client_status (slug, label) values ('prospect', 'Example'),
			('active', 'Example') on conflict do nothing`,
	])
		await statement.execute(tx);
}

type Party = {
	kind?: "person" | "org";
	org?: number;
	contact_state?: string;
	merged_into?: number;
	deleted?: boolean;
};
const party = (tx: Reader, n: number, name: string, p: Party = {}) =>
	sql`insert into party (id, kind, name, org_id, city, contact_state, merged_into,
		deleted_at, created_by, updated_by)
		select ${uuid(n)}::uuid, ${p.kind ?? "person"}, ${name}, ${p.org ? uuid(p.org) : null}::uuid,
		'Springfield', ${p.contact_state ?? "active"}, ${p.merged_into ? uuid(p.merged_into) : null}::uuid,
		${p.deleted ? "2026-01-01T00:00:00Z" : null}::timestamptz, actor, actor from fixture`.execute(
		tx,
	);

type Lead = {
	stage?: string;
	score?: number | null;
	suppressed?: boolean;
	client?: number;
	next_action_date?: string;
	event_confidence?: string;
};
const lead = (tx: Reader, n: number, partyN: number, l: Lead = {}) =>
	sql`insert into lead (id, party_id, registry_ref, stage, score, suppressed, client_id,
		next_action_date, event_confidence, created_at, updated_at, created_by, updated_by)
		select ${uuid(n)}::uuid, ${uuid(partyN)}::uuid, ${`L-${n}`}, ${l.stage ?? "new"},
		${l.score ?? null}::numeric, ${l.suppressed ?? false}, ${l.client ? uuid(l.client) : null}::uuid,
		${l.next_action_date ?? null}::date, ${l.event_confidence ?? null},
		'2026-01-05 09:30:00.12+00', '2026-01-06 10:00:00+00', actor, actor from fixture`.execute(
		tx,
	);

type Client = { status?: string; inactive?: boolean; merged_into?: number };
const client = (tx: Reader, n: number, partyN: number, c: Client = {}) =>
	sql`insert into client (id, party_id, status, prospect_engagement_status, merged_into,
		created_by, updated_by)
		select ${uuid(n)}::uuid, ${uuid(partyN)}::uuid, ${c.status ?? "active"},
		${c.inactive ? "inactive" : "active"}, ${c.merged_into ? uuid(c.merged_into) : null}::uuid,
		actor, actor from fixture`.execute(tx);

const stageEvent = (
	tx: Reader,
	n: number,
	leadN: number,
	from: string,
	to: string,
	cause = "human_stated",
	review: Record<string, string> = {},
) =>
	sql`insert into event (id, occurred_at, actor_id, verb, subject_type, subject_id,
		old_value, new_value, cause, agent_rationale, idempotency_key)
		select ${uuid(n)}::uuid, '2026-02-03 14:05:06.5+00', actor, 'update-lead', 'lead',
		${uuid(leadN)}::uuid, jsonb_build_object('stage', ${from}::text),
		jsonb_build_object('stage', ${to}::text, 'stage_review', ${JSON.stringify(review)}::jsonb),
		${cause}, 'Example reason', ${`key-${n}`} from fixture`.execute(tx);

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Drops the clock fields after checking their format.
const board = async (tx: Reader) => {
	const answer = await readLeadBoard(tx);
	assert.ok(!("error" in answer));
	const { generated_at, ...rest } = answer;
	assert.match(generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	return {
		...rest,
		leads: rest.leads.map((lead) => {
			const { evaluated_at, ...reachability } = lead.reachability;
			assert.equal(evaluated_at, generated_at);
			return { ...lead, reachability };
		}),
	};
};

test("a lead answers in the old keys, key order, nulls and formats", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "Example Practice", { kind: "org" });
		await party(tx, 2, "Dr. Example", { org: 1 });
		await party(tx, 3, " dr. EXAMPLE ", { kind: "org" });
		await client(tx, 3, 3);
		await client(tx, 4, 2, { status: "prospect", inactive: true });
		await lead(tx, 5, 2, {
			stage: "qualified",
			score: 85,
			client: 4,
			next_action_date: "2026-03-01",
			event_confidence: "medium",
		});
		await stageEvent(tx, 9, 5, "new", "qualified", "automation_job", {
			evidence_date: "2026-02-01",
		});
		const advice = {
			handling_advice:
				"Confirm the decision window, decision makers and an appropriate introduction. Research the handed record before preparing an outreach draft.",
			strategy: {
				basis: "stage_based_guidance",
				hold: null,
				objective:
					"Confirm the decision window, decision makers and an appropriate introduction.",
				discovery: [
					"What has the practice already tried?",
					"What constraints and timing are firm?",
					"Who approves the decision?",
					"What would make the practice stop?",
					"What would success look like in 90 days?",
				],
				decision_window: null,
				confidence: "medium",
				next_step: "Respect the recorded next action date 2026-03-01.",
				channel:
					"Use a verified contact route. Keep outreach as a draft for a partner to send.",
				risk: "Do not infer personal circumstances, intent, or a confirmed lease expiry from a sourcing signal.",
				sent: false,
			},
		};
		const row = `{"id":"${uuid(5)}","city":"Springfield","lane":null,"name":"Dr. Example","owner":null,"score":85,"stage":"qualified","state":null,"county":null,"is_deal":false,"segment":null,"party_id":"${uuid(2)}","client_id":"${uuid(4)}","is_client":true,"specialty":null,"created_at":"2026-01-05T09:30:00.12+00:00","last_touch":null,"stage_sort":2,"suppressed":false,"updated_at":"2026-01-06T10:00:00+00:00","doctor_name":"Dr. Example","entity_name":"Dr. Example","owner_label":null,"stage_label":"Qualified","base_version":1,"registry_ref":"L-5","score_reason":null,"contact_state":"active","linked_client":true,"practice_name":"Example Practice","do_not_contact":false,"est_lease_event":null,"last_stage_move":{"to":"qualified","from":"new","reason":"Example reason","undone":null,"event_id":"${uuid(9)}","automatic":true,"occurred_at":"2026-02-03T14:05:06.5+00:00","evidence_date":"2026-02-01","idempotency_key":"key-9"},"contact_eligible":true,"event_confidence":"medium","next_action_date":"2026-03-01","possible_clients":[{"name":" dr. EXAMPLE ","client_id":"${uuid(3)}"}],"prospect_client_id":"${uuid(4)}","prospect_client_version":1,"prospect_engagement_status":"inactive",${JSON.stringify(advice).slice(1, -1)}}`;
		const label = `{"schema_version":"lead-reachability.v2","classification":"research","basis":"successful_contact_and_current_route","evidence_state":"unknown","contact_eligible":true,"research_state":"needs_research","missing_reasons":["verified_usable_route_not_established","recent_successful_contact_not_established"],"source_revision":"sha256:17012c7a3a1f943fdc74bf39143b625b5238d589eb451050f2b78620fff9fe5a","evidence":[],"successful_contact":null,"usable_route":null,"contact_freshness_days":90,"source_inputs":{"cell":null,"email":null,"phone":null,"party_id":"${uuid(2)}","activities":[],"created_at":"2026-01-05T09:30:00.12+00:00"}}`;
		assert.equal(
			JSON.stringify(await board(tx)),
			`{"schema_version":"lead-workspace.v1","leads":[${row.slice(0, -1)},"reachability":${label}}],"last_search_at":null,"search_run_coverage":"unavailable"}`,
		);
	}));

test("suppressed leads and leads of merged or deleted parties are left off", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "Example Kept");
		await party(tx, 2, "Example Merged", { merged_into: 1 });
		await party(tx, 3, "Example Deleted", { deleted: true });
		await party(tx, 4, "Example Suppressed");
		await party(tx, 5, "Example Paused", { contact_state: "paused" });
		await lead(tx, 11, 1);
		await lead(tx, 12, 2);
		await lead(tx, 13, 3);
		await lead(tx, 14, 4, { suppressed: true });
		await lead(tx, 15, 5, { stage: "archived" });
		const { leads } = await board(tx);
		assert.deepEqual(
			leads.map((l) => l.id),
			[uuid(11), uuid(15)],
		);
	}));

test("leads sort by stage, score high to low with no score last, name, then id", () =>
	withRollback(async (tx) => {
		await seed(tx);
		for (const [n, name] of [
			[1, "Example B"],
			[2, "Example A"],
			[3, "Example C"],
		] as const)
			await party(tx, n, name);
		await lead(tx, 21, 1, { stage: "qualified", score: 90 });
		await lead(tx, 22, 1, { score: null });
		await lead(tx, 23, 1, { score: 40 });
		await lead(tx, 24, 2, { score: 40 });
		await lead(tx, 25, 3, { score: 70 });
		await lead(tx, 26, 2, { score: 40 });
		const { leads } = await board(tx);
		assert.deepEqual(
			leads.map((l) => l.id),
			[25, 24, 26, 23, 22, 21].map(uuid),
		);
	}));

test("possible clients match the trimmed lower-case name of other live clients", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "Example Clinic");
		await client(tx, 1, 1);
		await party(tx, 2, "example clinic ");
		await client(tx, 4, 2);
		await party(tx, 3, "EXAMPLE CLINIC");
		await client(tx, 3, 3);
		await party(tx, 5, "Example Clinic");
		await client(tx, 5, 5, { merged_into: 1 });
		await party(tx, 6, "Example Clinic", { deleted: true });
		await client(tx, 6, 6);
		await party(tx, 7, "Example Other");
		await client(tx, 7, 7);
		await lead(tx, 31, 1);
		const [only]: Record<string, unknown>[] = (await board(tx)).leads;
		assert.deepEqual(only?.possible_clients, [
			{ name: "EXAMPLE CLINIC", client_id: uuid(3) },
			{ name: "example clinic ", client_id: uuid(4) },
		]);
	}));

test("the last stage move is the newest stage event, with undo and no review", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "Example Lead");
		await lead(tx, 41, 1, { stage: "qualified" });
		await stageEvent(tx, 42, 41, "new", "qualified");
		await stageEvent(tx, 43, 41, "qualified", "new", "human_stated", {
			undo_event_id: uuid(42),
		});
		await party(tx, 2, "Example Unmoved");
		await lead(tx, 44, 2);
		const moves = (await board(tx)).leads.map(
			(l: Record<string, unknown>) => l.last_stage_move,
		);
		assert.deepEqual(moves, [
			null,
			{
				to: "new",
				from: "qualified",
				reason: "Example reason",
				undone: uuid(42),
				event_id: uuid(43),
				automatic: false,
				occurred_at: "2026-02-03T14:05:06.5+00:00",
				evidence_date: null,
				idempotency_key: "key-43",
			},
		]);
	}));

test("a lead linked to a client that is not a prospect has no prospect fields", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "Example Client");
		await client(tx, 1, 1);
		await lead(tx, 51, 1, { client: 1 });
		const [only]: Record<string, unknown>[] = (await board(tx)).leads;
		assert.deepEqual(
			[
				only?.prospect_client_id,
				only?.prospect_client_version,
				only?.prospect_engagement_status,
			],
			[null, null, null],
		);
	}));

test("the advice text follows the hold, the stage and the next action date", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "Example Paused", { contact_state: "paused" });
		await party(tx, 2, "Example Nurture", { contact_state: "nurture" });
		await lead(tx, 61, 1);
		await lead(tx, 62, 2, { stage: "archived", score: 10 });
		await lead(tx, 63, 2, { stage: "closed_won", event_confidence: "" });
		await lead(tx, 64, 2);
		const advice = (await board(tx)).leads.map((l) => ({
			id: l.id,
			contact_eligible: l.contact_eligible,
			handling_advice: l.handling_advice,
			hold: l.strategy.hold,
			objective: l.strategy.objective,
			confidence: l.strategy.confidence,
			next_step: l.strategy.next_step,
		}));
		const held = {
			handling_advice:
				"Do not contact. Review the recorded restriction or terminal stage with the owning partner.",
			objective: "Resolve the recorded hold before any outreach.",
			confidence: "unrecorded",
			next_step: "Ask the owning partner to review the hold.",
		};
		const fresh = "Agree a next step and date; silence is not consent.";
		assert.deepEqual(advice, [
			{
				id: uuid(64),
				contact_eligible: true,
				handling_advice:
					"Verify identity and discover whether the practice has a real estate decision. Research the handed record before preparing an outreach draft.",
				hold: null,
				objective:
					"Verify identity and discover whether the practice has a real estate decision.",
				confidence: "unrecorded",
				next_step: fresh,
			},
			{
				...held,
				id: uuid(61),
				contact_eligible: false,
				hold: { reason: "contact_ineligible" },
			},
			{
				id: uuid(63),
				contact_eligible: true,
				handling_advice:
					"Closed won. Coordinate any post-close follow-up with the owning partner.",
				hold: null,
				objective:
					"Closed won. Coordinate any post-close follow-up with the owning partner.",
				confidence: "unrecorded",
				next_step: fresh,
			},
			{
				...held,
				id: uuid(62),
				contact_eligible: true,
				hold: { reason: "unsupported_stage" },
			},
		]);
	}));

const finding = (
	tx: Reader,
	n: number,
	[subjectType, subjectN]: ["party" | "lead", number],
	kind: string,
	value: Record<string, unknown>,
	observedAt: string,
	expiresOn: string | null = null,
	source = "Example registry",
) =>
	sql`insert into record_flag (id, subject_type, subject_id, kind, value, source,
		observed_at, expires_on, created_by)
		select ${uuid(n)}::uuid, ${subjectType}, ${uuid(subjectN)}::uuid, ${kind},
		${JSON.stringify(value)}::jsonb, ${source}, ${observedAt}::timestamptz,
		${expiresOn}::date, actor from fixture`.execute(tx);

type Activity = { kind?: string; source?: string; detail?: string };
const activity = (
	tx: Reader,
	n: number,
	leadN: number,
	ago: string,
	a: Activity = {},
) =>
	sql`insert into activity (id, occurred_at, actor_id, kind, summary, detail, lead_id,
		source, connected)
		select ${uuid(n)}::uuid, now() - ${ago}::interval, actor, ${a.kind ?? "call"},
		'Example', ${a.detail ?? null}, ${uuid(leadN)}::uuid, ${a.source ?? "stated"},
		true from fixture`.execute(tx);

const activityKinds = (tx: Reader) =>
	sql`insert into activity_kind (slug, label, is_contact)
		values ('call', 'Call', true), ('email_in', 'Email in', true)
		on conflict do nothing`.execute(tx);

const labels = async (tx: Reader) =>
	(await board(tx)).leads.map((l) => l.reachability);

test("the label keeps the old fingerprint, findings and route", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "Example Reach");
		await sql`update party set email = 'reach@example.test', phone = '(555) 010-0000'
			where id = ${uuid(1)}::uuid`.execute(tx);
		await lead(tx, 71, 1);
		await finding(
			tx,
			81,
			["party", 1],
			"email",
			{ email: "reach@example.test" },
			"2026-03-04 05:06:07.123456+00",
			"2099-01-01",
		);
		await finding(
			tx,
			82,
			["lead", 71],
			"verified",
			{ found: true, note: "Example" },
			"2026-03-01 00:00:00+00",
			null,
			"Example site",
		);
		await finding(
			tx,
			83,
			["party", 1],
			"office_phone",
			{ phone: "(555) 010-0000" },
			"2026-02-01 00:00:00+00",
			"2020-01-01",
		);
		const evidence = `[{"kind":"email","found":true,"value":{"email":"reach@example.test"},"source":"Example registry","expired":false,"flag_id":"${uuid(81)}","expires_on":"2099-01-01","observed_at":"2026-03-04T05:06:07.123456+00:00","proposes_correction":false},{"kind":"verified","found":true,"value":{"note":"Example","found":true},"source":"Example site","expired":false,"flag_id":"${uuid(82)}","expires_on":null,"observed_at":"2026-03-01T00:00:00+00:00","proposes_correction":false},{"kind":"office_phone","found":true,"value":{"phone":"(555) 010-0000"},"source":"Example registry","expired":true,"flag_id":"${uuid(83)}","expires_on":"2020-01-01","observed_at":"2026-02-01T00:00:00+00:00","proposes_correction":false}]`;
		assert.equal(
			JSON.stringify(await labels(tx)),
			`[{"schema_version":"lead-reachability.v2","classification":"research","basis":"successful_contact_and_current_route","evidence_state":"current","contact_eligible":true,"research_state":"verified","missing_reasons":["recent_successful_contact_not_established"],"source_revision":"sha256:787a16ceaa8a32ce92a03a1cdec6a96386d26c1f01115b2a9021cd0324185abe","evidence":${evidence},"successful_contact":null,"usable_route":{"flag_id":"${uuid(81)}","kind":"email"},"contact_freshness_days":90,"source_inputs":{"cell":null,"email":"reach@example.test","phone":"(555) 010-0000","party_id":"${uuid(1)}","activities":[],"created_at":"2026-01-05T09:30:00.12+00:00"}}]`,
		);
	}));

test("a successful contact is the newest connected or bound mail in the last 90 days", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await activityKinds(tx);
		await party(tx, 2, "Example Contact");
		await lead(tx, 72, 2);
		const mail = { match: "exact", party_id: uuid(2), evidence_ref: "m-1" };
		await activity(tx, 91, 72, "1 day", {
			kind: "email_in",
			source: "mail_ingest",
			detail: JSON.stringify({ ...mail, automated: true }),
		});
		await activity(tx, 92, 72, "2 days", {
			detail: JSON.stringify({ party_id: uuid(3) }),
		});
		await activity(tx, 94, 72, "3 days", { detail: "Free text" });
		await activity(tx, 93, 72, "3 days");
		await activity(tx, 95, 72, "91 days");
		await activity(tx, 96, 72, "-1 day");
		const [label] = await labels(tx);
		assert.deepEqual(
			label?.source_inputs.activities.map((a) => a.id),
			[91, 92, 93, 94].map(uuid),
		);
		assert.equal(label?.successful_contact?.activity_id, uuid(93));
		await activity(tx, 97, 72, "1 hour", {
			kind: "email_in",
			source: "local_mail",
			detail: JSON.stringify({ ...mail, automated: false }),
		});
		const [bound] = await labels(tx);
		assert.equal(bound?.successful_contact?.activity_id, uuid(97));
	}));

test("conflicting, expired and restricted leads stay in research", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await party(tx, 1, "Example A");
		await party(tx, 2, "Example B");
		await party(tx, 3, "Example C", { contact_state: "paused" });
		await lead(tx, 73, 1, { score: 30 });
		await lead(tx, 74, 2, { score: 20 });
		await lead(tx, 75, 3, { score: 10 });
		await finding(
			tx,
			84,
			["party", 1],
			"discrepancy",
			{ note: "Example" },
			"2026-03-01 00:00:00+00",
		);
		await finding(
			tx,
			85,
			["party", 2],
			"verified",
			{},
			"2026-03-01 00:00:00+00",
			"2020-01-01",
		);
		assert.deepEqual(
			(await labels(tx)).map((l) => [
				l.evidence_state,
				l.research_state,
				l.missing_reasons,
			]),
			[
				[
					"conflicting",
					"needs_review",
					[
						"conflicting_evidence",
						"verified_usable_route_not_established",
						"recent_successful_contact_not_established",
					],
				],
				[
					"expired",
					"needs_research",
					[
						"expired_evidence",
						"verified_usable_route_not_established",
						"recent_successful_contact_not_established",
					],
				],
				[
					"unknown",
					"needs_research",
					[
						"contact_restricted",
						"verified_usable_route_not_established",
						"recent_successful_contact_not_established",
					],
				],
			],
		);
	}));

test("the first lead past 500 findings or 500 activities refuses the board", () =>
	withRollback(async (tx) => {
		await seed(tx);
		await activityKinds(tx);
		await party(tx, 1, "Example First");
		await party(tx, 2, "Example Second");
		await lead(tx, 76, 1, { score: 90 });
		await lead(tx, 77, 2, { score: 10 });
		const many = (subject: number, kind: string, count: number) =>
			sql`insert into record_flag (subject_type, subject_id, kind, value, source, created_by)
				select 'party', ${uuid(subject)}::uuid, ${kind}, '{}', 'Example', actor
				from fixture, generate_series(1, ${count})`.execute(tx);
		const calls = (count: number) =>
			sql`insert into activity (occurred_at, actor_id, kind, summary, lead_id)
				select now() - interval '1 hour', actor, 'call', 'Example', ${uuid(76)}::uuid
				from fixture, generate_series(1, ${count})`.execute(tx);
		await many(1, "note", 500);
		await calls(500);
		assert.equal((await board(tx)).leads.length, 2);
		await many(2, "note", 501);
		assert.deepEqual(await readLeadBoard(tx), {
			error: "research_evidence_limit_exceeded",
		});
		await calls(1);
		assert.deepEqual(await readLeadBoard(tx), {
			error: "contact_evidence_limit_exceeded",
		});
	}));
