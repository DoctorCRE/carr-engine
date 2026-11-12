import { Hono } from "hono";
import { answer, Refusal, refuse } from "../answer.ts";
import type { DatabaseEnv } from "../reader.ts";
import { readFind } from "./find.ts";

// The old system echoed back only identifier-shaped field names, at most 20.
const ECHOED_FIELD = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export const search = new Hono<DatabaseEnv>();

search.get("/find", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const extra = [...new Set(params.keys())].filter((key) => key !== "query");
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
	// Untrimmed, as the app sends it; only absent or empty counts as missing.
	const query = params.get("query");
	if (!query)
		return refuse(
			c,
			new Refusal(400, "missing_required", { fields: ["query"] }),
		);
	return answer(c, "find", (db) => readFind(db, query));
});
