import assert from "node:assert/strict";
import { test } from "node:test";
import { type Finding, reachability } from "./reachability.ts";

const lead = { base_version: 1, contact_eligible: true };
const input = {
	party_id: "made-up-party",
	created_at: "2026-01-01T00:00:00+00:00",
	email: "route@example.test",
	cell: null,
	phone: null,
	activities: [],
};
const finding = (f: Partial<Finding>): Finding => ({
	flag_id: "made-up-flag",
	kind: "email",
	found: true,
	expired: false,
	proposes_correction: false,
	source: "Example registry",
	observed_at: "2026-03-01T00:00:00+00:00",
	expires_on: null,
	value: { email: "route@example.test" },
	...f,
});

test("a finding with sub-millisecond digits counts from the next millisecond", async () => {
	const evidence = [
		finding({ observed_at: "2026-03-04T05:06:07.123456+00:00" }),
	];
	const at = (iso: string) =>
		reachability(lead, evidence, input, Date.parse(iso));
	assert.equal(
		(await at("2026-03-04T05:06:07.123Z")).evidence_state,
		"unknown",
	);
	assert.equal(
		(await at("2026-03-04T05:06:07.124Z")).evidence_state,
		"current",
	);
});

test("a route stays usable through its expiry day in Chicago", async () => {
	const evidence = [finding({ expires_on: "2026-03-04" })];
	const at = async (iso: string) =>
		(await reachability(lead, evidence, input, Date.parse(iso))).usable_route;
	// 03:00 UTC on the 5th is still the 4th in Chicago.
	assert.notEqual(await at("2026-03-05T03:00:00Z"), null);
	assert.equal(await at("2026-03-05T07:00:00Z"), null);
});
