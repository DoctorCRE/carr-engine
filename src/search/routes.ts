import { Hono } from "hono";
import { answer, checkFields, Refusal, refuse } from "../answer.ts";
import type { DatabaseEnv } from "../reader.ts";
import { readFind } from "./find.ts";

export const search = new Hono<DatabaseEnv>();

search.get("/find", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const refused = checkFields(params, ["query"]);
	if (refused) return refuse(c, refused);
	// Untrimmed, as the app sends it; only absent or empty counts as missing.
	const query = params.get("query");
	if (!query)
		return refuse(
			c,
			new Refusal(400, "missing_required", { fields: ["query"] }),
		);
	return answer(c, "find", (db) => readFind(db, query));
});
