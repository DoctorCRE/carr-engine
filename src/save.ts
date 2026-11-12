import { createHash } from "node:crypto";
import type { Context } from "hono";
import { type InsertObject, sql, type Transaction } from "kysely";
import { Refusal, refuse } from "./answer.ts";
import type { DB, JsonObject } from "./database.d.ts";
import { failureKind } from "./failure.ts";
import { connect, type DatabaseEnv } from "./reader.ts";
import { UUID } from "./uuid.ts";

export type WriterEnv = DatabaseEnv & {
	Bindings: { DATABASE_WRITER?: { connectionString: string } };
};

export type Save = {
	partner: string;
	verb: string;
	args: JsonObject;
	correlation_id: string;
};

type HistoryEntry = {
	verb?: string;
	subject_type: string;
	subject_id: string;
	field?: string;
	old?: JsonObject;
	new?: JsonObject;
	human_quote?: string;
	agent_rationale?: string;
	occurred_at?: string;
	after_lock?: true;
};

export type Saving = {
	tx: Transaction<DB>;
	actor_id: string;
	record(entry: HistoryEntry): Promise<void>;
};

export type Change = (saving: Saving) => Promise<JsonObject>;

export class SaveRefusal extends Error {
	readonly refusal: Refusal;
	constructor(refusal: Refusal) {
		super(refusal.error);
		this.refusal = refusal;
	}
}

type Stamp = ReturnType<typeof stamp>;

// What the old system writes on every history row and receipt of a save made
// by a partner signed in to the app.
const stamp = (save: Save, actor_id: string, idempotency_key: string) => ({
	idempotency_key,
	verb: save.verb,
	actor_id,
	via: "dealroom-cookie",
	client_id: "dealroom-pwa",
	organization_tenant_id: "carr-internal",
	sponsoring_human_slug: save.partner,
	personal_scope: `${save.partner}-personal`,
	authorization_class: "verified_partner",
	correlation_id: save.correlation_id,
});

export async function runSave(
	connectionString: string,
	save: Save,
	change: Change,
): Promise<JsonObject> {
	const key = idempotencyKey(save.args);
	const db = connect(connectionString);
	try {
		return await db
			.transaction()
			.setIsolationLevel("read committed")
			.setAccessMode("read write")
			.execute(async (tx) => {
				const actor = await tx
					.selectFrom("actor")
					.select("id")
					.where("slug", "=", save.partner)
					.executeTakeFirst();
				if (!actor)
					throw new SaveRefusal(new Refusal(422, "actor_not_provisioned"));
				const stamped = stamp(save, actor.id, key);
				const hash = requestHash(save.args, stamped);
				// The old system's lock text, so same-key saves from either system
				// queue behind each other.
				await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(
					tx,
				);
				const prior = await tx
					.selectFrom("tool_call")
					.select(["request_hash", "response"])
					.where("idempotency_key", "=", key)
					.where("created_at", ">", sql<string>`now() - interval '30 days'`)
					// Every receipt, old or new, stores an answer object.
					.$narrowType<{ response: JsonObject }>()
					.executeTakeFirst();
				if (prior) {
					if (prior.request_hash !== hash)
						throw new SaveRefusal(new Refusal(409, "key_reuse"));
					return { replayed: true, ...prior.response };
				}
				const answer = await change({
					tx,
					actor_id: actor.id,
					record: async (entry) => {
						await tx
							.insertInto("event")
							.values(historyRow(entry, stamped))
							.execute();
					},
				});
				await tx
					.insertInto("tool_call")
					.values({ ...stamped, request_hash: hash, response: answer })
					.execute();
				return answer;
			});
	} finally {
		await db.destroy();
	}
}

// A save's answer to the signed-in partner: its JSON answer, or the old
// system's public refusal body.
export async function answerSave(
	c: Context<WriterEnv>,
	verb: string,
	args: JsonObject,
	change: Change,
) {
	const failed = (status: 500 | 503) =>
		refuse(c, new Refusal(status, "unhandled_verb_failure", { verb }));
	const writer = c.env.DATABASE_WRITER;
	if (!writer) return failed(503);
	try {
		const answer: unknown = await runSave(
			writer.connectionString,
			{
				partner: c.get("partner").slug,
				verb,
				args,
				correlation_id: crypto.randomUUID(),
			},
			change,
		);
		return c.json(answer);
	} catch (error) {
		if (error instanceof SaveRefusal) return refuse(c, error.refusal);
		console.warn("save failed:", failureKind(error));
		return failed(500);
	}
}

function idempotencyKey(args: JsonObject): string {
	const key = args.idempotency_key;
	if (!key) throw new SaveRefusal(new Refusal(400, "missing_idempotency_key"));
	if (typeof key !== "string" || !UUID.test(key))
		throw new SaveRefusal(
			new Refusal(400, "invalid_idempotency_key", {
				fields: ["idempotency_key"],
			}),
		);
	return key;
}

// The old hash also covers its registry's digest, which changes with every
// old release, so the engine hashes under its own name and a retry that
// crosses a save's switch is refused once as key_reuse.
function requestHash(
	{ idempotency_key: _key, ...args }: JsonObject,
	{
		idempotency_key: _stampedKey,
		correlation_id: _correlation,
		...principal
	}: Stamp,
): string {
	const manifest = { version: "doctorcre-engine-save.v1", principal, args };
	const sorted = JSON.stringify(manifest, (_, value: unknown) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)),
				)
			: value,
	);
	return createHash("sha256").update(sorted).digest("hex");
}

const historyRow = (
	entry: HistoryEntry,
	stamped: Stamp,
): InsertObject<DB, "event"> => ({
	...stamped,
	verb: entry.verb ?? stamped.verb,
	occurred_at: entry.occurred_at || sql<string>`now()`,
	recorded_at: entry.after_lock
		? sql<string>`clock_timestamp()`
		: sql<string>`now()`,
	subject_type: entry.subject_type,
	subject_id: entry.subject_id,
	field: entry.field || null,
	old_value: entry.old ?? null,
	new_value: entry.new ?? null,
	cause: entry.human_quote?.trim() ? "human_stated" : "automation_job",
	human_quote: entry.human_quote || null,
	agent_rationale: entry.agent_rationale || null,
});
