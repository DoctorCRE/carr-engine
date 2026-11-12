import { Hono } from "hono";
import { answer, Refusal, refuse } from "../answer.ts";
import { failureKind } from "../failure.ts";
import { type DatabaseEnv, readSnapshot } from "../reader.ts";
import { readBoard, WORKSPACES, type Workspace } from "./board.ts";
import { decodeCursor, readChanges } from "./changes.ts";
import { readClientFit } from "./client-fit.ts";
import { readDealDetail } from "./detail.ts";

const isWorkspace = (value: string): value is Workspace =>
	(WORKSPACES as readonly string[]).includes(value);

export const deals = new Hono<DatabaseEnv>();

deals.get("/deals", async (c) => {
	const workspace = c.req.query("workspace");
	if (workspace !== undefined && !isWorkspace(workspace))
		return refuse(
			c,
			new Refusal(400, "value_not_in_declared_vocabulary", {
				allowed_values: WORKSPACES,
				fields: ["workspace"],
			}),
		);
	return answer(c, (db) =>
		readBoard(db, {
			partner: c.get("partner").slug,
			workspace: workspace ?? null,
			account_client_id: c.req.query("account_client_id") ?? null,
		}),
	);
});

deals.get("/deals/", (c) =>
	refuse(c, new Refusal(400, "missing_required", { fields: ["deal"] })),
);

deals.get("/deals/:deal{.+}", (c) =>
	answer(c, async (db) => {
		const detail = await readDealDetail(db, c.req.param("deal"));
		if (!("error" in detail)) return detail;
		switch (detail.error) {
			// Not one of the old system's public errors, so it answered generically.
			case "subject_not_found":
				return new Refusal(404, "unhandled_verb_failure");
			case "needs_disambiguation":
				return new Refusal(409, "needs_disambiguation", {
					candidates: detail.candidates,
				});
			case "not_a_deal":
				return new Refusal(422, "not_a_deal");
			case "not_found":
				return new Refusal(404, "not_found");
		}
	}),
);

deals.get("/client-fit", (c) =>
	answer(c, async (db) => {
		const fit = await readClientFit(db, {
			vertical: c.req.query("vertical") || null,
			city: c.req.query("city") || null,
			state: c.req.query("state") || null,
		});
		// The old system's limit error was not public, so it answered generically.
		return "error" in fit ? new Refusal(422, "unhandled_verb_failure") : fit;
	}),
);

// The old feed checked the partner, then the method, then the cursor, and
// answered with bare error bodies.
deals.all("/pipeline/changes", async (c) => {
	if (c.req.method !== "GET")
		return c.json({ error: "method_not_allowed" }, 405);
	const given = new URL(c.req.url).searchParams.get("cursor") || "";
	const after = given ? decodeCursor(given) : null;
	if (after === undefined) return c.json({ error: "invalid_cursor" }, 400);
	const database = c.env.DATABASE;
	try {
		if (database)
			return c.json(
				await readSnapshot(database.connectionString, (db) =>
					readChanges(db, after, given),
				),
			);
	} catch (error) {
		console.warn("read failed:", failureKind(error));
	}
	// The old feed answered any failure this way, a missing database included.
	return refuse(c, new Refusal(503, "database_unavailable"));
});
