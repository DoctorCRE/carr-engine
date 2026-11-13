import assert from "node:assert/strict";
import { test } from "node:test";
import { meetingsFromSnapshot } from "./meetings.ts";
import { scheduling } from "./scheduling.ts";

const NOW = new Date("2026-11-12T15:00:00.000Z");
const at = (hours: number) =>
	new Date(NOW.getTime() + hours * 3_600_000).toISOString();
const planned = (extra: Record<string, unknown>, items: unknown[]) => {
	const snapshot = {
		schema: "carr-calendar-agenda.v1",
		observed_at: at(-1),
		items,
		...extra,
	};
	const section = meetingsFromSnapshot(snapshot, NOW);
	assert.ok(section);
	return scheduling(snapshot, section, NOW);
};
const meeting = (start: number, end: number, extra = {}) => ({
	start: at(start),
	end: at(end),
	title: "Example",
	...extra,
});

test("openings are the half hours and more the next day's meetings leave", () => {
	const plan = planned({}, [meeting(1, 2), meeting(1.5, 3), meeting(3.25, 4)]);
	assert.equal(plan.state, "ready");
	assert.deepEqual(plan.items, [
		{ start: at(0), end: at(1) },
		{ start: at(4), end: at(24) },
	]);
});

test("openings wait for a calendar that holds every meeting", () => {
	for (const [extra, items] of [
		[{ observed_at: at(-19) }, []],
		[{ warnings: [{ code: "trimmed" }] }, []],
		[{ warnings: [{ code: "canceled_hidden", count: 0 }] }, []],
		[{}, [meeting(1, 2, { conflict: true })]],
		[{}, [{ start: "nope" }]],
	] as const) {
		const plan = planned(extra, [...items]);
		assert.equal(
			"reason" in plan && plan.reason,
			"calendar_coverage_insufficient",
		);
	}
	assert.equal(
		planned({ warnings: [{ code: "canceled_hidden" }] }, []).state,
		"partial",
	);
});
