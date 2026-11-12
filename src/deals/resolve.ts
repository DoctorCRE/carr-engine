import { type Kysely, sql } from "kysely";
import { Refusal } from "../answer.ts";
import type { DB } from "../database.d.ts";
import { UUID } from "../uuid.ts";

type Unresolved =
	| { error: "subject_not_found" }
	| {
			error: "needs_disambiguation";
			candidates: Record<string, string | null>[];
	  };

type Resolution = { type: string; id: string } | Unresolved;

type DealLookup = { id: string } | Unresolved | { error: "not_a_deal" };

const PRINTED_REFS = [
	[/^L-\d+/i, "lead"],
	[/^C-\d+/i, "client"],
	[/^[VT]-/i, "vendor"],
	[/^P-\d+/i, "party"],
] as const;

export async function resolveSubject(
	db: Kysely<DB>,
	ref: string,
): Promise<Resolution> {
	const index = db.selectFrom("v_ref_index");
	if (UUID.test(ref)) {
		const rows = await index
			.select(["subject_type as type", "subject_id as id"])
			.where("subject_id", "=", ref)
			.limit(2)
			.execute();
		const hit =
			rows.length === 1 ? rows[0] : rows.find((r) => r.type === "deal");
		if (hit) return found(hit);
	}
	for (const [pattern, type] of PRINTED_REFS) {
		if (!pattern.test(ref)) continue;
		const hit = await index
			.select(["subject_type as type", "subject_id as id"])
			.where("subject_type", "=", type)
			.where("ref", "ilike", ref)
			.executeTakeFirst();
		if (hit) return found(hit);
	}
	const like = `%${ref}%`;
	const deals = await index
		.select(["subject_id as id", "display_name", "status", "client_ref"])
		.where("subject_type", "=", "deal")
		.where("display_name", "ilike", like)
		.limit(5)
		.execute();
	if (deals.length > 1)
		return {
			error: "needs_disambiguation",
			candidates: deals.map((d) => ({
				name: d.display_name,
				phase: d.status,
				client_ref: d.client_ref,
			})),
		};
	if (deals[0]) return found({ type: "deal", id: deals[0].id });
	for (const types of [["lead", "client", "vendor"], ["party"]] as const) {
		const rows = await index
			.select(["subject_type as type", "subject_id as id"])
			.select(["display_name", "ref", "city"])
			.where("subject_type", "in", types)
			.where("merged", "=", false)
			.where("display_name", "ilike", like)
			.orderBy(sql`similarity(display_name, ${ref})`, "desc")
			.limit(5)
			.execute();
		if (rows.length > 1)
			return {
				error: "needs_disambiguation",
				candidates: rows.map((r) => ({
					name: r.display_name,
					ref: r.ref,
					kind: r.type,
					city: r.city,
				})),
			};
		if (rows[0]) return found(rows[0]);
	}
	return { error: "subject_not_found" };
}

export async function resolveDeal(
	db: Kysely<DB>,
	ref: string,
): Promise<DealLookup> {
	const subject = await resolveSubject(db, ref);
	if ("error" in subject) return subject;
	return subject.type === "deal" ? { id: subject.id } : { error: "not_a_deal" };
}

export function lookupRefusal(failure: Exclude<DealLookup, { id: string }>) {
	switch (failure.error) {
		// Not one of the old system's public errors, so it answered generically.
		case "subject_not_found":
			return new Refusal(404, "unhandled_verb_failure");
		case "needs_disambiguation":
			return new Refusal(409, "needs_disambiguation", {
				candidates: failure.candidates,
			});
		case "not_a_deal":
			return new Refusal(422, "not_a_deal");
	}
}

function found(row: { type: string | null; id: string | null }) {
	return { type: String(row.type), id: String(row.id) };
}
