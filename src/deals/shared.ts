import { type Expression, type Kysely, sql } from "kysely";
import type { DB } from "../database.d.ts";
import { asText } from "../reader.ts";

type DealId = string | Expression<string | null>;

export const RETIRED_ITEM_STATUSES = ["dropped", "expired"] as const;

// Over a deal board view aliased "b".
export const nextStepRequired =
	sql<boolean>`(${sql.ref("b.next_step")} is null or ${sql.ref("b.next_date")} is null)`.as(
		"next_step_required",
	);

export const vendorsOf = (db: Kysely<DB>, deal: DealId) =>
	db
		.selectFrom("v_deal_room_vendor as v")
		.select(["party_id", "role", "company", "contact", "note", "updated_at"])
		.where("v.deal_id", "=", deal)
		.orderBy("v.role")
		.orderBy(sql`v.company->>'name'`)
		.orderBy(sql`v.contact->>'name'`)
		.orderBy("v.party_id");

export const clientPortalUrlOf = (db: Kysely<DB>, deal: DealId) =>
	db
		.selectFrom("v_deal_client_portal as cp")
		.select("cp.client_portal_url")
		.where("cp.deal_id", "=", deal);

export const phaseChangeOf = (db: Kysely<DB>, deal: DealId) =>
	db
		.selectFrom("v_deal_room_phase_change as pc")
		.selectAll("pc")
		.where("pc.deal_id", "=", deal);

export const phaseStartsOf = (db: Kysely<DB>, deal: DealId) =>
	db
		.selectFrom("v_deal_room_phase_start as ps")
		.select((eb) => [
			"ps.phase",
			asText(eb.ref("ps.started_on")).as("started_on"),
		])
		.where("ps.deal_id", "=", deal);

export const phaseStartedOn = (
	starts: { phase: string | null; started_on: string | null }[],
) => Object.fromEntries(starts.map((s) => [s.phase, s.started_on]));

// "Dr. Jo Example (Example Clinic)" in Springfield reads "Dr. Example's
// Springfield Deal"; any other client keeps the deal's own name.
export function shortName(deal: {
	name: string | null;
	client_name: string | null;
	market?: string | null;
}) {
	const contact = (deal.client_name ?? "")
		.replace(/\s*\([^)]*\)\s*$/u, "")
		.trim();
	const doctor = /^Dr\.?\s+(\p{L}+(?:[ .'-]\p{L}+)*)$/u.exec(contact)?.[1];
	if (!doctor || !deal.market) return deal.name;
	return `Dr. ${doctor.split(/\s+/u).at(-1)}'s ${deal.market} Deal`;
}
