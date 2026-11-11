import assert from "node:assert/strict";
import { test } from "node:test";
import { readSettings } from "./settings.ts";

const base = {
	COMPARE_ENGINE_URL: "https://engine.example.test",
	COMPARE_OLD_URL: "https://old.example.test",
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
	for (const value of ["http://old.example.test", "not a url secretmarker"])
		assert.throws(
			() => readSettings({ ...staging, COMPARE_OLD_URL: value }),
			(error: Error) =>
				/COMPARE_OLD_URL/.test(error.message) && !error.message.includes(value),
		);
});
