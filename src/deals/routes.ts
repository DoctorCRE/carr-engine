import { type Context, Hono } from "hono";
import { type Reader, readSnapshot } from "../reader.ts";
import type { SessionEnv } from "../session.ts";
import { readBoard } from "./board.ts";
import { readDealDetail } from "./detail.ts";

export type DealsEnv = SessionEnv & {
	Bindings: { DATABASE?: { connectionString: string } };
};

// The hints are the old system's public ones, so a refusal body is exactly
// the error payload it returned.
const HINTS = {
	unauthenticated: "The authenticated actor could not be resolved.",
	not_a_deal: "Choose a deal record, not a client or lead.",
	not_found: "The requested record was not found.",
	needs_disambiguation:
		"Choose an exact record reference from the candidates before retrying.",
	value_not_in_declared_vocabulary:
		"Use a value from the field's documented vocabulary.",
	unhandled_verb_failure:
		"The operation failed. Quote the correlation_id when reporting it.",
};

class Refusal {
	readonly status: 400 | 404 | 409 | 422;
	readonly error: keyof typeof HINTS;
	readonly extra: Record<string, unknown>;
	constructor(
		status: Refusal["status"],
		error: Refusal["error"],
		extra: Record<string, unknown> = {},
	) {
		this.status = status;
		this.error = error;
		this.extra = extra;
	}
}

const WORKSPACES = ["team", "national_account", "all"] as const;
const isWorkspace = (value: string): value is (typeof WORKSPACES)[number] =>
	(WORKSPACES as readonly string[]).includes(value);

const invalidInput = (error: unknown) =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === "22P02";

async function answer(
	c: Context<DealsEnv>,
	verb: string,
	read: (db: Reader) => Promise<unknown>,
) {
	const database = c.env.DATABASE;
	if (!database) return c.json({ error: "database_unavailable" }, 503);
	const started = performance.now();
	let result: unknown;
	try {
		result = await readSnapshot(database.connectionString, read);
	} catch (error) {
		// The old system let PostgreSQL reject a malformed id and answered with
		// its generic failure.
		if (!invalidInput(error)) throw error;
		result = new Refusal(400, "unhandled_verb_failure", { verb });
	} finally {
		c.header("Server-Timing", `db;dur=${performance.now() - started}`);
	}
	if (!(result instanceof Refusal)) return c.json(result);
	return c.json(
		{
			error: result.error,
			correlation_id: crypto.randomUUID(),
			hint: HINTS[result.error],
			...result.extra,
		},
		result.status,
	);
}

export const deals = new Hono<DealsEnv>();

deals.get("/deals", async (c) => {
	const workspace = c.req.query("workspace");
	if (workspace !== undefined && !isWorkspace(workspace))
		return c.json(
			{
				error: "value_not_in_declared_vocabulary",
				correlation_id: crypto.randomUUID(),
				hint: HINTS.value_not_in_declared_vocabulary,
				allowed_values: WORKSPACES,
				fields: ["workspace"],
			},
			400,
		);
	const actor = c.get("partner").slug;
	return answer(c, "deal-room-board", async (db) => {
		const known = await db
			.selectFrom("actor")
			.select("id")
			.where("slug", "=", actor)
			.executeTakeFirst();
		if (!known) return new Refusal(422, "unauthenticated");
		return readBoard(db, {
			actor,
			workspace: workspace ?? null,
			account_client_id: c.req.query("account_client_id") ?? null,
		});
	});
});

deals.get("/deals/:deal{.+}", (c) =>
	answer(c, "get-deal-room", async (db) => {
		const detail = await readDealDetail(
			db,
			c.req.param("deal"),
			c.get("partner").slug,
		);
		if (!("error" in detail)) return detail;
		switch (detail.error) {
			case "unauthenticated":
				return new Refusal(422, "unauthenticated");
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
