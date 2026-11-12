import assert from "node:assert/strict";
import { mock, test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../../scripts/test-database.ts";
import worker from "../worker.ts";

const PARTNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const DEAL = "00000000-0000-4000-8000-000000000003";
const eventId = (n: number) =>
	`00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const sessionId = (n: number) =>
	`00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
const cursorOf = (value: unknown) =>
	Buffer.from(JSON.stringify(value)).toString("base64url");

// Pairs of events share a time and were inserted newest first, so only the id
// orders them. Placeholder and non-deal events sit inside the first page.
const SEED = `
insert into actor (id, slug, kind, display_name) values
	('${PARTNER}', 'feed-b', 'human', 'Example B'),
	('${OTHER}', 'feed-a', 'human', 'Example A');
insert into contact_state (slug, label, contactable, sort) values ('active', 'Example', true, 1);
insert into deal_type_ref (slug, label, sort) values ('feed-lease', 'Example', 1);
insert into deal_phase (slug, label) values ('feed-open', 'Example');
with p as (insert into party (kind, name, created_by, updated_by)
		values ('org', 'Example Clinic', '${PARTNER}', '${PARTNER}') returning id),
	c as (insert into client (party_id, created_by, updated_by)
		select id, '${PARTNER}', '${PARTNER}' from p returning id)
insert into deal (id, client_id, name, deal_type, phase, created_by, updated_by)
	select '${DEAL}', id, 'Example Feed Deal', 'feed-lease', 'feed-open', '${PARTNER}', '${PARTNER}' from c;
insert into event (id, recorded_at, occurred_at, actor_id, verb, subject_type, subject_id, cause, field, new_value)
	select ('00000000-0000-4000-9000-' || lpad(n::text, 12, '0'))::uuid,
		'2030-01-01T00:00:00Z'::timestamptz + (n / 2) * interval '1 second',
		'2030-01-01T00:00:00Z', '${PARTNER}', 'example-verb', 'deal', '${DEAL}', 'system',
		'phase',
		case when n = 1 then '{"sf_close_date_placeholder": 4, "phase": "b",
			"nested": [{"sf_commission_placeholder": 1, "kept": 2}]}'::jsonb end
	from generate_series(203, 1, -1) n;
insert into event (recorded_at, occurred_at, actor_id, verb, subject_type, subject_id, cause, field)
	values ('2030-01-01T00:00:05Z', '2030-01-01T00:00:00Z', '${PARTNER}', 'example-verb', 'deal', '${DEAL}', 'system', 'sf_close_date_placeholder'),
		('2030-01-01T00:00:05Z', '2030-01-01T00:00:00Z', '${PARTNER}', 'example-verb', 'lead', '${DEAL}', 'system', 'phase');
insert into deal_presence_lease (actor_id, deal_id, field, expires_at) values
	('${PARTNER}', '${DEAL}', 'phase', '2099-01-01T00:00:00Z'),
	('${OTHER}', '${DEAL}', 'owner', '2099-01-01T00:00:00Z'),
	('${OTHER}', '${DEAL}', 'attention', '2099-01-01T00:00:00.5Z'),
	('${OTHER}', '${DEAL}', 'next_date', '2000-01-01T00:00:00Z');
insert into capture_session (id, nonce, device_id, actor_id, mode, started_at,
		consent_announced_at, session_token_hash, expires_at, state, state_at)
	select ('00000000-0000-4000-a000-' || lpad(n::text, 12, '0'))::uuid, 'nonce-' || n,
		'device-' || n, '${PARTNER}', 'meeting', started, started, 'hash-' || n,
		expires, 'recording', started + interval '1 minute'
	from (values (1, '2030-01-03T00:00:00Z'::timestamptz, '2099-01-01T00:00:00Z'::timestamptz),
		(2, '2030-01-02T00:00:00Z', '2099-01-01T00:00:00Z'),
		(3, '2030-01-02T00:00:00Z', '2099-01-01T00:00:00Z'),
		(4, '2030-01-01T00:00:00Z', '2000-01-01T00:00:00Z')) s(n, started, expires)
	order by n desc;
`;

const signedIn = {
	fetch: async () =>
		Response.json({
			actor: { slug: "feed-b", display: "Example Partner" },
			csrf_token: "made-up-csrf",
		}),
};
const cookie = "__Host-dealroom_session=made-up-session";
// biome-ignore lint/suspicious/noExplicitAny: test bodies are read loosely
const json = (response: Response): Promise<any> => response.json();
const feed = (
	query: string,
	env: Record<string, unknown>,
	init: RequestInit = { headers: { Cookie: cookie } },
) =>
	worker.request(
		`https://app.example.test/api/engine/pipeline/changes${query}`,
		init,
		{ CARR: signedIn, ...env },
	);

test("the change feed pages events and lists live presence and capture sessions", () =>
	withSnapshot(async (url) => {
		const client = new pg.Client({ connectionString: url });
		await client.connect();
		await client.query(SEED).finally(() => client.end());
		const env = { DATABASE: { connectionString: url } };
		const page = async (query: string) => {
			const response = await feed(query, env);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("Cache-Control"), "no-store");
			return json(response);
		};

		const first = await page("");
		assert.deepEqual(
			first.events.map((e: { id: string }) => e.id),
			Array.from({ length: 200 }, (_, i) => eventId(i + 1)),
		);
		assert.equal(
			JSON.stringify(first.events[0]),
			`{"id":"${eventId(1)}","recorded_at":"2030-01-01T00:00:00+00:00","actor":"feed-b","verb":"example-verb","subject_type":"deal","subject_id":"${DEAL}","field":"phase","old_value":null,"new_value":{"phase":"b","nested":[{"kept":2}]}}`,
		);
		const firstCursor = cursorOf({
			recorded_at: "2030-01-01T00:01:40+00:00",
			id: eventId(200),
		});
		assert.equal(first.cursor, firstCursor);
		assert.deepEqual(await page("?cursor="), first);

		const second = await page(`?cursor=${firstCursor}`);
		assert.deepEqual(
			second.events.map((e: { id: string }) => e.id),
			[eventId(201), eventId(202), eventId(203)],
		);
		const lastCursor = cursorOf({
			recorded_at: "2030-01-01T00:01:41+00:00",
			id: eventId(203),
		});
		assert.equal(second.cursor, lastCursor);

		const caughtUp = await feed(`?cursor=${lastCursor}`, env);
		assert.equal(
			await caughtUp.text(),
			`{"events":[],"presence":[{"actor":"feed-a","deal_id":"${DEAL}","field":"attention","expires_at":"2099-01-01T00:00:00.5+00:00"},{"actor":"feed-a","deal_id":"${DEAL}","field":"owner","expires_at":"2099-01-01T00:00:00+00:00"},{"actor":"feed-b","deal_id":"${DEAL}","field":"phase","expires_at":"2099-01-01T00:00:00+00:00"}],"capture_sessions":[` +
				[
					[2, "02"],
					[3, "02"],
					[1, "03"],
				]
					.map(
						([n, day]) =>
							`{"session_id":"${sessionId(Number(n))}","device_id":"device-${n}","state":"recording","started_at":"2030-01-${day}T00:00:00+00:00","state_at":"2030-01-${day}T00:01:00+00:00"}`,
					)
					.join(",") +
				`],"cursor":"${lastCursor}"}`,
		);

		// A start cursor from a time and a zero id, here in padded standard base64.
		const start = btoa(
			JSON.stringify({
				recorded_at: new Date("2030-01-01T00:01:40Z").toISOString(),
				id: "00000000-0000-0000-0000-000000000000",
			}),
		);
		assert.deepEqual(
			(await page(`?cursor=${encodeURIComponent(start)}`)).events.map(
				(e: { id: string }) => e.id,
			),
			[200, 201, 202, 203].map(eventId),
		);

		const warnings = mock.method(console, "warn", () => {});
		try {
			const impossible = await feed(
				`?cursor=${cursorOf({ recorded_at: "2030-13-01T00:00:00Z", id: DEAL })}`,
				env,
			);
			assert.equal(impossible.status, 503);
			const { correlation_id, ...body } = await json(impossible);
			assert.match(correlation_id, /^[0-9a-f-]{36}$/);
			assert.deepEqual(body, {
				error: "database_unavailable",
				hint: "The operation failed. Quote the correlation_id when reporting it.",
			});
			assert.equal(warnings.mock.callCount(), 1);
		} finally {
			warnings.mock.restore();
		}
	}));

test("the change feed refuses like the old system", async () => {
	const env = {
		DATABASE: { connectionString: "postgres://made-up@127.0.0.1:1/none" },
	};
	const refused = async (response: Response, status: number, error: string) => {
		assert.equal(response.status, status);
		assert.deepEqual(await response.json(), { error });
	};
	const id = DEAL;
	for (const cursor of [
		"not base64!",
		btoa("not json"),
		btoa("null"),
		cursorOf({ id }),
		cursorOf({ recorded_at: "yesterday", id }),
		cursorOf({ recorded_at: "2030-01-01T00:00:00Z", id: "not-a-uuid" }),
	])
		await refused(
			await feed(`?cursor=${encodeURIComponent(cursor)}`, env),
			400,
			"invalid_cursor",
		);
	await refused(await feed("", env, {}), 401, "unauthorized");
	await refused(await feed("", env, { method: "POST" }), 401, "unauthorized");
	const write = {
		Cookie: cookie,
		Origin: "https://app.example.test",
		"Sec-Fetch-Site": "same-origin",
		"x-carr-csrf": "made-up-csrf",
	};
	await refused(
		await feed("", env, { method: "POST", headers: write }),
		405,
		"method_not_allowed",
	);
	const head = await feed("", env, {
		method: "HEAD",
		headers: { Cookie: cookie },
	});
	assert.equal(head.status, 405);

	const unbound = await feed("", {});
	assert.equal(unbound.status, 503);
	assert.equal((await json(unbound)).error, "database_unavailable");
});
