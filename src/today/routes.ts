import { Hono } from "hono";
import { answer, checkFields, Refusal, refuse } from "../answer.ts";
import type { DatabaseEnv } from "../reader.ts";
import { OWNERS, parseCursor, readTodayTriage } from "./triage.ts";

export const today = new Hono<DatabaseEnv>();

// The old door checked its fields, then the read refused a bad page or cursor
// with private codes, so the old system answered generically.
today.get("/today-triage", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const refused = checkFields(params, ["owners", "limit", "cursor"], {
		vocabularies: { owners: OWNERS },
		numbers: ["limit"],
	});
	if (refused) return refuse(c, refused);
	const owners =
		OWNERS.find((given) => given === params.get("owners")) ?? "all";
	const limit = Number(params.get("limit") ?? 50);
	// A repeated cursor is the old input's list, which is not a string.
	const [cursor, ...more] = params.getAll("cursor");
	const after =
		cursor === undefined
			? null
			: more.length === 0
				? parseCursor(cursor, owners)
				: undefined;
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 50 ||
		after === undefined
	)
		return refuse(c, new Refusal(422, "unhandled_verb_failure"));
	return answer(c, "today-triage", (db) =>
		readTodayTriage(db, { owners, limit, after }),
	);
});
