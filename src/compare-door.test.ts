import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import app from "./worker.ts";

const TEAM = "https://example.cloudflareaccess.com";
const AUD = "made-up-audience";
const access = await generateKeyPair("RS256", { extractable: true });
const stranger = await generateKeyPair("RS256");

before(() => {
	mock.method(globalThis, "fetch", async (url: string) => {
		assert.equal(url, `${TEAM}/cdn-cgi/access/certs`);
		const key = await exportJWK(access.publicKey);
		return Response.json({ keys: [{ ...key, kid: "made-up-kid" }] });
	});
});
after(() => mock.restoreAll());

type Claims = { iss?: string; aud?: string; exp?: number };
const token = (claims: Claims = {}, key: CryptoKey = access.privateKey) =>
	new SignJWT({})
		.setProtectedHeader({ alg: "RS256", kid: "made-up-kid" })
		.setIssuer(claims.iss ?? TEAM)
		.setAudience(claims.aud ?? AUD)
		.setExpirationTime(claims.exp ?? "5 minutes")
		.sign(key);

type Asked = { partner: string; request: Request };
function oldSide(answer = () => Response.json({ ok: true })) {
	const asked: Asked[] = [];
	const CARR_READS = {
		read: async (partner: string, request: Request) => {
			asked.push({ partner, request });
			return answer();
		},
	};
	return {
		asked,
		env: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, CARR_READS },
	};
}

const ask = async (
	path: string,
	env: object,
	init: {
		method?: string;
		jwt?: string;
		headers?: Record<string, string>;
	} = {},
) =>
	app.request(
		`https://engine.example.test/compare/${path}`,
		{
			method: init.method ?? "GET",
			headers: {
				...init.headers,
				...(init.jwt !== "" && {
					"Cf-Access-Jwt-Assertion": init.jwt ?? (await token()),
				}),
			},
		},
		env,
	);

test("a missing, forged, misdirected or expired token is refused", async () => {
	const { asked, env } = oldSide();
	const now = Math.floor(Date.now() / 1000);
	for (const [label, jwt] of [
		["missing", ""],
		["malformed", "not-a-token"],
		["bad signature", await token({}, stranger.privateKey)],
		["wrong audience", await token({ aud: "another-audience" })],
		[
			"wrong issuer",
			await token({ iss: "https://other.cloudflareaccess.com" }),
		],
		["expired", await token({ exp: now - 60 })],
	] as const) {
		const response = await ask("joe/old/pipeline/changes", env, {
			jwt,
			headers: { Cookie: "__Host-dealroom_session=made-up-session" },
		});
		assert.deepEqual(
			[response.status, await response.json()],
			[401, { error: "unauthorized" }],
			label,
		);
	}
	assert.equal(asked.length, 0);
});

test("the door stays shut until Access is configured", async () => {
	const { asked, env } = oldSide();
	for (const config of [
		{ ACCESS_AUD: "" },
		{ ACCESS_TEAM_DOMAIN: "" },
		{ ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com" },
		{ ACCESS_TEAM_DOMAIN: "http://example.cloudflareaccess.com" },
	]) {
		const response = await ask("joe/old/pipeline/changes", {
			...env,
			...config,
		});
		assert.deepEqual(
			[response.status, await response.json()],
			[503, { error: "compare_unconfigured" }],
			JSON.stringify(config),
		);
	}
	assert.equal(asked.length, 0);
});

test("no answer from the door may be cached", async () => {
	const { env } = oldSide();
	for (const [path, init] of [
		["joe/engine/whoami", {}],
		["joe/old/mcp/find", {}],
		["joe/engine/whoami", { jwt: "" }],
		["joe/engine/whoami", { method: "POST" }],
		["bob/engine/whoami", {}],
	] as const) {
		const response = await ask(path, env, init);
		assert.equal(
			response.headers.get("cache-control"),
			"no-store",
			`${path} ${response.status}`,
		);
	}
	const unconfigured = await ask("joe/engine/whoami", {
		...env,
		ACCESS_AUD: "",
	});
	assert.equal(unconfigured.headers.get("cache-control"), "no-store");
});

test("only GET is answered", async () => {
	const { asked, env } = oldSide();
	for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
		const response = await ask("joe/engine/presence", env, { method });
		assert.equal(response.status, 405, method);
	}
	assert.equal(asked.length, 0);
});

test("only the two partners are answered for", async () => {
	const { asked, env } = oldSide();
	for (const path of [
		"bob/engine/whoami",
		"j%6fe/old/pipeline/changes",
		"engine/whoami",
	]) {
		const response = await ask(path, env);
		assert.deepEqual(
			[response.status, await response.json()],
			[400, { error: "unknown_partner" }],
			path,
		);
	}
	assert.equal(asked.length, 0);
});

test("the engine answers its own routes as the named partner", async () => {
	const { env } = oldSide();
	const response = await ask("dell/engine/whoami", env);
	assert.deepEqual(await response.json(), { slug: "dell", display: "dell" });
	const refused = await ask("dell/engine/deals?workspace=made-up", env);
	assert.match(await refused.text(), /"value_not_in_declared_vocabulary"/);
});

test("a tool read reaches the old door as a fresh JSON-RPC call", async () => {
	const { asked, env } = oldSide();
	const args = { workspace: "made-up", limit: 25 };
	const response = await ask(
		`joe/old/mcp/deal-room-board?arguments=${encodeURIComponent(JSON.stringify(args))}`,
		env,
		{ headers: { Origin: "https://app.example.test", Cookie: "made-up=1" } },
	);
	assert.equal(response.status, 200);
	const [sent] = asked;
	assert.ok(sent);
	assert.equal(sent.partner, "joe");
	assert.equal(sent.request.method, "POST");
	assert.equal(sent.request.url, "https://engine.example.test/mcp");
	assert.deepEqual([...sent.request.headers.keys()].sort(), [
		"accept",
		"content-type",
	]);
	assert.deepEqual(await sent.request.json(), {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: "deal-room-board", arguments: args },
	});
});

test("tool arguments must be a JSON object", async () => {
	const { asked, env } = oldSide();
	for (const text of ["[]", "null", "{"]) {
		const response = await ask(
			`joe/old/mcp/find?arguments=${encodeURIComponent(text)}`,
			env,
		);
		assert.equal(response.status, 400, text);
	}
	assert.equal(asked.length, 0);
});

test("a business or feed read reaches the old door at its own address", async () => {
	const { asked, env } = oldSide();
	for (const path of [
		"/api/v1/business/clients?contract=made-up.v1",
		"/pipeline/changes?cursor=made-up",
	]) {
		await ask(`dell/old${path}`, env, {
			headers: { Origin: "https://app.example.test" },
		});
	}
	assert.deepEqual(
		asked.map(({ partner, request }) => [
			partner,
			request.method,
			request.url,
			[...request.headers.keys()],
		]),
		[
			[
				"dell",
				"GET",
				"https://engine.example.test/api/v1/business/clients?contract=made-up.v1",
				[],
			],
			[
				"dell",
				"GET",
				"https://engine.example.test/pipeline/changes?cursor=made-up",
				[],
			],
		],
	);
});

test("the old door's rate limit passes through unchanged", async () => {
	const { env } = oldSide(
		() =>
			new Response("made-up limit", {
				status: 429,
				headers: { "retry-after": "60" },
			}),
	);
	const response = await ask("joe/old/mcp/find", env);
	assert.deepEqual(
		[
			response.status,
			response.headers.get("retry-after"),
			await response.text(),
		],
		[429, "60", "made-up limit"],
	);
});
