import { Hono } from "hono";
import {
	answer,
	asNumber,
	Refusal,
	refuse,
	unregisteredFields,
} from "../answer.ts";
import type { DatabaseEnv } from "../reader.ts";
import { hasToolCallMarkup, readRecentActivity } from "./read.ts";

const FIELDS = ["query", "limit"];
const QUERY_MAX = 200;
const LIMIT_MAX = 50;

// The read's own refusals were not public, so the old system answered generically.
const generic = () => new Refusal(422, "unhandled_verb_failure");

export const activity = new Hono<DatabaseEnv>();

// The old door's checks in its order: unknown fields, markup, numbers, the
// required query, then the read's own checks on the trimmed query and limit.
activity.get("/recent-activity", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const unregistered = unregisteredFields(params, FIELDS);
	if (unregistered) return refuse(c, unregistered);
	for (const field of FIELDS) {
		const value = params.get(field);
		if (value !== null && hasToolCallMarkup(field, value))
			return refuse(
				c,
				new Refusal(400, "tool_call_markup_in_value", { fields: [field] }),
			);
	}
	const limit = asNumber(params.get("limit"), 20);
	if (limit === undefined)
		return refuse(c, new Refusal(400, "invalid_number", { fields: ["limit"] }));
	const query = params.get("query");
	if (!query)
		return refuse(
			c,
			new Refusal(400, "missing_required", { fields: ["query"] }),
		);
	const trimmed = query.trim();
	if (!trimmed || trimmed.length > QUERY_MAX) return refuse(c, generic());
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
				return new Refusal(409, "needs_disambiguation", {
					candidates: read.candidates,
				});
			case "tool_call_markup_in_value":
				// The old answer kept only fields of its own input, and `ref` is not one.
				return new Refusal(400, "tool_call_markup_in_value", { fields: [] });
			case "subject_not_found":
				return new Refusal(404, "unhandled_verb_failure");
			case "calendar_history_too_large":
				return generic();
		}
	});
});
