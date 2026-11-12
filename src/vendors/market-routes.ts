import { Hono } from "hono";
import { answer, checkFields, Refusal, refuse } from "../answer.ts";
import { PARTNERS } from "../clients/read.ts";
import type { DatabaseEnv } from "../reader.ts";
import { isMarketName, readVendorMarkets } from "./markets.ts";

const isPartner = (slug: string) =>
	PARTNERS.some((partner) => partner === slug);

export const vendorMarkets = new Hono<DatabaseEnv>();

// None of this read's own refusals was public, so the old system answered
// each one generically.
vendorMarkets.get("/vendor-markets", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const refused = checkFields(params, ["market"]);
	if (refused) return refuse(c, refused);
	// A repeated market stands for the old input's non-string value.
	const [market = null, ...more] = params.getAll("market");
	if (more.length > 0 || (market !== null && !isMarketName(market)))
		return refuse(c, new Refusal(400, "unhandled_verb_failure"));
	return answer(c, "read-vendor-markets-v1", async (db) => {
		if (!isPartner(c.get("partner").slug))
			return new Refusal(422, "unhandled_verb_failure");
		const markets = await readVendorMarkets(db, market);
		if (!("error" in markets)) return markets;
		return markets.error === "vendor_market_not_found"
			? new Refusal(404, "unhandled_verb_failure")
			: new Refusal(422, "unhandled_verb_failure");
	});
});
