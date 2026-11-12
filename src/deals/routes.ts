import { type Context, Hono } from "hono";
import { failureKind, sqlState } from "../failure.ts";
import {
	DATABASE_UNAVAILABLE,
	type DatabaseEnv,
	type Reader,
	readSnapshot,
} from "../reader.ts";
import { readBoard, WORKSPACES, type Workspace } from "./board.ts";
import { readDealDetail } from "./detail.ts";

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
	database_refused_the_statement:
		"The operation could not be completed. Quote the correlation_id when reporting it.",
	missing_required:
		"Supply the named required fields from the tool's documented input.",
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

const isWorkspace = (value: string): value is Workspace =>
	(WORKSPACES as readonly string[]).includes(value);

const refuse = (c: Context<DatabaseEnv>, refusal: Refusal) =>
	c.json(
		{
			error: refusal.error,
			correlation_id: crypto.randomUUID(),
			hint: HINTS[refusal.error],
			...refusal.extra,
		},
		refusal.status,
	);

async function answer(
	c: Context<DatabaseEnv>,
	read: (db: Reader) => Promise<unknown>,
) {
	const database = c.env.DATABASE;
	if (!database) return c.json(DATABASE_UNAVAILABLE, 503);
	const started = performance.now();
	let result: unknown;
	try {
		result = await readSnapshot(database.connectionString, read);
	} catch (error) {
		// The old system turned PostgreSQL's refusal of a malformed id into this
		// public error.
		if (sqlState(error) === "22P02")
			result = new Refusal(400, "database_refused_the_statement");
		else {
			console.warn("deals read failed:", failureKind(error));
			return c.json({ error: "read_failed" }, 500);
		}
	} finally {
		c.header("Server-Timing", `db;dur=${performance.now() - started}`);
	}
	return result instanceof Refusal ? refuse(c, result) : c.json(result);
}

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
	const actor = c.get("partner").slug;
	return answer(c, async (db) => {
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

deals.get("/deals/", (c) =>
	refuse(c, new Refusal(400, "missing_required", { fields: ["deal"] })),
);

deals.get("/deals/:deal{.+}", (c) =>
	answer(c, async (db) => {
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
