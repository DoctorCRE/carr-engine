import assert from "node:assert/strict";
import { test } from "node:test";
import app from "./worker.ts";

test("GET /health returns ok", async () => {
	const res = await app.request("/health");
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true });
});

test("an unknown path returns 404", async () => {
	const res = await app.request("/nope");
	assert.equal(res.status, 404);
});
