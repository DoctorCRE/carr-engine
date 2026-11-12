import { Hono } from "hono";
import { answer, Refusal, refuse, unregisteredFields } from "../answer.ts";
import type { DatabaseEnv } from "../reader.ts";
import { readLeadBoard } from "./board.ts";
import { historyCursors, readLeadDetail } from "./detail.ts";
import { readQuietFollowUps } from "./quiet-follow-ups.ts";

const BOARD_FIELDS = [
	"workspace",
	"lead_id",
	"correspondence_cursor",
	"stage_history_cursor",
];
const QUIET_FIELDS = ["lead_days", "vendor_days", "owner_slug"];

// The old system turned a numeric string into a number and checked neither
// whole numbers nor the declared 1 to 365 range.
function asNumber(given: string | null, fallback: number) {
	if (given === null) return fallback;
	const trimmed = given.trim();
	return trimmed !== "" && Number.isFinite(Number(trimmed))
		? Number(trimmed)
		: undefined;
}

export const leads = new Hono<DatabaseEnv>();

leads.get("/leads", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const workspace = params.get("workspace");
	if (workspace !== null && workspace !== "leads")
		return refuse(
			c,
			new Refusal(400, "value_not_in_declared_vocabulary", {
				allowed_values: ["leads"],
				fields: ["workspace"],
			}),
		);
	const unregistered = unregisteredFields(params, BOARD_FIELDS);
	if (unregistered) return refuse(c, unregistered);
	const cursors = historyCursors(params);
	// The old refusal of a cursor was not public, so it answered generically.
	if (!cursors) return refuse(c, new Refusal(400, "unhandled_verb_failure"));
	const leadId = params.get("lead_id");
	return answer(c, "lead-board", async (db) => {
		const board = leadId
			? await readLeadDetail(db, leadId, cursors)
			: await readLeadBoard(db);
		return "error" in board
			? new Refusal(422, "unhandled_verb_failure")
			: board;
	});
});

leads.get("/quiet-follow-ups", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const unregistered = unregisteredFields(params, QUIET_FIELDS);
	if (unregistered) return refuse(c, unregistered);
	const lead_days = asNumber(params.get("lead_days"), 45);
	if (lead_days === undefined)
		return refuse(
			c,
			new Refusal(400, "invalid_number", { fields: ["lead_days"] }),
		);
	const vendor_days = asNumber(params.get("vendor_days"), 90);
	if (vendor_days === undefined)
		return refuse(
			c,
			new Refusal(400, "invalid_number", { fields: ["vendor_days"] }),
		);
	const ownerSlug = params.get("owner_slug");
	// Its own error code was not public, so the old system answered generically.
	if (ownerSlug !== null && (!ownerSlug.trim() || ownerSlug.length > 100))
		return refuse(c, new Refusal(422, "unhandled_verb_failure"));
	return answer(c, "quiet-follow-ups", async (db) => {
		const quiet = await readQuietFollowUps(
			db,
			{ lead_days, vendor_days },
			ownerSlug,
		);
		return "error" in quiet
			? new Refusal(422, "unhandled_verb_failure")
			: quiet;
	});
});
