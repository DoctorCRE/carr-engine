import assert from "node:assert/strict";
import { test } from "node:test";
import app from "./worker.ts";

test("GET /health reports the deployed version", async () => {
	const env = { CF_VERSION_METADATA: { id: "made-up-version-id" } };
	const res = await app.request("/health", {}, env);
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), {
		ok: true,
		version: "made-up-version-id",
	});
});

test("an unknown path returns 404", async () => {
	const res = await app.request("/nope");
	assert.equal(res.status, 404);
});

const ORIGIN = "https://app.example.test";
const signedIn = {
	CARR: {
		fetch: async () =>
			Response.json({
				actor: { slug: "joe", display: "Example Partner" },
				csrf_token: "made-up-csrf",
			}),
	},
};
const ask = (path: string, method = "GET", env: object = signedIn) =>
	app.request(
		`${ORIGIN}/api/engine/${path}`,
		{
			method,
			headers: {
				Cookie: "__Host-dealroom_session=made-up-session",
				Origin: ORIGIN,
				"Sec-Fetch-Site": "same-origin",
				"x-carr-csrf": "made-up-csrf",
			},
		},
		env,
	);

// The old door matched the raw path, so an encoded address served nothing.
test("a percent-encoded address answers the old not-found body", async () => {
	const uuid = "00000000-0000-4000-8000-000000000001";
	for (const [method, path] of [
		["GET", "%63lients"],
		["GET", `clients/${uuid.slice(0, -1)}%31`],
		["GET", `%76endors/${uuid}`],
		["GET", "%72elationships"],
		["GET", "%64eals"],
		["GET", "deals%2FExample"],
		["GET", "%64eals/Example%20Deal"],
		["GET", "pipeline/%63hanges"],
		["GET", "%66ind?query=Example"],
		["POST", "pre%73ence"],
	]) {
		const response = await ask(path, method);
		assert.deepEqual(
			[response.status, await response.text()],
			[404, '{"error":"not_found"}'],
			`${method} ${path}`,
		);
	}
});

test("a signed-out encoded address is refused before its path is checked", async () => {
	const response = await ask("%63lients", "GET", {
		CARR: { fetch: async () => new Response(null, { status: 401 }) },
	});
	assert.deepEqual(await response.json(), {
		error: "unauthorized",
		state: "sign_in_required",
	});
});
