import { Hono } from "hono";
import { answer, checkFields, Refusal, refuse } from "../answer.ts";
import type { DatabaseEnv } from "../reader.ts";
import { readLeadBoard } from "./board.ts";
import { historyCursors, readLeadDetail } from "./detail.ts";
import { readQuietFollowUps } from "./quiet-follow-ups.ts";
import { readReasonsToReachOut } from "./reasons-to-reach-out.ts";
import { readTerritory } from "./territory.ts";

const BOARD_FIELDS = [
	"workspace",
	"lead_id",
	"correspondence_cursor",
	"stage_history_cursor",
];
const QUIET_FIELDS = ["lead_days", "vendor_days", "owner_slug"];
const REASON_FIELDS = ["limit", "before_id"];
const BEFORE_ID = /^[1-9][0-9]{0,18}$/u;
const TERRITORY_FIELDS = ["vertical", "city", "state"];

export const leads = new Hono<DatabaseEnv>();

leads.get("/leads", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const refused = checkFields(params, BOARD_FIELDS, {
		vocabularies: { workspace: ["leads"] },
		objects: { correspondence_cursor: ["occurred_at", "id"] },
	});
	if (refused) return refuse(c, refused);
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
	const refused = checkFields(params, QUIET_FIELDS, {
		numbers: ["lead_days", "vendor_days"],
	});
	if (refused) return refuse(c, refused);
	// The old read checked neither whole numbers nor their 1 to 365 range.
	const lead_days = Number(params.get("lead_days") ?? 45);
	const vendor_days = Number(params.get("vendor_days") ?? 90);
	const [ownerSlug = null, ...more] = params.getAll("owner_slug");
	// Its own error code was not public, so the old system answered generically.
	if (
		more.length > 0 ||
		(ownerSlug !== null && (!ownerSlug.trim() || ownerSlug.length > 100))
	)
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
	const refused = checkFields(params, TERRITORY_FIELDS);
	if (refused) return refuse(c, refused);
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

leads.get("/reasons-to-reach-out", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const refused = checkFields(params, REASON_FIELDS, { numbers: ["limit"] });
	if (refused) return refuse(c, refused);
	const limit = Number(params.get("limit") ?? 25);
	const [before_id = null, ...more] = params.getAll("before_id");
	// The old schema check refused with a private code, so it answered generically.
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 100 ||
		more.length > 0 ||
		(before_id !== null && !BEFORE_ID.test(before_id))
	)
		return refuse(c, new Refusal(400, "unhandled_verb_failure"));
	return answer(c, "list-practice-origination", (db) =>
		readReasonsToReachOut(db, { limit, before_id }),
	);
});
