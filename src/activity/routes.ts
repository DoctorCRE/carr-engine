import { Hono } from "hono";
import { answer, checkFields, Refusal, refuse } from "../answer.ts";
import { lookupRefusal } from "../deals/resolve.ts";
import type { DatabaseEnv } from "../reader.ts";
import { readRecentActivity } from "./read.ts";

const FIELDS = ["query", "limit"];
const QUERY_MAX = 200;
const LIMIT_MAX = 50;

// The read's own refusals were not public, so the old system answered generically.
const generic = () => new Refusal(422, "unhandled_verb_failure");

export const activity = new Hono<DatabaseEnv>();

// The old door's checks in its order: the field gate, the required query,
// then the read's own checks on the trimmed query and limit.
activity.get("/recent-activity", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const refused = checkFields(params, FIELDS, { numbers: ["limit"] });
	if (refused) return refuse(c, refused);
	const limit = Number(params.get("limit") ?? 20);
	// A repeated query is the old input's list: present, but not a string.
	const [query, ...more] = params.getAll("query");
	if (query === undefined || (!query && more.length === 0))
		return refuse(
			c,
			new Refusal(400, "missing_required", { fields: ["query"] }),
		);
	const trimmed = query.trim();
	if (more.length > 0 || !trimmed || trimmed.length > QUERY_MAX)
		return refuse(c, generic());
	if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX)
		return refuse(c, generic());
	return answer(c, "find-and-catch-up", async (db) => {
		const read = await readRecentActivity(
			db,
			c.get("partner").slug,
			trimmed,
			limit,
		);
		if (!("error" in read)) return read;
		switch (read.error) {
			case "needs_disambiguation":
			case "subject_not_found":
				return lookupRefusal(read);
			case "tool_call_markup_in_value":
				// The old answer kept only fields of its own input, and `ref` is not one.
				return new Refusal(400, "tool_call_markup_in_value", { fields: [] });
			case "calendar_history_too_large":
				return generic();
		}
	});
});
