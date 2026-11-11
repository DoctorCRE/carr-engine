import { type Kysely, sql } from "kysely";
import type { DB } from "../../database.d.ts";

export type Resolution =
	| { type: string; id: string }
	| { error: "subject_not_found"; ref: string; hint: string }
	| {
			error: "needs_disambiguation";
			ref: string;
			candidates: Record<string, string | null>[];
			hint: string;
	  };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRINTED_REFS = [
	[/^L-\d+/i, "lead"],
	[/^C-\d+/i, "client"],
	[/^[VT]-/i, "vendor"],
	[/^P-\d+/i, "party"],
] as const;
const PICK_ONE = "pass the exact ref or full name";

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
		return ambiguous(
			ref,
			deals.map((d) => ({
				name: d.display_name,
				phase: d.status,
				client_ref: d.client_ref,
			})),
			PICK_ONE,
		);
	if (deals[0]) return found({ type: "deal", id: deals[0].id });
	for (const [types, hint] of [
		[["lead", "client", "vendor"], PICK_ONE],
		[
			["party"],
			"more than one party carries this name — often duplicate org rows for one company; pass the exact P-ref",
		],
	] as const) {
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
			return ambiguous(
				ref,
				rows.map((r) => ({
					name: r.display_name,
					ref: r.ref,
					kind: r.type,
					city: r.city,
				})),
				hint,
			);
		if (rows[0]) return found(rows[0]);
	}
	return {
		error: "subject_not_found",
		ref,
		hint: "use find first; refs look like L-204 / C-127 / V-CPA-006 / P-0948 or a deal name",
	};
}

function found(row: { type: string | null; id: string | null }) {
	return { type: String(row.type), id: String(row.id) };
}

function ambiguous(
	ref: string,
	candidates: Record<string, string | null>[],
	hint: string,
): Resolution {
	return { error: "needs_disambiguation", ref, candidates, hint };
}
