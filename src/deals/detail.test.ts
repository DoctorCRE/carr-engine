import assert from "node:assert/strict";
import { test } from "node:test";
import { sql, type Transaction } from "kysely";
import type { DB } from "../database.d.ts";
import { withRollback } from "../test-rollback.ts";
import { SOURCES } from "./checklist.ts";
import { readDealDetail } from "./detail.ts";

async function seed(tx: Transaction<DB>, deal: { invoiced_on?: string } = {}) {
	const actor = await tx
		.insertInto("actor")
		.values({ slug: "detail-agent", kind: "human", display_name: "Example A" })
		.returning("id")
		.executeTakeFirstOrThrow();
	const audit = { created_by: actor.id, updated_by: actor.id };
	await tx
		.insertInto("contact_state")
		.values({ slug: "active", label: "Example", contactable: true, sort: 1 })
		.onConflict((c) => c.doNothing())
		.execute();
	await tx
		.insertInto("client_status")
		.values({ slug: "detail-active", label: "Example active" })
		.execute();
	await tx
		.insertInto("deal_type_ref")
		.values({ slug: "detail-lease", label: "Example lease", sort: 1 })
		.execute();
	await tx
		.insertInto("deal_phase")
		.values({ slug: "detail-open", label: "Example open" })
		.execute();
	const party = (name: string) =>
		tx
			.insertInto("party")
			.values({ kind: "person", name, ...audit })
			.returning("id")
			.executeTakeFirstOrThrow();
	const client = await tx
		.insertInto("client")
		.values({
			party_id: (await party("Dr. Ada Example (Example Clinic)")).id,
			status: "detail-active",
			roster_ref: "C-9001",
			...audit,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	const row = await tx
		.insertInto("deal")
		.values({
			client_id: client.id,
			name: "Example Detail Deal",
			deal_type: "detail-lease",
			phase: "detail-open",
			city: "Exampleton",
			next_date: "2030-01-15",
			...deal,
			...audit,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	const portal = (slug: string, disabledAt: string | null = null) =>
		sql`insert into ops.client_portal (slug, client_id, deal_id, password_hash, disabled_at)
			values (${slug}, ${client.id}, ${row.id}, ${`$2b$12$${"a".repeat(53)}`}, ${disabledAt})`.execute(
			tx,
		);
	return {
		actor: actor.id,
		audit,
		party,
		portal,
		client: client.id,
		deal: row.id,
	};
}

test("an open deal reads with text dates, decimal strings and capped history", async () => {
	await withRollback(async (tx) => {
		const { actor, audit, party, portal, deal } = await seed(tx);
		await portal("example-detail");
		await tx
			.insertInto("deal_note")
			.values(
				Array.from({ length: 501 }, (_, i) => ({
					actor_id: actor,
					deal_id: deal,
					kind: "note",
					text: `Example note ${i}`,
					created_at: new Date(Date.UTC(2030, 0, 1, 0, 0, i)).toISOString(),
				})),
			)
			.execute();
		await tx
			.insertInto("negotiation_round")
			.values({
				deal_id: deal,
				round_no: 1,
				side: "landlord",
				proposed_on: "2030-02-01",
				rate_amount: "12.50",
				rate_basis: "usd_sf_yr",
				term_months: 60,
				created_by: actor,
			})
			.execute();
		await tx
			.insertInto("next_action")
			.values(
				[
					["Example open item", "open"],
					["Example dropped item", "dropped"],
					[null, "open"],
				].map(([title, status], i) => ({
					subject_type: "deal",
					subject_id: deal,
					owner_id: actor,
					description: `Example action ${i}`,
					item_title: title,
					source_ref: title && "example-source",
					item_bullets: JSON.stringify([]),
					status: String(status),
					due_on: "2030-03-01",
					created_at: `2030-01-0${i + 1}T00:00:00Z`,
					...audit,
				})),
			)
			.execute();
		const event = {
			subject_type: "deal",
			subject_id: deal,
			verb: "example-verb",
			cause: "system",
			actor_id: actor,
			occurred_at: "2030-01-02T03:04:05.678Z",
		};
		await tx
			.insertInto("event")
			.values([
				...Array.from({ length: 499 }, (_, i) => ({
					...event,
					recorded_at: new Date(Date.UTC(2029, 0, 1, 0, 0, i)).toISOString(),
				})),
				{
					...event,
					recorded_at: "2030-02-01T00:00:00Z",
					new_value: {
						kept: { phase: "detail-open", sf_close_date_placeholder: "x" },
					},
				},
			])
			.execute();
		const phaseEvent = await tx
			.insertInto("event")
			.values({
				...event,
				cause: "human_stated",
				field: "phase",
				old_value: { phase: "detail-intake" },
				new_value: { phase: "detail-open" },
				recorded_at: "2030-01-02T03:04:06Z",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const [later, sooner] = await tx
			.insertInto("critical_date")
			.values(
				["2030-06-01", "2030-05-01"].map((due_on) => ({
					deal_id: deal,
					kind: "example-deadline",
					due_on,
					source: "example-source",
					created_by: actor,
				})),
			)
			.returning("id")
			.execute();
		const company = await party("Example Title Co");
		const contact = await party("Example Closer");
		await tx
			.insertInto("vendor_disposition")
			.values({ slug: "detail-ok", label: "Example", workable: true, sort: 1 })
			.execute();
		await tx
			.insertInto("vendor")
			.values({
				party_id: contact.id,
				category: "title",
				disposition: "detail-ok",
				...audit,
			})
			.execute();
		await tx
			.insertInto("deal_vendor_assignment")
			.values({
				deal_id: deal,
				party_id: contact.id,
				role: "title",
				company_party_id: company.id,
				contact_party_id: contact.id,
				updated_by: actor,
			})
			.execute();

		const detail = await readDealDetail(tx, deal, "detail-agent");
		assert.ok("operating_state" in detail);
		assert.equal(detail.schema_version, "deal-timeline.v1");
		assert.equal(detail.deal_id, deal);
		assert.equal(detail.next_date, "2030-01-15");
		assert.match(String(detail.next_step), /^Example action/);
		assert.equal(detail.next_step_required, false);
		assert.equal(detail.workspace_kind, "team");
		assert.equal(detail.short_name, "Dr. Example's Exampleton Deal");
		assert.equal(
			detail.client_portal_url,
			"https://share.example.com/example-detail",
		);
		assert.equal(detail.base_version, 1);
		assert.equal(detail.thread.length, 500);
		assert.equal(detail.thread_truncated, true);
		assert.equal(detail.thread[0]?.text, "Example note 500");
		assert.equal(detail.thread[0]?.created_at, "2030-01-01T00:08:20+00:00");
		assert.deepEqual(
			detail.negotiation_rounds.map((r) => [r.rate_amount, r.term_months]),
			[["12.50", 60]],
		);
		assert.deepEqual(
			detail.next_actions.map((a) => a.status),
			["open", "dropped", "open"],
		);
		assert.deepEqual(
			detail.items.map((i) => [i.title, i.due_on]),
			[["Example open item", "2030-03-01"]],
		);
		assert.equal(detail.events.length, 500);
		assert.equal(detail.events_truncated, true);
		assert.equal(detail.events[0]?.recorded_at, "2030-02-01T00:00:00+00:00");
		assert.deepEqual(detail.events[0]?.new_value, {
			kept: { phase: "detail-open" },
		});
		assert.deepEqual(
			detail.critical_dates,
			[
				[sooner?.id, "2030-05-01"],
				[later?.id, "2030-06-01"],
			].map(([id, due_on]) => ({
				id,
				kind: "example-deadline",
				due_on,
				note: null,
				source: "example-source",
				status: "open",
			})),
		);
		assert.deepEqual(detail.phase_started_on, { "detail-open": "2030-01-01" });
		assert.deepEqual(detail.phase_change, {
			deal_id: deal,
			event_id: phaseEvent.id,
			prior_phase: "detail-intake",
			phase: "detail-open",
			automatic: false,
			reason: "phase changed",
			evidence_date: "2030-01-02T03:04:05.678+00:00",
			recorded_at: "2030-01-02T03:04:06+00:00",
		});
		assert.deepEqual(
			detail.vendors.map((v) => [v.role, v.company, v.contact]),
			[
				[
					"title",
					{ id: company.id, name: "Example Title Co" },
					{ id: contact.id, name: "Example Closer", email: null, phone: null },
				],
			],
		);
		assert.deepEqual(detail.lease, null);
	});
});

test("email threads keep the newest message per conversation", async () => {
	await withRollback(async (tx) => {
		const { actor, deal } = await seed(tx);
		await tx
			.insertInto("activity_kind")
			.values(
				["email_in", "email_out"].map((slug) => ({
					slug,
					label: slug,
					is_contact: true,
				})),
			)
			.onConflict((c) => c.doNothing())
			.execute();
		await tx
			.insertInto("activity")
			.values(
				[
					["email_in", "t-1", "Old", "2030-01-01T00:00:00Z"],
					["email_out", "t-1", "New", "2030-01-03T00:00:00Z"],
					["email_in", "", "Loose one", "2030-01-02T00:00:00Z"],
					["email_in", undefined, "Loose two", "2030-01-02T12:00:00Z"],
					["email_in", null, "Loose three", "2030-01-02T18:00:00Z"],
				].map(([kind, thread, subject, at]) => ({
					kind: String(kind),
					summary: "Example email",
					occurred_at: String(at),
					actor_id: actor,
					deal_id: deal,
					email_context:
						thread === undefined
							? { subject }
							: { conversation_id: thread, subject },
				})),
			)
			.execute();
		const detail = await readDealDetail(tx, deal, "detail-agent");
		assert.ok(!("error" in detail));
		assert.deepEqual(
			detail.email_threads.map((t) => [t.conversation_id, t.subject]),
			[
				["t-1", "New"],
				[null, "Loose three"],
				[null, "Loose two"],
				[null, "Loose one"],
			],
		);
		assert.equal(detail.activities.length, 5);
		assert.equal(
			detail.email_threads[0]?.latest_message_at,
			"2030-01-03T00:00:00+00:00",
		);
	});
});

test("people, premises, rounds, documents, lease and activity read like the old panel", async () => {
	await withRollback(async (tx) => {
		const { actor, audit, party, client, deal } = await seed(tx);
		await tx
			.insertInto("participant_role")
			.values(["a", "b"].map((slug) => ({ slug, label: `Example ${slug}` })))
			.execute();
		const person = await party("Example Participant");
		const ended = await party("Example Ended");
		await tx
			.insertInto("deal_participant")
			.values([
				{ deal_id: deal, role: "b", actor_id: actor, set_by: actor },
				{ deal_id: deal, role: "a", party_id: person.id, set_by: actor },
				{
					deal_id: deal,
					role: "a",
					party_id: ended.id,
					set_by: actor,
					to_at: "2030-01-01T00:00:00Z",
				},
			])
			.execute();
		const building = await tx
			.insertInto("building")
			.values({
				name: "Example Tower",
				address: "1 Example Way",
				city: "Exampleton",
				state: "EX",
				...audit,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const [space, annexSpace] = await tx
			.insertInto("space")
			.values(
				[
					["100", "1200.5"],
					["050", "75"],
				].map(([suite, area_amount]) => ({
					building_id: building.id,
					suite,
					area_amount,
					area_basis: "rentable",
					...audit,
				})),
			)
			.returning("id")
			.execute();
		const [annex, suite] = await tx
			.insertInto("premises")
			.values(
				[
					["Example Annex", "2030-02-01T00:00:00Z"],
					["Example Suite", "2030-01-01T00:00:00Z"],
				].map(([label, created_at]) => ({
					deal_id: deal,
					label: String(label),
					created_at: String(created_at),
					created_by: actor,
				})),
			)
			.returning("id")
			.execute();
		assert.ok(annex && suite && space && annexSpace);
		await tx
			.insertInto("premises_space")
			.values([
				{ premises_id: suite.id, space_id: space.id },
				{ premises_id: annex.id, space_id: annexSpace.id },
			])
			.execute();
		await tx
			.insertInto("negotiation_round")
			.values(
				Array.from({ length: 7 }, (_, i) => ({
					deal_id: deal,
					round_no: i + 1,
					side: "tenant",
					proposed_on: `2030-01-0${7 - i}`,
					rate_amount: "2.04",
					rate_basis: "usd_sf_mo",
					ti_amount: "40",
					ti_basis: "usd_sf",
					free_rent_months: "2.5",
					created_by: actor,
				})),
			)
			.execute();
		const template = await tx
			.insertInto("doc_template")
			.values({
				slug: "detail-template",
				name: "Example template",
				source_path: "example/template",
				template_version: "1",
				field_map: JSON.stringify({}),
				created_by: actor,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		await tx
			.insertInto("document")
			.values(
				Array.from({ length: 21 }, (_, i) => ({
					deal_id: deal,
					template_id: template.id,
					prepared_by: actor,
					prepared_at: new Date(Date.UTC(2030, 0, 1, 0, i)).toISOString(),
					lint_passed: i % 2 === 0,
					leak_check_passed: false,
				})),
			)
			.execute();
		const lease = {
			deal_id: deal,
			client_id: client,
			owner_id: actor,
			executed_on: "2029-12-01",
			commencement_on: "2030-01-01",
			expiration_on: "2035-12-31",
			evidence_kind: "executed_lease",
			evidence_ref: "example-ref",
			source: "example-source",
			options_note: "Example option",
			created_by: actor,
		};
		const current = await tx
			.insertInto("lease")
			.values([
				{ ...lease, status: "superseded", expiration_on: "2031-12-31" },
				{ ...lease, status: "current" },
			])
			.returning(["id", "status"])
			.execute();
		await tx
			.insertInto("activity_kind")
			.values({ slug: "detail-call", label: "Example", is_contact: true })
			.execute();
		await tx
			.insertInto("activity")
			.values(
				Array.from({ length: 501 }, (_, i) => ({
					deal_id: deal,
					actor_id: actor,
					kind: "detail-call",
					summary: `Example call ${i}`,
					detail: "Example detail",
					occurred_at: new Date(Date.UTC(2030, 0, 1, 0, 0, i)).toISOString(),
					email_context: { conversation_id: "t-9", extra: { n: i } },
				})),
			)
			.execute();

		const detail = await readDealDetail(tx, deal, "detail-agent");
		assert.ok(!("error" in detail));
		assert.deepEqual(detail.participants, [
			{
				role: "a",
				name: "Example Participant",
				actor: null,
				party_id: person.id,
			},
			{ role: "b", name: "Example A", actor: "detail-agent", party_id: null },
		]);
		const tower = {
			building_name: "Example Tower",
			address: "1 Example Way",
			city: "Exampleton",
			state: "EX",
			area_basis: "rentable",
		};
		assert.deepEqual(detail.premises, [
			{
				id: suite.id,
				label: "Example Suite",
				...tower,
				suite: "100",
				area_amount: "1200.5",
			},
			{
				id: annex.id,
				label: "Example Annex",
				...tower,
				suite: "050",
				area_amount: "75.0",
			},
		]);
		assert.deepEqual(
			detail.negotiation_rounds.map((r) => r.round_no),
			[7, 6, 5, 4, 3, 2],
		);
		assert.deepEqual(
			[detail.negotiation_rounds[0]].map((r) => [
				r?.rate_norm_sf_yr,
				r?.ti_amount,
				r?.free_rent_months,
				r?.proposed_on,
			]),
			[["24.48", "40.00", "2.5", "2030-01-01"]],
		);
		assert.equal(detail.documents.length, 20);
		assert.deepEqual(detail.documents[0], {
			id: detail.documents[0]?.id,
			sent_status: "draft",
			lint_passed: true,
			leak_check_passed: false,
			prepared_at: "2030-01-01T00:20:00+00:00",
			note: null,
		});
		assert.equal(
			detail.documents[19]?.prepared_at,
			"2030-01-01T00:01:00+00:00",
		);
		assert.equal(detail.documents[19]?.lint_passed, false);
		assert.deepEqual(detail.lease, {
			id: current.find((l) => l.status === "current")?.id,
			version: 1,
			status: "current",
			executed_on: "2029-12-01",
			commencement_on: "2030-01-01",
			expiration_on: "2035-12-31",
			options_note: "Example option",
			evidence_kind: "executed_lease",
			evidence_ref: "example-ref",
			source: "example-source",
		});
		assert.equal(detail.activities.length, 500);
		assert.equal(detail.activities_truncated, true);
		assert.deepEqual(detail.activities[0], {
			id: detail.activities[0]?.id,
			occurred_at: "2030-01-01T00:08:20+00:00",
			actor: "detail-agent",
			kind: "detail-call",
			summary: "Example call 500",
			detail: "Example detail",
			source: "stated",
			email_context: { conversation_id: "t-9", extra: { n: 500 } },
		});
	});
});

test("activities and documents sort by time across a clock change", async () => {
	await withRollback(async (tx) => {
		const { actor, deal } = await seed(tx);
		await sql`set local time zone 'America/Chicago'`.execute(tx);
		const earlier = "2030-11-03T06:30:00Z";
		const later = "2030-11-03T07:10:00Z";
		await tx
			.insertInto("activity_kind")
			.values({ slug: "detail-call", label: "Example", is_contact: true })
			.execute();
		await tx
			.insertInto("activity")
			.values(
				[earlier, later].map((occurred_at) => ({
					deal_id: deal,
					actor_id: actor,
					kind: "detail-call",
					summary: "Example call",
					occurred_at,
				})),
			)
			.execute();
		const template = await tx
			.insertInto("doc_template")
			.values({
				slug: "detail-template",
				name: "Example template",
				source_path: "example/template",
				template_version: "1",
				field_map: JSON.stringify({}),
				created_by: actor,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		await tx
			.insertInto("document")
			.values(
				[earlier, later].map((prepared_at) => ({
					deal_id: deal,
					template_id: template.id,
					prepared_by: actor,
					prepared_at,
				})),
			)
			.execute();
		const detail = await readDealDetail(tx, deal, "detail-agent");
		assert.ok(!("error" in detail));
		const newestFirst = [
			"2030-11-03T01:10:00-06:00",
			"2030-11-03T01:30:00-05:00",
		];
		assert.deepEqual(
			detail.activities.map((a) => a.occurred_at),
			newestFirst,
		);
		assert.deepEqual(
			detail.documents.map((d) => d.prepared_at),
			newestFirst,
		);
	});
});

test("an invoiced deal reads through the archived shape", async () => {
	await withRollback(async (tx) => {
		const { deal, client, portal } = await seed(tx, {
			invoiced_on: "2030-04-30",
		});
		await portal("example-disabled", "2030-05-01T00:00:00Z");
		const detail = await readDealDetail(tx, deal, "detail-agent");
		assert.ok(!("error" in detail));
		assert.equal(detail.invoiced_on, "2030-04-30");
		assert.equal(detail.client_id, client);
		assert.equal(detail.workspace_kind, "team");
		assert.equal(detail.short_name, "Example Detail Deal");
		assert.equal(detail.client_portal_url, null);
		assert.equal("next_step" in detail, false);
		assert.equal("phase_change" in detail, false);
		assert.deepEqual(detail.vendors, []);
	});
});

test("the checklist reads its sources, commissions and requests", async () => {
	await withRollback(async (tx) => {
		const { actor, deal } = await seed(tx, { invoiced_on: "2030-04-30" });
		const document = await tx
			.insertInto("doctrine_document")
			.values({ slug: "example-kit", title: "Example", content_class: "sop" })
			.returning("id")
			.executeTakeFirstOrThrow();
		await tx
			.insertInto("doctrine_section")
			.values(
				SOURCES.map((s) => ({
					id: s.section_id,
					document_id: document.id,
					section_key: s.section_id,
					body_hash: s.content_hash,
				})),
			)
			.execute();
		const commission = await tx
			.insertInto("commission")
			.values({
				deal_id: deal,
				gross_amount: "100.00",
				status: "received",
				received_on: "2030-05-02",
				created_by: actor,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const attachment = await tx
			.insertInto("attachment")
			.values({
				subject_type: "deal",
				subject_id: deal,
				r2_key: "example/agreement.pdf",
				filename: "example-agreement.pdf",
				mime: "application/pdf",
				sha256: "b".repeat(64),
				bytes: 10,
				created_by: actor,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		await sql`insert into ops.requirement_request
				(organization_tenant_id, deal_id, row_key, owner, due_on, document_type,
				source, created_by, fulfilled_at, fulfilled_by, evidence_attachment_id)
				values ('example-tenant', ${deal}, 'representation', 'Example Owner',
				'2030-04-01', 'representation', '{}', ${actor},
				'2030-04-02T03:04:05.678901Z', ${actor}, ${attachment.id})`.execute(tx);

		const detail = await readDealDetail(tx, deal, "detail-agent");
		assert.ok(!("error" in detail));
		const { checklist } = detail;
		const today = await sql<{
			today: string;
		}>`select to_jsonb(carr_business_date())#>>'{}' as today`.execute(tx);
		assert.equal(checklist.observed_on, today.rows[0]?.today);
		assert.equal(checklist.template_state, "deal_type_unknown");
		const items = checklist.phases.flatMap((p) => p.items);
		const item = (id: string) => items.find((i) => i.id === id);
		assert.equal(
			item("commission_received")?.evidence_ref,
			`commission:${commission.id}`,
		);
		assert.equal(
			item("invoice_recorded")?.evidence_ref,
			`deal:${deal}:invoiced_on:2030-04-30`,
		);
		assert.deepEqual(item("representation"), {
			id: "representation",
			label: "Signed representation agreement",
			status: "received",
			due_on: "2030-04-01",
			evidence_ref: "example-agreement.pdf",
			owner: "Example Owner",
			document_type: "representation",
			source: SOURCES[0],
			request: {
				id: item("representation")?.request?.id,
				row_key: "representation",
				owner: "Example Owner",
				due_on: "2030-04-01",
				document_type: "representation",
				satisfied: false,
				receipts: [],
				status: "fulfilled",
				fulfilled_at: "2030-04-02T03:04:05.678Z",
				fulfilled_by: actor,
				evidence_attachment_id: attachment.id,
				evidence_filename: "example-agreement.pdf",
			},
		});
	});
});

test("refusals name what went wrong", async () => {
	await withRollback(async (tx) => {
		const { deal, client, audit, party } = await seed(tx);
		assert.deepEqual(await readDealDetail(tx, deal, "nobody"), {
			error: "unauthenticated",
		});
		assert.deepEqual(await readDealDetail(tx, "C-9001", "detail-agent"), {
			error: "not_a_deal",
			resolved: { type: "client", id: client },
		});
		const byName = await readDealDetail(tx, "Example Detail", "detail-agent");
		assert.ok(!("error" in byName));
		assert.equal(byName.deal_id, deal);
		assert.deepEqual(
			await readDealDetail(tx, "No Such Example", "detail-agent"),
			{
				error: "subject_not_found",
				ref: "No Such Example",
				hint: "use find first; refs look like L-204 / C-127 / V-CPA-006 / P-0948 or a deal name",
			},
		);
		await tx
			.insertInto("deal")
			.values({
				client_id: client,
				name: "Example Detail Deal Two",
				deal_type: "detail-lease",
				phase: "detail-open",
				...audit,
			})
			.execute();
		const twice = await readDealDetail(tx, "Example Detail", "detail-agent");
		assert.ok("candidates" in twice);
		assert.deepEqual(
			{ ...twice, candidates: twice.candidates.map((c) => c.name).sort() },
			{
				error: "needs_disambiguation",
				ref: "Example Detail",
				candidates: ["Example Detail Deal", "Example Detail Deal Two"],
				hint: "pass the exact ref or full name",
			},
		);
		assert.deepEqual(
			twice.candidates.find((c) => c.name === "Example Detail Deal"),
			{
				name: "Example Detail Deal",
				phase: "detail-open",
				client_ref: "C-9001",
			},
		);
		const survivor = await tx
			.insertInto("client")
			.values({ party_id: (await party("Example Survivor")).id, ...audit })
			.returning("id")
			.executeTakeFirstOrThrow();
		await tx
			.updateTable("client")
			.set({ merged_into: survivor.id })
			.where("id", "=", client)
			.execute();
		assert.deepEqual(await readDealDetail(tx, deal, "detail-agent"), {
			error: "not_found",
			table: "deal",
			id: deal,
		});
	});
});

test("each lookup step resolves or refuses like the old resolver", async () => {
	await withRollback(async (tx) => {
		const { audit, client, deal } = await seed(tx);
		const party = (name: string, extra: { ref?: string; city?: string } = {}) =>
			tx
				.insertInto("party")
				.values({ kind: "person", name, ...extra, ...audit })
				.returning("id")
				.executeTakeFirstOrThrow();
		await tx
			.insertInto("lead_stage")
			.values({ slug: "detail-new", label: "Example new" })
			.execute();
		const leadParty = await party("Example Zed", { city: "Exampleton" });
		const lead = await tx
			.insertInto("lead")
			.values({
				party_id: leadParty.id,
				stage: "detail-new",
				registry_ref: "L-9001",
				...audit,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		await tx
			.insertInto("vendor_disposition")
			.values({ slug: "detail-ok", label: "Example", workable: true, sort: 1 })
			.execute();
		const vendor = async (name: string, vendor_ref: string) =>
			tx
				.insertInto("vendor")
				.values({
					party_id: (await party(name)).id,
					category: "title",
					disposition: "detail-ok",
					vendor_ref,
					...audit,
				})
				.returning("id")
				.executeTakeFirstOrThrow();
		const zedVendor = await vendor("Example Zed Supply", "V-EX-001");
		const teeVendor = await vendor("Example Tee Vendor", "T-EX-002");
		await tx
			.insertInto("client")
			.values({
				party_id: (await party("Example Zed Gone")).id,
				status: "detail-active",
				...audit,
			})
			.execute();
		await tx
			.updateTable("party")
			.set({ merged_into: leadParty.id })
			.where("name", "=", "Example Zed Gone")
			.execute();
		const bare = await party("Example Bare", { ref: "P-9001" });
		await party("Example Bare Annex");
		await tx
			.insertInto("deal")
			.values({
				id: lead.id,
				client_id: client,
				name: "Example Shared Id Deal",
				deal_type: "detail-lease",
				phase: "detail-open",
				...audit,
			})
			.execute();
		const notADeal = (type: string, id: string) => ({
			error: "not_a_deal",
			resolved: { type, id },
		});
		const pickOne = "pass the exact ref or full name";
		const cases: [string, unknown][] = [
			["L-9001", notADeal("lead", lead.id)],
			["V-EX-001", notADeal("vendor", zedVendor.id)],
			["T-EX-002", notADeal("vendor", teeVendor.id)],
			["P-9001", notADeal("party", bare.id)],
			[client, notADeal("client", client)],
			[
				"Example Zed",
				{
					error: "needs_disambiguation",
					ref: "Example Zed",
					candidates: [
						{
							name: "Example Zed",
							ref: "L-9001",
							kind: "lead",
							city: "Exampleton",
						},
						{
							name: "Example Zed Supply",
							ref: "V-EX-001",
							kind: "vendor",
							city: null,
						},
					],
					hint: pickOne,
				},
			],
			[
				"Example Bare",
				{
					error: "needs_disambiguation",
					ref: "Example Bare",
					candidates: [
						{ name: "Example Bare", ref: "P-9001", kind: "party", city: null },
						{
							name: "Example Bare Annex",
							ref: null,
							kind: "party",
							city: null,
						},
					],
					hint: "more than one party carries this name — often duplicate org rows for one company; pass the exact P-ref",
				},
			],
		];
		for (const [ref, expected] of cases)
			assert.deepEqual(
				await readDealDetail(tx, ref, "detail-agent"),
				expected,
				ref,
			);
		const shared = await readDealDetail(tx, lead.id, "detail-agent");
		assert.ok(!("error" in shared));
		assert.equal(shared.name, "Example Shared Id Deal");
		const byName = await readDealDetail(tx, "Example Detail", "detail-agent");
		assert.ok(!("error" in byName));
		assert.equal(byName.deal_id, deal);
	});
});
