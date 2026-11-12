import { Hono } from "hono";
import { answer, Refusal, refuse } from "../answer.ts";
import type { DatabaseEnv } from "../reader.ts";
import { readTerritory } from "./territory.ts";

const TERRITORY_FIELDS = ["vertical", "city", "state"];
// The old system echoed back only identifier-shaped field names, at most 20.
const ECHOED_FIELD = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export const leads = new Hono<DatabaseEnv>();

// The old schema declared lengths and a two-letter state but nothing checked
// them: an empty value meant no filter and any other value filtered exactly.
leads.get("/territory-state-board", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const extra = [...new Set(params.keys())].filter(
		(key) => !TERRITORY_FIELDS.includes(key),
	);
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
	return answer(c, "territory-state-board", async (db) => {
		const territory = await readTerritory(db, {
			vertical: params.get("vertical") || null,
			city: params.get("city") || null,
			state: params.get("state") || null,
		});
		// Its own error code was not public, so the old system answered generically.
		return "error" in territory
			? new Refusal(422, "unhandled_verb_failure")
			: territory;
	});
});
