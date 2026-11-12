import { sql } from "kysely";
import { asText, type Reader } from "../reader.ts";

type Cursor = { recorded_at: string; id: string };

const PAGE = 200;
const PLACEHOLDERS = new Set([
	"sf_commission_placeholder",
	"sf_close_date_placeholder",
]);
// The old system's patterns. PostgreSQL checks the time itself when it casts.
const TIME =
	/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Both values are ASCII, so btoa needs no UTF-8 step.
const encodeCursor = ({ recorded_at, id }: Cursor) =>
	btoa(JSON.stringify({ recorded_at, id }))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

// Undefined means the cursor is refused. A valid cursor's values are ASCII, so
// reading the bytes as Latin-1 accepts exactly what a UTF-8 decode would.
export function decodeCursor(text: string): Cursor | undefined {
	const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
	let value: unknown;
	try {
		value = JSON.parse(
			atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
		);
	} catch {
		return undefined;
	}
	if (
		typeof value === "object" &&
		value !== null &&
		"recorded_at" in value &&
		typeof value.recorded_at === "string" &&
		TIME.test(value.recorded_at) &&
		"id" in value &&
		typeof value.id === "string" &&
		UUID.test(value.id)
	)
		return { recorded_at: value.recorded_at, id: value.id };
	return undefined;
}

const withoutPlaceholders = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(withoutPlaceholders)
		: typeof value === "object" && value !== null
			? Object.fromEntries(
					Object.entries(value)
						.filter(([key]) => !PLACEHOLDERS.has(key))
						.map(([key, nested]) => [key, withoutPlaceholders(nested)]),
				)
			: value;

const laterThan = ({ recorded_at, id }: Cursor) =>
	sql<boolean>`(recorded_at, id) > (${recorded_at}::timestamptz, ${id}::uuid)`;

// Each order names the text output column, as the old queries did, so
// PostgreSQL sorts the text form while the cursor compares timestamps.
const eventsAfter = (db: Reader, after: Cursor | null) =>
	db
		.selectFrom("v_deal_room_event")
		.select((eb) => [
			"id",
			asText(eb.ref("recorded_at")).as("recorded_at"),
			"actor",
			"verb",
			"subject_type",
			"subject_id",
			"field",
			"old_value",
			"new_value",
		])
		.where(after === null ? sql<boolean>`true` : laterThan(after))
		.orderBy("recorded_at")
		.orderBy("id")
		.limit(PAGE)
		// The view's columns come from NOT NULL table columns.
		.$narrowType<{ id: string; recorded_at: string }>()
		.execute();

const livePresence = (db: Reader) =>
	db
		.selectFrom("v_deal_room_presence")
		.select((eb) => [
			"actor",
			"deal_id",
			"field",
			asText(eb.ref("expires_at")).as("expires_at"),
		])
		.where("expires_at", ">", sql<string>`now()`)
		.orderBy("actor")
		.orderBy("deal_id")
		.orderBy("field")
		.execute();

const captureSessions = (db: Reader) =>
	db
		.selectFrom("v_capture_session_status")
		.select((eb) => [
			"session_id",
			"device_id",
			"state",
			asText(eb.ref("started_at")).as("started_at"),
			asText(eb.ref("state_at")).as("state_at"),
		])
		.orderBy("started_at")
		.orderBy("session_id")
		.execute();

// With no new events the answer hands back the cursor it was given.
export async function readChanges(
	db: Reader,
	after: Cursor | null,
	given: string,
) {
	const events = (await eventsAfter(db, after)).map((event) => ({
		...event,
		old_value: withoutPlaceholders(event.old_value),
		new_value: withoutPlaceholders(event.new_value),
	}));
	const last = events.at(-1);
	return {
		events,
		presence: await livePresence(db),
		capture_sessions: await captureSessions(db),
		cursor: last ? encodeCursor(last) : given,
	};
}
