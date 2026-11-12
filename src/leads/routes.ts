import { Hono } from "hono";
import { answer, Refusal, refuse } from "../answer.ts";
import type { DatabaseEnv } from "../reader.ts";
import { readQuietFollowUps } from "./quiet-follow-ups.ts";
import { readReasonsToReachOut } from "./reasons-to-reach-out.ts";

const QUIET_FIELDS = ["lead_days", "vendor_days", "owner_slug"];
const REASON_FIELDS = ["limit", "before_id"];
const BEFORE_ID = /^[1-9][0-9]{0,18}$/u;
// The old system echoed back only identifier-shaped field names, at most 20.
const ECHOED_FIELD = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

function unregisteredFields(params: URLSearchParams, known: string[]) {
	const extra = [...new Set(params.keys())].filter((k) => !known.includes(k));
	return extra.length === 0
		? undefined
		: new Refusal(400, "unregistered_operation_fields", {
				fields: extra
					.sort()
					.filter((key) => ECHOED_FIELD.test(key))
					.slice(0, 20),
			});
}

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

leads.get("/reasons-to-reach-out", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const unregistered = unregisteredFields(params, REASON_FIELDS);
	if (unregistered) return refuse(c, unregistered);
	const limit = asNumber(params.get("limit"), 25);
	if (limit === undefined)
		return refuse(c, new Refusal(400, "invalid_number", { fields: ["limit"] }));
	const before_id = params.get("before_id");
	// The old schema check refused with a private code, so it answered generically.
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 100 ||
		(before_id !== null && !BEFORE_ID.test(before_id))
	)
		return refuse(c, new Refusal(400, "unhandled_verb_failure"));
	return answer(c, "list-practice-origination", (db) =>
		readReasonsToReachOut(db, { limit, before_id }),
	);
});
