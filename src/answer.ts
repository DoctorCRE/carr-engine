import type { Context } from "hono";
import { type Expression, sql } from "kysely";
import { failureKind, sqlState } from "./failure.ts";
import { type DatabaseEnv, type Reader, readSnapshot } from "./reader.ts";

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
	unregistered_operation_fields: "Remove fields outside the documented input.",
	invalid_number: "Supply a numeric value for the named fields.",
	tool_call_markup_in_value: "Remove tool-call markup from the named fields.",
	database_unavailable:
		"The operation failed. Quote the correlation_id when reporting it.",
};

export class Refusal {
	readonly status: 400 | 404 | 409 | 422 | 500 | 503;
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

export const refuse = (c: Context<DatabaseEnv>, refusal: Refusal) =>
	c.json(
		{
			error: refusal.error,
			correlation_id: crypto.randomUUID(),
			hint: HINTS[refusal.error],
			...refusal.extra,
		},
		refusal.status,
	);

// The old system echoed back only identifier-shaped field names, at most 20.
const ECHOED_FIELD = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export function unregisteredFields(
	params: URLSearchParams,
	known: readonly string[],
) {
	const extra = [...new Set(params.keys())].filter(
		(key) => !known.includes(key),
	);
	return extra.length === 0
		? undefined
		: new Refusal(400, "unregistered_operation_fields", {
				fields: extra
					.sort()
					.filter((key) => ECHOED_FIELD.test(key))
					.slice(0, 20),
			});
}

// The old system turned a numeric string into a number before the read's own
// checks: absent gives the fallback, blank or non-finite gives undefined.
export function asNumber(given: string | null, fallback: number) {
	if (given === null) return fallback;
	const trimmed = given.trim();
	return trimmed !== "" && Number.isFinite(Number(trimmed))
		? Number(trimmed)
		: undefined;
}

// The old answer printed these driver Dates with JavaScript's toISOString.
export const isoMillis = (stamp: Expression<unknown>) =>
	sql<string>`to_char(${stamp} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const isKnownPartner = async (db: Reader, slug: string) =>
	(await db
		.selectFrom("actor")
		.select("id")
		.where("slug", "=", slug)
		.executeTakeFirst()) !== undefined;

// The old tools whose reads the engine serves. A failed read's body names one.
type Verb =
	| "capture-queue"
	| "deal-room-board"
	| "find"
	| "find-and-catch-up"
	| "get-deal-room"
	| "ideal-client-profile"
	| "lead-board"
	| "list-practice-origination"
	| "quiet-follow-ups"
	| "read-vendor-markets-v1"
	| "territory-state-board";

export async function answer(
	c: Context<DatabaseEnv>,
	verb: Verb,
	read: (db: Reader) => Promise<unknown>,
) {
	const failed = (status: 500 | 503) =>
		refuse(c, new Refusal(status, "unhandled_verb_failure", { verb }));
	const database = c.env.DATABASE;
	if (!database) return failed(503);
	const started = performance.now();
	let result: unknown;
	try {
		result = await readSnapshot(database.connectionString, async (db) =>
			(await isKnownPartner(db, c.get("partner").slug))
				? read(db)
				: new Refusal(422, "unauthenticated"),
		);
	} catch (error) {
		// The old system turned PostgreSQL's refusal of a malformed id into this
		// public error.
		if (sqlState(error) === "22P02")
			result = new Refusal(400, "database_refused_the_statement");
		else {
			console.warn("read failed:", failureKind(error));
			return failed(500);
		}
	} finally {
		c.header("Server-Timing", `db;dur=${performance.now() - started}`);
	}
	return result instanceof Refusal ? refuse(c, result) : c.json(result);
}
