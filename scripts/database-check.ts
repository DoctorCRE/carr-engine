import { spawnSync } from "node:child_process";
import { NoDatabase, withSnapshot } from "./test-database.ts";

await withSnapshot(async (url) => {
	const env = { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url };
	for (const [command, args] of [
		["npm", ["run", "types:db"]],
		["npm", ["run", "types"]],
		["npm", ["run", "test"]],
	] as const) {
		const result = spawnSync(command, args, { env, stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`${command} failed`);
	}
}).catch((error: unknown) => {
	if (!(error instanceof NoDatabase)) throw error;
	console.error(error.message);
	process.exitCode = 1;
});
