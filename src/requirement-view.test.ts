import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "kysely";
import { withRollback } from "./test-rollback.ts";

test("requests read through two views by a login without ops access", () =>
	withRollback(async (tx) => {
		const actor = await tx
			.insertInto("actor")
			.values({
				slug: "checklist-agent",
				kind: "human",
				display_name: "Example Agent",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const audit = { created_by: actor.id, updated_by: actor.id };
		await tx
			.insertInto("contact_state")
			.values({
				slug: "checklist-active",
				label: "Example active",
				contactable: true,
				sort: 1,
			})
			.execute();
		const party = await tx
			.insertInto("party")
			.values({
				kind: "org",
				name: "Example Clinic",
				contact_state: "checklist-active",
				...audit,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const client = await tx
			.insertInto("client")
			.values({ party_id: party.id, ...audit })
			.returning("id")
			.executeTakeFirstOrThrow();
		await tx
			.insertInto("deal_type_ref")
			.values({ slug: "checklist-lease", label: "Example lease", sort: 1 })
			.execute();
		await tx
			.insertInto("deal_phase")
			.values({ slug: "checklist-open", label: "Example open" })
			.execute();
		const deal = await tx
			.insertInto("deal")
			.values({
				client_id: client.id,
				name: "Example Deal",
				deal_type: "checklist-lease",
				phase: "checklist-open",
				...audit,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		const evidence = async (filename: string, deleted: boolean) =>
			(
				await tx
					.insertInto("attachment")
					.values({
						subject_type: "deal",
						subject_id: deal.id,
						r2_key: `example/${filename}`,
						filename,
						mime: "application/pdf",
						sha256: "b".repeat(64),
						bytes: 10,
						deleted_at: deleted ? sql<string>`now()` : null,
						created_by: actor.id,
					})
					.returning("id")
					.executeTakeFirstOrThrow()
			).id;
		const request = async (rowKey: string, evidenceId: string | null) =>
			(
				await sql<{ id: string }>`insert into ops.requirement_request
						(organization_tenant_id, deal_id, row_key, owner, due_on, document_type,
						source, created_by, fulfilled_at, fulfilled_by, evidence_attachment_id)
						values ('example-tenant', ${deal.id}, ${rowKey}, 'Example Owner',
						'2026-01-15', 'Example document', '{}', ${actor.id},
						${evidenceId && sql`now()`}, ${evidenceId && actor.id}, ${evidenceId})
						returning id`.execute(tx)
			).rows[0]?.id;
		await request("a_open", null);
		const uploaded = await request("b_uploaded", null);
		await request("c_received", await evidence("example-received.pdf", false));
		await request("d_removed", await evidence("example-removed.pdf", true));
		const receipt = (
			await sql<{ id: string }>`with upload_grant as (
						insert into ops.requirement_upload_grant
						(request_id, organization_tenant_id, deal_id, row_key, token_sha256, expires_at)
						values (${uploaded}, 'example-tenant', ${deal.id}, 'b_uploaded',
						${"c".repeat(64)}, now() + interval '1 hour') returning id)
					insert into ops.requirement_upload_receipt
					(grant_id, request_id, r2_key, sha256, bytes, mime, received_at)
					select id, ${uploaded}, 'example/upload.pdf', ${"d".repeat(64)}, 2048,
					'application/pdf', '2026-01-10T15:30:00Z' from upload_grant
					returning id`.execute(tx)
		).rows[0]?.id;
		await sql`insert into ops.client_portal (slug, client_id, deal_id, password_hash)
					values ('example-portal', ${client.id}, ${deal.id}, ${`$2b$12$${"a".repeat(53)}`})`.execute(
			tx,
		);

		const login = `checklist_reader_${randomUUID().replaceAll("-", "")}`;
		await sql`create role ${sql.id(login)} nologin`.execute(tx);
		await sql`grant select on public.v_requirement_request, public.v_deal_client_portal to ${sql.id(login)}`.execute(
			tx,
		);
		assert.equal(
			(
				await sql<{
					usage: boolean;
				}>`select has_schema_privilege(${login}, 'ops', 'USAGE') as usage`.execute(
					tx,
				)
			).rows[0]?.usage,
			false,
		);
		await sql`set local role ${sql.id(login)}`.execute(tx);

		const rows = await tx
			.selectFrom("v_requirement_request")
			.select([
				"row_key",
				"satisfied",
				"status",
				"receipts",
				"evidence_filename",
			])
			.select((eb) => eb("fulfilled_by", "is not", null).as("fulfilled"))
			.where("deal_id", "=", deal.id)
			.orderBy("row_key")
			.execute();
		const open = { satisfied: false, status: "open", fulfilled: false };
		const received = {
			satisfied: false,
			status: "fulfilled",
			receipts: [],
		};
		assert.deepEqual(rows, [
			{
				row_key: "a_open",
				...open,
				receipts: [],
				evidence_filename: null,
			},
			{
				row_key: "b_uploaded",
				...open,
				receipts: [
					{
						id: receipt,
						state: "quarantined",
						received_at: "2026-01-10T15:30:00+00:00",
						sha256: "d".repeat(64),
						bytes: 2048,
						mime: "application/pdf",
					},
				],
				evidence_filename: null,
			},
			{
				row_key: "c_received",
				...received,
				evidence_filename: "example-received.pdf",
				fulfilled: true,
			},
			{
				row_key: "d_removed",
				...received,
				evidence_filename: null,
				fulfilled: true,
			},
		]);
		assert.deepEqual(
			await tx
				.selectFrom("v_deal_client_portal")
				.select("client_portal_url")
				.where("deal_id", "=", deal.id)
				.execute(),
			[{ client_portal_url: "https://share.example.com/example-portal" }],
		);
	}));
