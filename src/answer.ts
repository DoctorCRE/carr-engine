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
	invalid_field_value:
		"Check the named fields against the tool's documented input.",
	database_refused_the_statement:
		"The operation could not be completed. Quote the correlation_id when reporting it.",
	missing_required:
		"Supply the named required fields from the tool's documented input.",
	unregistered_operation_fields: "Remove fields outside the documented input.",
	caller_authority_field_forbidden: "Remove caller-supplied authority fields.",
	invalid_boolean: "Supply a boolean value for the named fields.",
	invalid_number: "Supply a numeric value for the named fields.",
	tool_call_markup_in_value: "Remove tool-call markup from the named fields.",
	database_unavailable:
		"The operation failed. Quote the correlation_id when reporting it.",
	missing_idempotency_key: "Supply a fresh idempotency_key for this operation.",
	invalid_idempotency_key:
		"Supply a UUID as idempotency_key and reuse it only for the same action.",
	key_reuse: "Use a fresh idempotency_key for changed arguments.",
	actor_not_provisioned: "The authenticated actor is not provisioned.",
	field_required:
		"Supply the required field using the documented operation shape.",
};

export class Refusal {
	readonly status: 400 | 403 | 404 | 409 | 422 | 500 | 503;
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

export const refuse = (
	c: Context<DatabaseEnv>,
	refusal: Refusal,
	correlation_id = crypto.randomUUID(),
) =>
	c.json(
		{
			error: refusal.error,
			correlation_id,
			hint: HINTS[refusal.error],
			...refusal.extra,
		},
		refusal.status,
	);

// The old system echoed back only identifier-shaped field names, at most 20.
const ECHOED_FIELD = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

// The old system kept these names for the caller's identity and refused them
// before any other field check.
const RESERVED_FIELDS = new Set([
	"tenant",
	"tenant_id",
	"organization_tenant_id",
	"sponsor",
	"sponsoring_human_id",
	"sponsoring_human_slug",
	"human_slug",
	"identity",
	"actor",
	"runtime_principal",
	"audience",
	"authorization",
	"authorization_class",
	"profile",
	"capability",
	"capabilities",
	"action",
	"actions",
	"action_authority",
	"action_authorities",
	"allowed_actions",
	"write",
	"writes_records",
	"calls_models",
	"call_models",
]);

// The old input gate in its order: reserved names, then each field's declared
// vocabulary, then names outside the documented input.
export function checkFields(
	params: URLSearchParams,
	fields: readonly string[],
	vocabularies: Readonly<Record<string, readonly string[]>> = {},
) {
	const names = [...new Set(params.keys())].sort();
	const reserved = names.filter((name) => RESERVED_FIELDS.has(name));
	if (reserved.length > 0)
		return new Refusal(403, "caller_authority_field_forbidden", {
			fields: reserved.slice(0, 20),
		});
	for (const [field, allowed] of Object.entries(vocabularies)) {
		const value = params.get(field);
		if (value !== null && !allowed.includes(value))
			return new Refusal(400, "value_not_in_declared_vocabulary", {
				allowed_values: allowed,
				fields: [field],
			});
	}
	const extra = names.filter((name) => !fields.includes(name));
	return extra.length === 0
		? undefined
		: new Refusal(400, "unregistered_operation_fields", {
				fields: extra.filter((name) => ECHOED_FIELD.test(name)).slice(0, 20),
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
	| "read-invoice-tracker"
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
