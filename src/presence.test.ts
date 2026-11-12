import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { withSnapshot } from "../scripts/test-database.ts";
import worker from "./worker.ts";

const PARTNER = "00000000-0000-4000-8000-000000000001";
const CLIENT = "00000000-0000-4000-8000-000000000002";
const DEAL = "00000000-0000-4000-8000-000000000003";
const ORIGIN = "https://app.example.test";

const SEED = `
insert into actor (id, slug, kind, display_name)
	values ('${PARTNER}', 'partner_one', 'human', 'Example Partner');
insert into contact_state (slug, label, contactable, sort) values ('active', 'Example', true, 1);
insert into deal_type_ref (slug, label, sort) values ('presence-lease', 'Example', 1);
insert into deal_phase (slug, label) values ('presence-open', 'Example');
with p as (insert into party (kind, name, created_by, updated_by)
		values ('org', 'Example Clinic', '${PARTNER}', '${PARTNER}') returning id)
insert into client (id, party_id, created_by, updated_by)
	select '${CLIENT}', id, '${PARTNER}', '${PARTNER}' from p;
insert into deal (id, client_id, name, deal_type, phase, created_by, updated_by)
	values ('${DEAL}', '${CLIENT}', 'Example Presence Deal', 'presence-lease',
		'presence-open', '${PARTNER}', '${PARTNER}');
`;

const OLD_UPSERT = `insert into deal_presence_lease (actor_id, deal_id, field, expires_at)
	values ($1, $2, $3, now() + interval '3 seconds')
	on conflict (actor_id, deal_id, field) do update set expires_at = excluded.expires_at
	returning expires_at`;

async function withClient<T>(url: string, run: (db: pg.Client) => Promise<T>) {
	const db = new pg.Client({ connectionString: url });
	await db.connect();
	try {
		return await run(db);
	} finally {
		await db.end();
	}
}

// The old verb's statement, its answer as the old driver printed it, and its
// replay of the stored answer.
const oldPing = (url: string, field: string) =>
	withClient(url, async (db) => {
		await db.query("begin");
		const { rows } = await db.query(OLD_UPSERT, [PARTNER, DEAL, field]);
		const answer = JSON.stringify({
			ok: true,
			deal_id: DEAL,
			field,
			expires_at: rows[0].expires_at,
		});
		const three = await db.query(
			"select expires_at = now() + interval '3 seconds' as exact from deal_presence_lease where field = $1",
			[field],
		);
		const key = randomUUID();
		await db.query(
			"insert into tool_call (idempotency_key, verb, actor_id, request_hash, response) values ($1, 'presence-lease', $2, 'old', $3)",
			[key, PARTNER, answer],
		);
		const stored = await db.query(
			"select response from tool_call where idempotency_key = $1",
			[key],
		);
		await db.query("commit");
		return {
			answer,
			exact: three.rows[0].exact,
			replay: JSON.stringify({ replayed: true, ...stored.rows[0].response }),
		};
	});

const request = (url: string | undefined, body: unknown) =>
	worker.request(
		`${ORIGIN}/api/engine/presence`,
		{
			method: "POST",
			headers: {
				Cookie: "__Host-dealroom_session=made-up-session",
				Origin: ORIGIN,
				"Sec-Fetch-Site": "same-origin",
				"x-carr-csrf": "made-up-csrf",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
		{
			CARR: {
				fetch: async () =>
					Response.json({
						actor: { slug: "partner_one", display: "Example Partner" },
						csrf_token: "made-up-csrf",
					}),
			},
			...(url && { DATABASE_WRITER: { connectionString: url } }),
		},
	);

async function enginePing(url: string, field: string) {
	const idempotency_key = randomUUID();
	const body = { idempotency_key, deal: DEAL, field };
	const response = await request(url, body);
	assert.equal(response.status, 200);
	const answer = await response.text();
	const replay = await (await request(url, body)).text();
	const exact = await withClient(url, async (db) => {
		const { rows } = await db.query(
			`select l.expires_at = t.created_at + interval '3 seconds' as exact
				from deal_presence_lease l, tool_call t
				where l.field = $1 and t.idempotency_key = $2`,
			[field, idempotency_key],
		);
		return rows[0].exact;
	});
	return { answer, exact, replay };
}

const rows = (url: string, query: string) =>
	withClient(url, async (db) => (await db.query(query)).rows);
const leases = (url: string) =>
	rows(
		url,
		"select actor_id, deal_id, field from deal_presence_lease order by field",
	);

// Two pings on one field, then a ping on another: a fresh lease, a renewed one
// and a second row, each with its answer and the replay of that answer.
async function pings(url: string, ping: typeof enginePing) {
	const runs = [];
	for (const field of ["phase", "phase", "owner"]) {
		const { answer, exact, replay } = await ping(url, field);
		assert.equal(exact, true, "the lease expires 3 seconds after its save");
		const { expires_at } = JSON.parse(answer);
		assert.match(expires_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
		runs.push(
			[answer, replay].map((text) => text.replace(expires_at, "<expires>")),
		);
	}
	return { runs, leases: await leases(url) };
}

async function refused(
	response: Response,
	status: number,
	expected: Record<string, unknown>,
) {
	assert.equal(response.status, status);
	const text = await response.text();
	const { correlation_id } = JSON.parse(text);
	const { error, ...rest } = expected;
	assert.equal(text, JSON.stringify({ error, correlation_id, ...rest }));
}

test("a presence ping saves and answers as the old verb did", () =>
	withSnapshot(async (url) => {
		await withClient(url, (db) => db.query(SEED));
		const old = await pings(url, oldPing);
		await withClient(url, (db) =>
			db.query("delete from deal_presence_lease; delete from tool_call"),
		);
		assert.deepEqual(await pings(url, enginePing), old);
		assert.deepEqual(await rows(url, "select id from event"), []);
	}));

test("a presence ping refuses as the old verb did", () =>
	withSnapshot(async (url) => {
		await withClient(url, (db) => db.query(SEED));
		const key = randomUUID();
		const ping = (body: Record<string, unknown>) =>
			request(url, { idempotency_key: key, deal: DEAL, ...body });
		const generic =
			"The operation failed. Quote the correlation_id when reporting it.";
		await refused(await ping({ field: undefined }), 400, {
			error: "missing_required",
			hint: "Supply the named required fields from the tool's documented input.",
			fields: ["field"],
		});
		await refused(await ping({ field: " " }), 400, {
			error: "field_required",
			hint: "Supply the required field using the documented operation shape.",
		});
		await refused(await ping({ field: "phase", deal: randomUUID() }), 404, {
			error: "unhandled_verb_failure",
			hint: generic,
		});
		await refused(await ping({ field: "phase", deal: CLIENT }), 422, {
			error: "not_a_deal",
			hint: "Choose a deal record, not a client or lead.",
		});
		await refused(await ping({ field: "phase", note: "x" }), 400, {
			error: "unregistered_operation_fields",
			hint: "Remove fields outside the documented input.",
			fields: ["note"],
		});
		assert.deepEqual(await leases(url), []);
		assert.equal((await ping({ field: "phase" })).status, 200);
		await refused(await ping({ field: "owner" }), 409, {
			error: "key_reuse",
			hint: "Use a fresh idempotency_key for changed arguments.",
		});
		await refused(
			await request(undefined, {
				idempotency_key: key,
				deal: DEAL,
				field: "phase",
			}),
			503,
			{
				error: "unhandled_verb_failure",
				hint: generic,
				verb: "presence-lease",
			},
		);
	}));

// The writer login's grants from the old job's inventory (#41), plus the two it
// lacks: its own presence line, and reading back a stored answer.
const WRITER_GRANTS = [
	"SELECT ON public.actor, public.v_ref_index, public.deal_presence_lease",
	`INSERT (idempotency_key, verb, actor_id, request_hash, response, via, client_id,
		organization_tenant_id, sponsoring_human_slug, personal_scope,
		authorization_class, correlation_id) ON public.tool_call`,
	"INSERT (actor_id, deal_id, field, expires_at), UPDATE (expires_at) ON public.deal_presence_lease",
	"SELECT (idempotency_key, request_hash, response, created_at) ON public.tool_call",
];

test("a presence ping needs only the writer login's column grants", () =>
	withSnapshot(async (url) => {
		await withClient(url, (db) => db.query(SEED));
		const name = `engine_writer_${randomUUID().replaceAll("-", "")}`;
		await withClient(url, async (admin) => {
			await admin.query(`CREATE ROLE ${name} LOGIN NOINHERIT`);
			try {
				for (const grant of WRITER_GRANTS)
					await admin.query(`GRANT ${grant} TO ${name}`);
				const login = new URL(url);
				login.username = name;
				await pings(login.href, enginePing);
			} finally {
				await admin.query(`DROP OWNED BY ${name}`);
				await admin.query(`DROP ROLE ${name}`);
			}
		});
	}));
