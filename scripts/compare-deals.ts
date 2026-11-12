import { askers, pause } from "../src/compare/ask.ts";
import { report } from "../src/compare/report.ts";
import { compareReads, exitCode } from "../src/compare/run.ts";
import { readSettings, SettingsError } from "../src/compare/settings.ts";

let settings: ReturnType<typeof readSettings>;
try {
	settings = readSettings(process.env);
} catch (error) {
	console.error(
		error instanceof SettingsError
			? error.message
			: "Settings could not be read.",
	);
	process.exit(2);
}
const { askEngine, askOld } = askers(settings.app, settings.session, fetch);

try {
	const run = await compareReads(askEngine, askOld, pause);
	process.stdout.write(report(settings.target, run));
	process.exitCode = exitCode(run);
} catch {
	console.error(
		"The comparison failed. Details are not printed because they can hold record content.",
	);
	process.exitCode = 2;
}
