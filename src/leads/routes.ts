import { Hono } from "hono";
import { answer, Refusal, refuse, unregisteredFields } from "../answer.ts";
import type { DatabaseEnv } from "../reader.ts";
import { readLeadBoard } from "./board.ts";
import { readQuietFollowUps } from "./quiet-follow-ups.ts";
import { readTerritory } from "./territory.ts";

// The old input also took `lead_id` to open one lead, which the engine does
// not serve yet.
const BOARD_FIELDS = [
	"workspace",
	"correspondence_cursor",
	"stage_history_cursor",
];
const QUIET_FIELDS = ["lead_days", "vendor_days", "owner_slug"];
const TERRITORY_FIELDS = ["vertical", "city", "state"];

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
	// The old read refused any history cursor sent without a lead, and its
	// error was not public, so it answered generically.
	if (params.has("correspondence_cursor") || params.has("stage_history_cursor"))
		return refuse(c, new Refusal(400, "unhandled_verb_failure"));
	return answer(c, "lead-board", async (db) => {
		const board = await readLeadBoard(db);
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

// The old schema declared lengths and a two-letter state but nothing checked
// them: an empty value meant no filter and any other value filtered exactly.
leads.get("/territory-state-board", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const unregistered = unregisteredFields(params, TERRITORY_FIELDS);
	if (unregistered) return refuse(c, unregistered);
	return answer(c, "territory-state-board", async (db) => {
		const territory = await readTerritory(db, {
			vertical: params.get("vertical") || null,
			city: params.get("city") || null,
			state: params.get("state") || null,
		});
		// Its own error code was not public, so the old system answered generically.
		return "error" in territory
			? new Refusal(422, "unhandled_verb_failure")
			: territory;
	});
});
