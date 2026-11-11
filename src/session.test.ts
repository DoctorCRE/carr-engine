import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { requireSession, type SessionEnv } from "./session.ts";
import worker from "./worker.ts";

const origin = "https://app.example.test";
const cookie = "__Host-dealroom_session=made-up-session";
const actor = { slug: "test-partner", display: "Test Partner" };
const session = { actor, csrf_token: "made-up-csrf" };
const path = `${origin}/api/engine/whoami`;
const writes = new Hono<SessionEnv>();
writes.use("*", requireSession);
writes.all("*", (c) => c.json(c.get("partner")));

function binding(
	reply: () => Response | Promise<Response> = () => Response.json(session),
) {
	const requests: Request[] = [];
	return {
		requests,
		env: {
			CARR: {
				fetch: async (request: Request) => {
					requests.push(request);
					return reply();
				},
			},
		},
	};
}

function writeHeaders(): Record<string, string> {
	return {
		Cookie: cookie,
		Origin: origin,
		"Sec-Fetch-Site": "same-origin",
		"x-carr-csrf": session.csrf_token,
	};
}

test("signed-in request returns the partner supplied by CARR", async () => {
	const fake = binding();
	const response = await worker.request(
		path,
		{ headers: { Cookie: cookie } },
		fake.env,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), actor);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.equal(fake.requests.length, 1);
});

for (const value of [
	undefined,
	"unrelated=other",
	"__Host-dealroom_session=",
	"__Host-dealroom_session_extra=other",
]) {
	test(`missing session cookie rejects without calling CARR (${value})`, async () => {
		const fake = binding();
		const headers = value === undefined ? {} : { Cookie: value };
		const response = await worker.request(path, { headers }, fake.env);
		assert.equal(response.status, 401);
		assert.deepEqual(await response.json(), { error: "unauthorized" });
		assert.equal(fake.requests.length, 0);
	});
}

for (const status of [401, 302, 500]) {
	test(`CARR status ${status} never reaches a protected handler`, async () => {
		const fake = binding(() => new Response("upstream", { status }));
		const response = await worker.request(
			path,
			{ headers: { Cookie: cookie } },
			fake.env,
		);
		assert.equal(response.status, status === 401 ? 401 : 503);
		assert.deepEqual(await response.json(), {
			error: status === 401 ? "unauthorized" : "sign_in_unavailable",
		});
	});
}

test("a thrown CARR error is sign-in unavailable", async () => {
	const fake = binding(() => {
		throw new Error("binding unavailable");
	});
	const response = await worker.request(
		path,
		{ headers: { Cookie: cookie } },
		fake.env,
	);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "sign_in_unavailable" });
});

for (const body of [
	null,
	[],
	{},
	{ ...session, actor: null },
	{ ...session, actor: { display: "Test Partner" } },
	{ ...session, actor: { ...actor, slug: 2 } },
	{ ...session, actor: { ...actor, slug: " " } },
	{ ...session, actor: { ...actor, display: "" } },
	{ ...session, actor: { ...actor, display: false } },
	{ actor },
	{ ...session, csrf_token: "" },
	{ ...session, csrf_token: 2 },
]) {
	test(`malformed session fails closed (${JSON.stringify(body)})`, async () => {
		const fake = binding(() => Response.json(body));
		const response = await worker.request(
			path,
			{ headers: { Cookie: cookie } },
			fake.env,
		);
		assert.equal(response.status, 503);
		assert.deepEqual(await response.json(), { error: "sign_in_unavailable" });
	});
}

test("invalid JSON fails closed", async () => {
	const fake = binding(() => new Response("not json"));
	const response = await worker.request(
		path,
		{ headers: { Cookie: cookie } },
		fake.env,
	);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "sign_in_unavailable" });
});

for (const status of [200, 401, 500]) {
	test(`all refreshed cookies pass back on CARR status ${status}`, async () => {
		const cookies = [
			"__Host-dealroom_session=renewed; Path=/; Secure; HttpOnly",
			"other=cleared; Max-Age=0; Path=/",
		];
		const headers = new Headers();
		for (const value of cookies) headers.append("Set-Cookie", value);
		const fake = binding(() => Response.json(session, { status, headers }));
		const response = await worker.request(
			path,
			{ headers: { Cookie: cookie } },
			fake.env,
		);
		assert.deepEqual(response.headers.getSetCookie(), cookies);
	});
}

test("validation preserves browser origin and host and sends only the session cookie", async () => {
	const fake = binding();
	const response = await worker.request(
		`${path}?private=value`,
		{
			headers: {
				Cookie: `tracking=other; ${cookie}; __Host-dealroom_oauth=pending`,
				Origin: origin,
				Authorization: "Bearer made-up",
				"x-partner": "forged",
				"x-carr-csrf": "forged",
				Host: "forged.example.test",
			},
		},
		fake.env,
	);
	assert.equal(response.status, 200);
	const request = fake.requests[0];
	assert.ok(request);
	assert.equal(request.url, `${origin}/auth/session`);
	assert.equal(request.method, "GET");
	assert.equal(request.redirect, "manual");
	assert.deepEqual(Object.fromEntries(request.headers), {
		cookie,
		host: "app.example.test",
		origin,
	});
	assert.deepEqual(await response.json(), actor);
});

for (const [name, header, value] of [
	["missing CSRF", "x-carr-csrf", null],
	["wrong CSRF", "x-carr-csrf", "wrong"],
	["same-length wrong CSRF", "x-carr-csrf", "made-up-csrg"],
	["wrong origin", "Origin", "https://other.example.test"],
	["missing origin", "Origin", null],
	["missing metadata", "Sec-Fetch-Site", null],
	["wrong metadata", "Sec-Fetch-Site", "same-site"],
] satisfies [string, string, string | null][]) {
	test(`write rejects ${name}`, async () => {
		const headers = writeHeaders();
		if (value === null) delete headers[header];
		else headers[header] = value;
		const response = await writes.request(
			path,
			{ method: "POST", headers },
			binding().env,
		);
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: "forbidden" });
	});
}

for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
	test(`${method} with all write guards reaches the partner handler`, async () => {
		const response = await writes.request(
			path,
			{ method, headers: writeHeaders() },
			binding().env,
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), actor);
	});
	test(`${method} cannot omit the CSRF header`, async () => {
		const headers = writeHeaders();
		delete headers["x-carr-csrf"];
		const response = await writes.request(
			path,
			{ method, headers },
			binding().env,
		);
		assert.equal(response.status, 403);
	});
}

for (const method of ["GET", "HEAD"]) {
	test(`${method} does not require write guards`, async () => {
		const response = await writes.request(
			path,
			{ method, headers: { Cookie: cookie } },
			binding().env,
		);
		assert.equal(response.status, 200);
	});
}

for (const status of [403, 503]) {
	test(`refreshed cookie survives an engine rejection with ${status}`, async () => {
		const refreshed =
			"__Host-dealroom_session=renewed; Path=/; Secure; HttpOnly";
		const fake = binding(() =>
			Response.json(status === 503 ? {} : session, {
				headers: { "Set-Cookie": refreshed },
			}),
		);
		const headers = writeHeaders();
		delete headers["x-carr-csrf"];
		const response = await writes.request(
			path,
			{ method: "POST", headers },
			fake.env,
		);
		assert.equal(response.status, status);
		assert.deepEqual(response.headers.getSetCookie(), [refreshed]);
	});
}
