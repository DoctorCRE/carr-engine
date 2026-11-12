import { Hono } from "hono";
import { answer, Refusal, refuse } from "../answer.ts";
import type { DatabaseEnv } from "../reader.ts";
import { readQuietFollowUps } from "./quiet-follow-ups.ts";

const FIELDS = ["lead_days", "vendor_days", "owner_slug"];
// The old system echoed back only identifier-shaped field names, at most 20.
const ECHOED_FIELD = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

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
	const extra = [...new Set(params.keys())].filter((k) => !FIELDS.includes(k));
	if (extra.length > 0)
		return refuse(
			c,
			new Refusal(400, "unregistered_operation_fields", {
				fields: extra
					.sort()
					.filter((key) => ECHOED_FIELD.test(key))
					.slice(0, 20),
			}),
		);
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
