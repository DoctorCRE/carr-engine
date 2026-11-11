import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { format } from "node:util";
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
const warnings = mock.method(console, "warn", () => {});
beforeEach(() => warnings.mock.resetCalls());

function binding(
	reply: (request: Request) => Response | Promise<Response> = () =>
		Response.json(session),
) {
	const requests: Request[] = [];
	return {
		requests,
		env: {
			CARR: {
				fetch: async (request: Request) => {
					requests.push(request);
					return reply(request);
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
		assert.equal(response.headers.get("Cache-Control"), "no-store");
		assert.equal(fake.requests.length, 0);
		assert.equal(warnings.mock.callCount(), 0);
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
		assert.equal(response.headers.get("Cache-Control"), "no-store");
		assert.equal(warnings.mock.callCount(), status === 401 ? 0 : 1);
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

function onAbort(signal: AbortSignal, fail: (reason: unknown) => void) {
	if (signal.aborted) fail(signal.reason);
	signal.addEventListener("abort", () => fail(signal.reason));
}

for (const [name, reply] of [
	[
		"never answers",
		({ signal }) => new Promise((_, reject) => onAbort(signal, reject)),
	],
	[
		"stalls in the body",
		({ signal }) =>
			new Response(
				new ReadableStream({
					start: (controller) => onAbort(signal, (e) => controller.error(e)),
				}),
			),
	],
] satisfies [string, (request: Request) => Response | Promise<Response>][]) {
	test(`CARR that ${name} is sign-in unavailable at the time limit`, {
		timeout: 1000,
	}, async (t) => {
		const limits: number[] = [];
		t.mock.method(AbortSignal, "timeout", (ms: number) => {
			limits.push(ms);
			return AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
		});
		const response = await worker.request(
			path,
			{ headers: { Cookie: cookie } },
			binding(reply).env,
		);
		assert.equal(response.status, 503);
		assert.deepEqual(await response.json(), { error: "sign_in_unavailable" });
		assert.deepEqual(limits, [3000]);
		assert.equal(warnings.mock.callCount(), 1);
		assert.equal(
			format(...(warnings.mock.calls[0]?.arguments ?? [])),
			"sign-in check unavailable: TimeoutError",
		);
	});
}

for (const [kind, reply] of [
	["status 500", () => new Response(cookie, { status: 500 })],
	[
		"Error",
		() => {
			throw new Error(cookie);
		},
	],
	["malformed", () => Response.json({ ...session, csrf_token: "" })],
	["malformed", () => new Response(cookie)],
	[
		"unknown",
		() => {
			const error = new Error("made-up failure");
			error.name = cookie;
			throw error;
		},
	],
] satisfies [string, () => Response][]) {
	test(`CARR failure logs only its kind (${kind})`, async () => {
		const response = await worker.request(
			path,
			{ headers: { Cookie: cookie } },
			binding(reply).env,
		);
		assert.equal(response.status, 503);
		assert.equal(warnings.mock.callCount(), 1);
		const logged = format(...(warnings.mock.calls[0]?.arguments ?? []));
		assert.ok(logged.includes(kind));
		for (const secret of ["made-up-session", "made-up-csrf", actor.slug])
			assert.ok(!logged.includes(secret), `${secret} was logged`);
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
		assert.equal(response.headers.get("Cache-Control"), "no-store");
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

test("a plain Response from a protected handler keeps no-store and the renewed cookie", async () => {
	const refreshed = "__Host-dealroom_session=renewed; Path=/; Secure; HttpOnly";
	const app = new Hono<SessionEnv>();
	app.use("*", requireSession);
	app.get("*", () => new Response("plain", { headers: { "x-own": "kept" } }));
	const response = await app.request(
		path,
		{ headers: { Cookie: cookie } },
		binding(() =>
			Response.json(session, { headers: { "Set-Cookie": refreshed } }),
		).env,
	);
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "plain");
	assert.equal(response.headers.get("x-own"), "kept");
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.deepEqual(response.headers.getSetCookie(), [refreshed]);
});

test("a protected handler that throws stays a server error", async (t) => {
	t.mock.method(console, "error", () => {});
	const app = new Hono<SessionEnv>();
	app.use("*", requireSession);
	app.get("*", () => {
		throw new Error("handler failed");
	});
	const response = await app.request(
		path,
		{ headers: { Cookie: cookie } },
		binding().env,
	);
	assert.equal(response.status, 500);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.equal(warnings.mock.callCount(), 0);
});

test("an error inside the sign-in check still carries no-store", async (t) => {
	t.mock.method(console, "error", () => {});
	const broken = {
		headers: new Headers(),
		get status(): number {
			throw new Error("made-up failure");
		},
	};
	const response = await writes.request(
		path,
		{ headers: { Cookie: cookie } },
		binding(() => broken as Response).env,
	);
	assert.equal(response.status, 500);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
});
