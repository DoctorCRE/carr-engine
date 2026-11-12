import { createHash } from "node:crypto";
import { type InsertObject, sql, type Transaction } from "kysely";
import type { DB, JsonObject } from "./database.d.ts";
import { connect } from "./reader.ts";

export type Save = {
	partner: string;
	verb: string;
	args: JsonObject;
	correlation_id: string;
};

type HistoryEntry = {
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
	readonly answer: { error: string } & JsonObject;
	constructor(answer: SaveRefusal["answer"]) {
		super(answer.error);
		this.answer = answer;
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
					throw new SaveRefusal({
						error: "actor_not_provisioned",
						slug: save.partner,
					});
				const stamped = stamp(save, actor.id, key);
				const hash = requestHash(save.args, stamped);
				// The old system's lock text, so a retry racing a first call to
				// either system waits for it and then replays its answer.
				await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(
					tx,
				);
				const prior = await tx
					.selectFrom("tool_call")
					.select(["request_hash", "response"])
					.where("idempotency_key", "=", key)
					.where("created_at", ">", sql<string>`now() - interval '30 days'`)
					.$narrowType<{ response: JsonObject }>()
					.executeTakeFirst();
				if (prior) {
					if (prior.request_hash !== hash)
						throw new SaveRefusal({ error: "key_reuse" });
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

function idempotencyKey(args: JsonObject): string {
	const key = args.idempotency_key;
	if (!key)
		throw new SaveRefusal({
			error: "missing_idempotency_key",
			hint: "generate a UUID per intended action; retries reuse the SAME key",
		});
	if (
		typeof key !== "string" ||
		!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(key)
	)
		throw new SaveRefusal({
			error: "invalid_idempotency_key",
			field: "idempotency_key",
		});
	return key;
}

// The old hash also covers its registry's digest, which changes with every
// old release, so the engine hashes under its own name and a retry that
// crosses a save's switch is refused once as key_reuse.
function requestHash(
	{ idempotency_key, ...args }: JsonObject,
	{ idempotency_key: key, correlation_id, ...principal }: Stamp,
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
