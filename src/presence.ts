import { Hono } from "hono";
import { sql } from "kysely";
import { hasToolCallMarkup } from "./activity/read.ts";
import { checkFields, isoMillis, Refusal, refuse } from "./answer.ts";
import type { JsonObject } from "./database.d.ts";
import { resolveSubject } from "./deals/resolve.ts";
import {
	answerSave,
	SaveRefusal,
	type Saving,
	type WriterEnv,
} from "./save.ts";

const FIELDS = ["idempotency_key", "deal", "field"];

const isArguments = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const presence = new Hono<WriterEnv>();

// The old door's checks in its order: unknown fields, markup, then the
// required fields. The save checks the key, the deal and the field.
presence.post("/presence", async (c) => {
	const args: unknown = await c.req.json().catch(() => undefined);
	if (!isArguments(args)) return c.json({ error: "invalid_json" }, 400);
	const refused = checkFields(
		new URLSearchParams(Object.keys(args).map((key) => [key, ""])),
		FIELDS,
	);
	if (refused) return refuse(c, refused);
	const marked = FIELDS.find((field) => {
		const value = args[field];
		return typeof value === "string" && hasToolCallMarkup(field, value);
	});
	if (marked)
		return refuse(
			c,
			new Refusal(400, "tool_call_markup_in_value", { fields: [marked] }),
		);
	const missing = FIELDS.filter((field) => {
		const value = args[field];
		return value === undefined || value === null || value === "";
	});
	if (missing.length > 0)
		return refuse(c, new Refusal(400, "missing_required", { fields: missing }));
	return answerSave(c, "presence-lease", args, (saving) => lease(saving, args));
});

// Expiry is only ever compared at read time, and the ping writes no history.
async function lease({ tx, actor_id }: Saving, { deal, field }: JsonObject) {
	const subject = await resolveSubject(tx, String(deal));
	if ("error" in subject)
		throw new SaveRefusal(
			subject.error === "needs_disambiguation"
				? new Refusal(409, "needs_disambiguation", {
						candidates: subject.candidates,
					})
				: // Not one of the old system's public errors, so it answered generically.
					new Refusal(404, "unhandled_verb_failure"),
		);
	if (subject.type !== "deal")
		throw new SaveRefusal(new Refusal(422, "not_a_deal"));
	if (typeof field !== "string" || !field.trim())
		throw new SaveRefusal(new Refusal(400, "field_required"));
	const { expires_at } = await tx
		.insertInto("deal_presence_lease")
		.values({
			actor_id,
			deal_id: subject.id,
			field,
			expires_at: sql<string>`now() + interval '3 seconds'`,
		})
		.onConflict((conflict) =>
			conflict
				.columns(["actor_id", "deal_id", "field"])
				.doUpdateSet((eb) => ({ expires_at: eb.ref("excluded.expires_at") })),
		)
		.returning(isoMillis(sql.ref("expires_at")).as("expires_at"))
		.executeTakeFirstOrThrow();
	return { ok: true, deal_id: subject.id, field, expires_at };
}
