import { Hono } from "hono";
import { answer, Refusal, refuse } from "../answer.ts";
import type { DatabaseEnv } from "../reader.ts";
import { readBoard, WORKSPACES, type Workspace } from "./board.ts";
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
