import { Hono } from "hono";
import { answer, Refusal, refuse } from "../answer.ts";
import type { DatabaseEnv } from "../reader.ts";
import { readLeadBoard } from "./board.ts";

// The old input also took `lead_id` to open one lead, which the engine does
// not serve yet.
const FIELDS = new Set([
	"workspace",
	"correspondence_cursor",
	"stage_history_cursor",
]);
// The old system echoed back only identifier-shaped field names, at most 20.
const ECHOED_FIELD = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export const leads = new Hono<DatabaseEnv>();

leads.get("/leads", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const workspace = params.get("workspace");
	if (workspace !== null && workspace !== "leads")
		return refuse(
			c,
			new Refusal(400, "value_not_in_declared_vocabulary", {
				allowed_values: ["leads"],
				fields: ["workspace"],
			}),
		);
	const extra = [...new Set(params.keys())].filter((key) => !FIELDS.has(key));
	if (extra.length > 0)
		return refuse(
			c,
			new Refusal(400, "unregistered_operation_fields", {
				fields: extra
					.sort()
					.filter((key) => ECHOED_FIELD.test(key))
					.slice(0, 20),
			}),
		);
	// The old read refused any history cursor sent without a lead, and its
	// error was not public, so it answered generically.
	if (params.has("correspondence_cursor") || params.has("stage_history_cursor"))
		return refuse(c, new Refusal(400, "unhandled_verb_failure"));
	return answer(c, async (db) => {
		const board = await readLeadBoard(db);
		return "error" in board
			? new Refusal(422, "unhandled_verb_failure")
			: board;
	});
});
