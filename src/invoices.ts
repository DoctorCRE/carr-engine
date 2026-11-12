import { Hono } from "hono";
import { sql } from "kysely";
import { answer, checkFields, refuse } from "./answer.ts";
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
		.orderBy("name")
		.orderBy("commission_invoiced_on", (o) => o.asc().nullsLast())
		.orderBy("commission_id")
		.orderBy("deal_id")
		.execute();
	return {
		schema_version: "invoice-tracker.v1",
		actor: partner,
		entries,
		observed_at: new Date().toISOString(),
	};
}

export const invoices = new Hono<DatabaseEnv>();

invoices.get("/invoices", async (c) => {
	const refused = checkFields(new URL(c.req.url).searchParams, []);
	return refused
		? refuse(c, refused)
		: answer(c, "read-invoice-tracker", (db) =>
				readInvoiceTracker(db, c.get("partner").slug),
			);
});
