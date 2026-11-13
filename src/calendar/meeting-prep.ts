import { sql } from "kysely";
import type { Reader } from "../reader.ts";
import { type Meeting, meetingsFromSnapshot, UNAVAILABLE } from "./meetings.ts";
import { attempt, storedSnapshot } from "./snapshot.ts";

const SHOWN = 1000;

type Checked<T> = { value: T } & (
	| { state: "ready"; note?: never }
	| { state: "partial" | "unavailable"; note: string }
);
type Match = Record<"email" | "id", string> &
	Record<"name" | "client_ref", string | null>;
type Prep = { state: "ready" } & Record<
	"phase" | "next_step" | "next_date" | "last_touch" | "market",
	string | null
>;

const emailsOf = (meeting: Meeting) =>
	[meeting.organizer, ...meeting.attendees].flatMap((p) => p.email ?? []);

async function matchDeals(
	db: Reader,
	addresses: string[],
	partner: string,
): Promise<Checked<Match[]>> {
	const email = sql<string>`lower(trim(c."Email"))`;
	const rows = await attempt(db, () =>
		db
			.selectFrom("v_export_clients as c")
			.innerJoin("v_export_deals as d", "d.client_ref", "c.Client ID")
			.select([
				email.as("email"),
				sql<string>`d.id::text`.as("id"),
				"d.name",
				"d.client_ref",
			])
			.where(email, "=", sql<string>`any(${addresses}::text[])`)
			.where("d.outcome", "is", null)
			.where(sql<string>`lower(d.owner)`, "=", partner)
			.orderBy("email")
			.orderBy("d.id")
			.limit(SHOWN + 1)
			.execute(),
	);
	if (!rows)
		return {
			state: "unavailable",
			note: "Possible meeting deals could not be checked.",
			value: [],
		};
	if (rows.length <= SHOWN) return { state: "ready", value: rows };
	return {
		state: "partial",
		note: "Some possible meeting deals were omitted. Search the record for more.",
		value: rows.slice(0, SHOWN),
	};
}

async function prepareDeals(
	db: Reader,
	ids: string[],
	partner: string,
): Promise<Checked<Map<string, Prep>>> {
	const rows = await attempt(db, () =>
		db
			.selectFrom("v_open_deal_room_board")
			.select([
				sql<string>`id::text`.as("id"),
				"phase",
				"next_step",
				sql<string | null>`next_date::text`.as("next_date"),
				sql<string | null>`last_touch::text`.as("last_touch"),
				"market",
			])
			.where("id", "=", sql<string>`any(${ids}::uuid[])`)
			.where(sql<string>`lower(owner)`, "=", partner)
			.orderBy("id")
			.limit(SHOWN)
			.execute(),
	);
	if (!rows)
		return {
			state: "unavailable",
			note: "Meeting deal preparation could not be checked.",
			value: new Map(),
		};
	const value = new Map(
		rows.map(({ id, ...prep }): [string, Prep] => [
			id,
			{ state: "ready", ...prep },
		]),
	);
	if (ids.every((id) => value.has(id))) return { state: "ready", value };
	return {
		state: "partial",
		note: "Preparation is unavailable for some possible deals. Check the deal record.",
		value,
	};
}

// The partner's meetings with the open deals their attendees' emails match.
// A match is a suggestion, never a recorded link between meeting and deal.
export async function readMeetingPrep(db: Reader, partner: string) {
	const section = meetingsFromSnapshot(
		await storedSnapshot(db, partner),
		new Date(),
	);
	if (!section || section.state === "unavailable") return UNAVAILABLE;

	const addresses = [...new Set(section.items.flatMap(emailsOf))];
	const matched = addresses.length
		? await matchDeals(db, addresses, partner)
		: undefined;
	const matches = matched?.value ?? [];
	const ids = [...new Set(matches.map((match) => match.id))];
	const prepared = ids.length
		? await prepareDeals(db, ids, partner)
		: undefined;
	const notes = [matched?.note, prepared?.note].filter(
		(note) => note !== undefined,
	);

	return {
		...section,
		state: notes.length ? "partial" : section.state,
		notes: [...section.notes, ...notes],
		sources: {
			...section.sources,
			...(matched && { deal_suggestions: { state: matched.state } }),
			...(prepared && { meeting_prep: { state: prepared.state } }),
		},
		items: section.items.map((meeting) => {
			const emails = new Set(emailsOf(meeting));
			return {
				...meeting,
				possible_deals: matches
					.filter((match) => emails.has(match.email))
					.map(({ id, name, client_ref }) => ({
						id,
						name,
						client_ref,
						prep: prepared?.value.get(id) ?? { state: "unavailable" },
					})),
			};
		}),
		match_basis: "attendee_email_possible_match",
	};
}
