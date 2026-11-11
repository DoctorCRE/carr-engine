import assert from "node:assert/strict";
import { test } from "node:test";
import { readSettings } from "./settings.ts";

const base = {
	COMPARE_APP_URL: "https://app.example.test",
	COMPARE_SESSION: "made-up-session",
};

test("runs only against a named target, and production needs a read-only acknowledgement", () => {
	assert.throws(
		() => readSettings(base),
		/COMPARE_TARGET to staging or production/,
	);
	assert.throws(
		() => readSettings({ ...base, COMPARE_TARGET: "local" }),
		/COMPARE_TARGET/,
	);
	assert.equal(
		readSettings({ ...base, COMPARE_TARGET: "staging" }).target,
		"staging",
	);
	assert.throws(
		() => readSettings({ ...base, COMPARE_TARGET: "production" }),
		/COMPARE_CONFIRM_PRODUCTION=read-only/,
	);
	assert.throws(
		() =>
			readSettings({
				...base,
				COMPARE_TARGET: "production",
				COMPARE_CONFIRM_PRODUCTION: "yes",
			}),
		/COMPARE_CONFIRM_PRODUCTION/,
	);
	const production = readSettings({
		...base,
		COMPARE_TARGET: "production",
		COMPARE_CONFIRM_PRODUCTION: "read-only",
	});
	assert.equal(production.target, "production");
});

test("needs a session and https URLs, and never echoes a setting's value", () => {
	const staging = { ...base, COMPARE_TARGET: "staging" };
	assert.throws(
		() => readSettings({ ...staging, COMPARE_SESSION: "" }),
		/COMPARE_SESSION/,
	);
	for (const value of ["http://app.example.test", "not a url secretmarker"])
		assert.throws(
			() => readSettings({ ...staging, COMPARE_APP_URL: value }),
			(error: Error) =>
				/COMPARE_APP_URL/.test(error.message) && !error.message.includes(value),
		);
});

test("reads the old system and the engine through the one app URL", () => {
	const settings = readSettings({
		COMPARE_TARGET: "staging",
		COMPARE_APP_URL: "https://app.example.test",
		COMPARE_ENGINE_URL: "https://engine.example.test",
		COMPARE_SESSION: "made-up-session",
	});
	assert.deepEqual(Object.keys(settings).sort(), ["app", "session", "target"]);
	assert.equal(settings.app.origin, "https://app.example.test");
});

test("the app URL is an origin, with no path, query or fragment", () => {
	const staging = { ...base, COMPARE_TARGET: "staging" };
	assert.equal(
		readSettings({ ...staging, COMPARE_APP_URL: "https://app.example.test/" })
			.app.href,
		"https://app.example.test/",
	);
	for (const value of [
		"https://app.example.test/secretmarker",
		"https://app.example.test/?secretmarker=1",
		"https://app.example.test/#secretmarker",
		"https://secretmarker@app.example.test/",
	])
		assert.throws(
			() => readSettings({ ...staging, COMPARE_APP_URL: value }),
			(error: Error) =>
				/COMPARE_APP_URL/.test(error.message) &&
				!error.message.includes("secretmarker"),
		);
});

test("the session is one cookie value, so a pasted value cannot add cookies", () => {
	const staging = { ...base, COMPARE_TARGET: "staging" };
	assert.equal(
		readSettings({ ...staging, COMPARE_SESSION: "made-up.Session_9~+/=" })
			.session,
		"made-up.Session_9~+/=",
	);
	for (const value of [
		"secretmarker; other=1",
		"secretmarker,other=1",
		"secret marker",
		"secretmarker\t",
		"secretmarker\n",
		"secretmarker\x00",
		"secretmarker\x7f",
		'"secretmarker"',
		"secret\\marker",
	])
		assert.throws(
			() => readSettings({ ...staging, COMPARE_SESSION: value }),
			(error: Error) =>
				/COMPARE_SESSION/.test(error.message) &&
				!error.message.includes("secretmarker"),
		);
});
