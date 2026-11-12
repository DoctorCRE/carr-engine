import { Hono } from "hono";
import { sql } from "kysely";
import { isoMillis, Refusal } from "./answer.ts";
import type { JsonObject } from "./database.d.ts";
import { lookupRefusal, resolveDeal } from "./deals/resolve.ts";
import {
	answerSave,
	SaveRefusal,
	type Saving,
	type WriterEnv,
} from "./save.ts";

export const presence = new Hono<WriterEnv>();

presence.post("/presence", (c) =>
	answerSave(
		c,
		{
			verb: "presence-lease",
			fields: { idempotency_key: {}, deal: {}, field: {} },
			required: ["idempotency_key", "deal", "field"],
		},
		lease,
	),
);

// Expiry is only ever compared at read time, and the ping writes no history.
async function lease({ tx, actor_id }: Saving, { deal, field }: JsonObject) {
	const subject = await resolveDeal(tx, String(deal));
	if ("error" in subject) throw new SaveRefusal(lookupRefusal(subject));
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
	return {
		ok: true,
		deal_id: subject.id,
		field,
		expires_at: new Date(expires_at),
	};
}
