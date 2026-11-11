import { report } from "../src/compare/report.ts";
import { type Ask, compareDeals, exitCode } from "../src/compare/run.ts";
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
const { engine, old, session } = settings;
const cookie = `__Host-dealroom_session=${session}`;
const timeout = () => AbortSignal.timeout(30_000);

async function askEngine(ask: Ask): Promise<unknown> {
	const path =
		ask.read === "board"
			? `/api/engine/deals/board?workspace=${ask.workspace}`
			: `/api/engine/deals/${encodeURIComponent(ask.deal)}`;
	const response = await fetch(new URL(path, engine), {
		headers: { accept: "application/json", cookie },
		redirect: "manual",
		signal: timeout(),
	});
	if (response.status !== 200) throw new Error("engine fetch failed");
	return response.json();
}

let rpcId = 0;
async function askOld(ask: Ask): Promise<unknown> {
	const call =
		ask.read === "board"
			? { name: "deal-room-board", arguments: { workspace: ask.workspace } }
			: { name: "get-deal-room", arguments: { deal: ask.deal } };
	const response = await fetch(new URL("/mcp", old), {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			cookie,
			origin: old.origin,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: ++rpcId,
			method: "tools/call",
			params: call,
		}),
		redirect: "manual",
		signal: timeout(),
	});
	if (response.status !== 200) throw new Error("old fetch failed");
	const body = await response.text();
	const stream = response.headers
		.get("content-type")
		?.includes("text/event-stream");
	const message = JSON.parse(
		stream
			? (body
					.split("\n")
					.findLast((line) => line.startsWith("data:"))
					?.slice(5) ?? "")
			: body,
	);
	return JSON.parse(message.result.content[0].text);
}

try {
	const run = await compareDeals(
		askEngine,
		askOld,
		() => new Promise((resolve) => setTimeout(resolve, 1000)),
	);
	process.stdout.write(report(settings.target, run));
	process.exitCode = exitCode(run);
} catch {
	console.error(
		"The comparison failed. Details are not printed because they can hold record content.",
	);
	process.exitCode = 2;
}
