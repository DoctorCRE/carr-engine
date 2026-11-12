import { Hono } from "hono";
import {
	BusinessRefusal,
	isOneOf,
	PARTNERS,
	refusalOf,
} from "../clients/read.ts";
import { type DatabaseEnv, readSnapshot } from "../reader.ts";
import { projectNetwork, readNetwork } from "./network.ts";

const CONTRACT = "relationship-network.v1";

export const relationships = new Hono<DatabaseEnv>();

// Unlike the lists, the old door checked the partner before the query, and
// refused any query but this exact one without saying why.
relationships.get("/relationships", async (c) => {
	const database = c.env.DATABASE;
	const params = new URL(c.req.url).searchParams;
	try {
		if (!database)
			throw new BusinessRefusal({ error: "DEPENDENCY_UNAVAILABLE" });
		if (!isOneOf(PARTNERS, c.get("partner").slug))
			throw new BusinessRefusal({ error: "AUTHORIZATION_REFUSED" });
		if ([...params].length !== 1 || params.get("contract") !== CONTRACT)
			throw new BusinessRefusal({ error: "QUERY_INVALID" });
		const snapshot = await readSnapshot(database.connectionString, readNetwork);
		// The old clock is read after the query.
		return c.json(projectNetwork(snapshot, new Date()));
	} catch (error) {
		const refusal = refusalOf(error);
		return c.json(refusal.body, refusal.status);
	}
});
