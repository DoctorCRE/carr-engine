import { Hono } from "hono";
import { sql } from "kysely";
import { answer } from "./answer.ts";
import { asText, type DatabaseEnv, type Reader } from "./reader.ts";

export async function readInvoiceTracker(db: Reader, partner: string) {
	const entries = await db
		.selectFrom("v_invoice_tracker")
		.select((q) => [
			"deal_id",
			"name",
			"owner",
			"phase",
			"lane",
			"outcome",
			asText(q.ref("closed_on")).as("closed_on"),
			asText(q.ref("deal_invoiced_on")).as("invoiced_on"),
			"commission_id",
			"gross_amount",
			"status",
			"base_version",
			asText(q.ref("commission_invoiced_on")).as("commission_invoiced_on"),
			asText(q.ref("received_on")).as("received_on"),
			asText(q.ref("due_on")).as("due_on"),
			asText(sql`current_date`).as("as_of"),
		])
		// No deal tie-break, as in the old read: same-name deals without a
		// commission come back in whatever order the plan gives.
		.orderBy("name")
		.orderBy("commission_invoiced_on", (o) => o.asc().nullsLast())
		.orderBy("commission_id")
		.execute();
	return {
		schema_version: "invoice-tracker.v1",
		actor: partner,
		entries,
		observed_at: new Date().toISOString(),
	};
}

export const invoices = new Hono<DatabaseEnv>();

invoices.get("/invoices", (c) =>
	answer(c, (db) => readInvoiceTracker(db, c.get("partner").slug)),
);
