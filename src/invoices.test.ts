import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../scripts/test-database.ts";
import worker from "./worker.ts";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const agent = id(1);

// Parties 12 and 13 are deleted and merged, clients 22 to 24 are merged or
// sit on them, so their closed deals stay off the tracker.
const SEED = `
insert into actor (id, slug, kind, display_name)
	values ('${agent}', 'invoices-agent', 'human', 'Example');
insert into contact_state (slug, label, contactable, sort) values ('active', 'Example', true, 1);
insert into deal_type_ref (slug, label, sort) values ('invoices-lease', 'Example', 1);
insert into deal_lane (slug, label, sort) values ('territory', 'Example', 1);
insert into deal_phase (slug, label) values ('closed', 'Example'), ('invoices-open', 'Example');
insert into party (id, kind, name, deleted_at, created_by, updated_by) values
	('${id(11)}', 'org', 'Example Clinic', null, '${agent}', '${agent}'),
	('${id(12)}', 'org', 'Example Gone', now(), '${agent}', '${agent}');
insert into party (id, kind, name, merged_into, created_by, updated_by)
	values ('${id(13)}', 'org', 'Example Twin Clinic', '${id(11)}', '${agent}', '${agent}');
insert into client (id, party_id, merged_into, created_by, updated_by) values
	('${id(21)}', '${id(11)}', null, '${agent}', '${agent}'),
	('${id(22)}', '${id(11)}', '${id(21)}', '${agent}', '${agent}'),
	('${id(23)}', '${id(12)}', null, '${agent}', '${agent}'),
	('${id(24)}', '${id(13)}', null, '${agent}', '${agent}');
insert into deal (id, client_id, name, phase, outcome, closed_on, invoiced_on, owner, lane,
	deal_type, created_by, updated_by)
select v.*, 'invoices-lease', '${agent}'::uuid, '${agent}'::uuid from (values
	('${id(31)}'::uuid, '${id(21)}'::uuid, 'Example Alpha', 'closed', null::text, '2026-08-01'::date, null::date, 'invoices-agent', 'territory'),
	('${id(32)}', '${id(21)}', 'Example Beta', 'closed', 'won', '2026-07-15', '2026-07-20', null, null),
	('${id(33)}', '${id(21)}', 'Example Gamma', 'invoices-open', null, null, '2026-09-30', null, null),
	('${id(34)}', '${id(21)}', 'Example Delta', 'invoices-open', null, null, null, null, null),
	('${id(35)}', '${id(21)}', 'Example Lost', 'closed', 'lost', null, null, null, null),
	('${id(36)}', '${id(21)}', 'Example Paused', 'closed', 'paused', null, null, null, null),
	('${id(37)}', '${id(21)}', 'Example Open', 'invoices-open', null, null, null, null, null),
	('${id(38)}', '${id(22)}', 'Example Merged Client', 'closed', null, null, null, null, null),
	('${id(39)}', '${id(23)}', 'Example Deleted Party', 'closed', null, null, null, null, null),
	('${id(40)}', '${id(24)}', 'Example Merged Party', 'closed', null, null, null, null, null),
	('${id(52)}', '${id(21)}', 'Example Twin', 'closed', null, null, null, null, null),
	('${id(51)}', '${id(21)}', 'Example Twin', 'closed', null, null, null, null, null)
) v;
insert into commission (id, deal_id, gross_amount, status, invoiced_on, received_on, due_on,
	version, created_by)
select v.*, '${agent}'::uuid from (values
	('${id(43)}'::uuid, '${id(32)}'::uuid, 10::numeric, 'expected', null::date, null::date, null::date, 1),
	('${id(44)}', '${id(32)}', 0, 'expected', null, null, null, 1),
	('${id(41)}', '${id(32)}', 999.5, 'invoiced', '2026-09-02', null, null, 3),
	('${id(42)}', '${id(32)}', 1250, 'received', '2026-07-20', '2026-08-10', '2026-08-19', 1),
	('${id(46)}', '${id(34)}', 75, 'expected', null, null, null, 1),
	('${id(45)}', '${id(34)}', 500, 'invoiced', '2026-10-01', null, '2026-10-31', 1)
) v;
`;

type Entry = { deal_id: string; as_of: string };
type Tracker = {
	schema_version: string;
	actor: string;
	entries: Entry[];
	observed_at: string;
};

const deal = (n: number, name: string, fields: object = {}) => ({
	deal_id: id(n),
	name,
	owner: null,
	phase: "closed",
	lane: null,
	outcome: null,
	closed_on: null,
	invoiced_on: null,
	...fields,
});
const commission = (n: number, gross_amount: string, fields: object = {}) => ({
	commission_id: id(n),
	gross_amount,
	status: "expected",
	base_version: 1,
	commission_invoiced_on: null,
	received_on: null,
	due_on: null,
	...fields,
});
const NONE = {
	commission_id: null,
	gross_amount: null,
	status: null,
	base_version: null,
	commission_invoiced_on: null,
	received_on: null,
	due_on: null,
};
// The old answer's key order.
const ENTRY_KEYS = Object.keys({ ...deal(0, ""), ...NONE, as_of: "" });
const beta = deal(32, "Example Beta", {
	outcome: "won",
	closed_on: "2026-07-15",
	invoiced_on: "2026-07-20",
});
const delta = deal(34, "Example Delta", { phase: "invoices-open" });

const get = (url: string, slug: string) =>
	worker.request(
		"https://app.example.test/api/engine/invoices",
		{ headers: { Cookie: "__Host-dealroom_session=made-up-session" } },
		{
			CARR: {
				fetch: async () =>
					Response.json({
						actor: { slug, display: "Example Partner" },
						csrf_token: "made-up-csrf",
					}),
			},
			DATABASE: { connectionString: url },
		},
	);

test("the invoices read answers the old tracker's rows, values and order", () =>
	withSnapshot(async (url) => {
		const seeder = new pg.Client({ connectionString: url });
		await seeder.connect();
		try {
			await seeder.query(SEED);
		} finally {
			await seeder.end();
		}
		const before = new Date().toISOString().slice(0, 10);
		const response = await get(url, "invoices-agent");
		const after = new Date().toISOString().slice(0, 10);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("Cache-Control"), "no-store");
		const body = (await response.json()) as Tracker;
		assert.deepEqual(Object.keys(body), [
			"schema_version",
			"actor",
			"entries",
			"observed_at",
		]);
		assert.equal(body.schema_version, "invoice-tracker.v1");
		assert.equal(body.actor, "invoices-agent");
		assert.match(body.observed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
		const asOf = body.entries[0]?.as_of ?? "";
		assert.ok([before, after].includes(asOf), asOf);
		for (const entry of body.entries) {
			assert.deepEqual(Object.keys(entry), ENTRY_KEYS);
			assert.equal(entry.as_of, asOf);
		}
		const twins = [52, 51].map((n) => ({
			...deal(n, "Example Twin"),
			...NONE,
			as_of: asOf,
		}));
		assert.deepEqual(
			body.entries.slice(0, -2),
			[
				{
					...deal(31, "Example Alpha", {
						owner: "invoices-agent",
						lane: "territory",
						closed_on: "2026-08-01",
					}),
					...NONE,
				},
				{
					...beta,
					...commission(42, "1250.00", {
						status: "received",
						commission_invoiced_on: "2026-07-20",
						received_on: "2026-08-10",
						due_on: "2026-08-19",
					}),
				},
				{
					...beta,
					...commission(41, "999.50", {
						status: "invoiced",
						base_version: 3,
						commission_invoiced_on: "2026-09-02",
					}),
				},
				{ ...beta, ...commission(43, "10.00") },
				{ ...beta, ...commission(44, "0.00") },
				{
					...delta,
					...commission(45, "500.00", {
						status: "invoiced",
						commission_invoiced_on: "2026-10-01",
						due_on: "2026-10-31",
					}),
				},
				{
					...deal(33, "Example Gamma", {
						phase: "invoices-open",
						invoiced_on: "2026-09-30",
					}),
					...NONE,
				},
			].map((entry) => ({ ...entry, as_of: asOf })),
		);
		// The old read has no deal tie-break, so the twins may come either way.
		assert.deepEqual(
			body.entries.slice(-2).sort((a, b) => b.deal_id.localeCompare(a.deal_id)),
			twins,
		);

		const stranger = await get(url, "no-such-partner");
		assert.equal(stranger.status, 422);
		const { correlation_id, ...refusal } = (await stranger.json()) as {
			correlation_id: string;
		};
		assert.match(correlation_id, /^[0-9a-f-]{36}$/);
		assert.deepEqual(refusal, {
			error: "unauthenticated",
			hint: "The authenticated actor could not be resolved.",
		});
	}));
