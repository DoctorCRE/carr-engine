import { Hono } from "hono";
import { answer, checkFields, Refusal, refuse } from "../answer.ts";
import { failureKind } from "../failure.ts";
import { type DatabaseEnv, readSnapshot } from "../reader.ts";
import { readBoard, WORKSPACES } from "./board.ts";
import { readCaptureQueue } from "./capture-queue.ts";
import { decodeCursor, readChanges } from "./changes.ts";
import { readClientFit } from "./client-fit.ts";
import { readDealDetail } from "./detail.ts";

export const deals = new Hono<DatabaseEnv>();

deals.get("/deals", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const refused = checkFields(params, ["workspace", "account_client_id"], {
		vocabularies: { workspace: WORKSPACES },
	});
	if (refused) return refuse(c, refused);
	const given = params.get("workspace");
	return answer(c, "deal-room-board", (db) =>
		readBoard(db, {
			partner: c.get("partner").slug,
			workspace: WORKSPACES.find((workspace) => workspace === given) ?? null,
			account_client_id: params.get("account_client_id"),
		}),
	);
});

// The deal page's argument is its path, never a query field.
function dealArguments(url: string, deal?: string) {
	const params = new URL(url).searchParams;
	params.delete("deal");
	if (deal !== undefined) params.set("deal", deal);
	return params;
}

deals.get("/deals/", (c) =>
	refuse(
		c,
		checkFields(dealArguments(c.req.url), ["deal"]) ??
			new Refusal(400, "missing_required", { fields: ["deal"] }),
	),
);

deals.get("/deals/:deal{.+}", async (c) => {
	const refused = checkFields(dealArguments(c.req.url, c.req.param("deal")), [
		"deal",
	]);
	if (refused) return refuse(c, refused);
	return answer(c, "get-deal-room", async (db) => {
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
	});
});

deals.get("/client-fit", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const refused = checkFields(params, ["vertical", "city", "state"]);
	if (refused) return refuse(c, refused);
	return answer(c, "ideal-client-profile", async (db) => {
		const fit = await readClientFit(db, {
			vertical: params.get("vertical") || null,
			city: params.get("city") || null,
			state: params.get("state") || null,
		});
		// The old system's limit error was not public, so it answered generically.
		return "error" in fit ? new Refusal(422, "unhandled_verb_failure") : fit;
	});
});

deals.get("/capture-queue", async (c) => {
	const refused = checkFields(new URL(c.req.url).searchParams, []);
	return refused
		? refuse(c, refused)
		: answer(c, "capture-queue", readCaptureQueue);
});

// The old feed checked the partner, then the method, then the cursor, ignored
// any other query field and answered with bare error bodies.
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
