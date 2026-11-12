import assert from "node:assert/strict";
import { test } from "node:test";
import { checklistOf, SOURCES } from "./checklist.ts";

type Facts = Parameters<typeof checklistOf>[0];
type Request = Facts["requests"][number];

const cited = SOURCES.map((s) => ({
	id: s.section_id,
	status: "active",
	body_hash: s.content_hash,
}));
const facts = (changes: Partial<Facts> = {}): Facts => ({
	deal: {
		id: "example-deal",
		owner: "example-partner",
		type: "startup",
		invoiced_on: null,
	},
	lease: null,
	criticalDates: [],
	sections: cited,
	commissions: [],
	requests: [],
	today: "2030-06-15",
	...changes,
});
const request = (row_key: string, due_on: string, filename?: string) => ({
	id: `request-${row_key}`,
	row_key,
	owner: "Example Owner",
	due_on,
	document_type: row_key,
	satisfied: false,
	receipts: [],
	status: filename ? "fulfilled" : "open",
	fulfilled_at: filename ? "2030-06-01T12:00:00.123Z" : null,
	fulfilled_by: filename ? "example-actor" : null,
	evidence_attachment_id: filename ? "example-attachment" : null,
	evidence_filename: filename ?? null,
});
const itemIds = (checklist: ReturnType<typeof checklistOf>) =>
	Object.fromEntries(
		checklist.phases.map((p) => [p.id, p.items.map((i) => i.id)]),
	);

test("a changed or retired source turns the checklist off", () => {
	for (const change of [{ body_hash: "0".repeat(64) }, { status: "retired" }]) {
		const checklist = checklistOf(
			facts({
				sections: cited.map((s, i) => (i === 2 ? { ...s, ...change } : s)),
			}),
		);
		assert.deepEqual(
			{ ...checklist, sources: checklist.sources.length },
			{
				schema_version: "deal-checklist.v1",
				template_state: "source_changed",
				deal_type: "lease",
				sources: 5,
				observed_on: "2030-06-15",
				requests_state: "current",
				phases: [],
				due_items: [],
			},
		);
	}
});

test("the deal type picks the items each phase lists", () => {
	assert.deepEqual(itemIds(checklistOf(facts())), {
		research: ["representation", "requirements"],
		site_selection: ["market_survey", "tour_notes"],
		negotiation: ["loi_submission", "loi_grid", "business_terms"],
		legal: ["contract_draft", "attorney_comments", "legal_review", "ti_scope"],
		closing: [
			"executed_lease",
			"commencement_letter",
			"executed_comp",
			"expiration_recorded",
			"move_in",
			"check_in_90_day",
		],
		invoice: ["invoice_recorded", "commission_received"],
	});
	const land = itemIds(
		checklistOf(facts({ deal: { ...facts().deal, type: "land" } })),
	);
	assert.deepEqual(land.legal?.slice(-3), [
		"commission_agreement",
		"feasibility",
		"entitlements",
	]);
	const unknown = checklistOf(
		facts({ deal: { ...facts().deal, type: "example-type" } }),
	);
	assert.equal(unknown.template_state, "deal_type_unknown");
	assert.equal(unknown.deal_type, null);
	assert.deepEqual(itemIds(unknown).research, [
		"representation",
		"requirements",
	]);
});

test("recorded facts complete items and requests set owner, date and status", () => {
	const requests: Request[] = [
		request("executed_lease", "2030-07-01"),
		request("loi_grid", "2030-06-10"),
		request("market_survey", "2030-06-15"),
		request("representation", "2030-05-01", "example-agreement.pdf"),
		request("requirements", "2030-06-10"),
		request("tour_notes", "2030-06-20"),
	];
	const deadline = {
		id: "example-date",
		kind: "due_diligence_end",
		due_on: "2030-06-01",
		source: "example-lease",
		status: "open",
	};
	const checklist = checklistOf(
		facts({
			deal: { ...facts().deal, invoiced_on: "2030-06-02" },
			lease: {
				status: "current",
				evidence_ref: "example-lease.pdf",
				executed_on: "2030-01-01",
				expiration_on: null,
			},
			commissions: ["a", "b"].map((id) => ({
				commission_id: id,
				status: "received",
				received_on: "2030-06-03",
			})),
			criticalDates: [
				deadline,
				{ ...deadline, id: "unsourced", source: " " },
				{ ...deadline, id: "passed", status: "passed" },
			],
			requests,
		}),
	);
	const items = new Map(
		checklist.phases.flatMap((p) => p.items).map((i) => [i.id, i]),
	);
	const status = (id: string) => [
		items.get(id)?.status,
		items.get(id)?.evidence_ref,
	];
	assert.deepEqual(status("executed_lease"), ["complete", "example-lease.pdf"]);
	assert.deepEqual(status("expiration_recorded"), ["not_recorded", null]);
	assert.deepEqual(status("invoice_recorded"), [
		"complete",
		"deal:example-deal:invoiced_on:2030-06-02",
	]);
	assert.deepEqual(status("commission_received"), [
		"complete",
		"commission:a, commission:b",
	]);
	assert.deepEqual(status("representation"), [
		"received",
		"example-agreement.pdf",
	]);
	assert.deepEqual(status("tour_notes"), ["upcoming", null]);
	assert.deepEqual(items.get("executed_lease"), {
		id: "executed_lease",
		label: "Executed lease / amendment",
		status: "complete",
		due_on: "2030-07-01",
		evidence_ref: "example-lease.pdf",
		owner: "Example Owner",
		document_type: "executed_lease",
		source: SOURCES[0],
		request: requests[0],
	});
	assert.deepEqual(items.get("invoice_recorded")?.source, {
		request: "per-deal standard checklist",
		record_verb: "record-deal-invoice",
	});
	assert.deepEqual(checklist.phases[3]?.items.at(-1), {
		id: "critical-date:example-date",
		label: "due diligence end",
		status: "overdue",
		due_on: "2030-06-01",
		evidence_ref: "example-lease",
		owner: "example-partner",
		document_type: null,
		source: { record_verb: "add-critical-date" },
	});
	assert.deepEqual(
		checklist.due_items.map((i) => [i.id, i.status]),
		[
			["critical-date:example-date", "overdue"],
			["loi_grid", "overdue"],
			["requirements", "overdue"],
			["market_survey", "due"],
		],
	);
});
