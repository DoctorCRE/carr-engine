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
