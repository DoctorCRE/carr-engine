import { type Ask, StopRun } from "./run.ts";

type Fetch = (url: URL, init: RequestInit) => Promise<Response>;

const REFUSALS = new Set([400, 404, 409, 422]);

// The old system allows a session 60 calls a minute, and each ask makes one.
export const pause = () =>
	new Promise<void>((resolve) => setTimeout(resolve, 1500));

function refusal(ask: Ask, body: unknown) {
	// A board for a listed workspace has no refusal to compare. Comparing one
	// would match two empty boards and ask no deals.
	if (ask.read === "board") throw new Error("board refused");
	if (typeof body !== "object" || body === null || !("error" in body))
		throw new Error("refusal without an error");
	const { correlation_id: _, ...rest } = body as Record<string, unknown>;
	return rest;
}

function lastData(stream: string) {
	const line = stream.split("\n").findLast((l) => l.startsWith("data:"));
	if (line === undefined) throw new Error("event stream without data");
	return line.slice(5);
}

export function askers(app: URL, session: string, fetch: Fetch) {
	const cookie = `__Host-dealroom_session=${session}`;

	async function send(path: string, init: RequestInit) {
		let response: Response;
		try {
			response = await fetch(new URL(path, app), {
				...init,
				headers: { ...init.headers, cookie },
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
		} catch {
			throw new StopRun("network failure");
		}
		const { status } = response;
		if (status === 401 || status === 403 || (status >= 300 && status < 400))
			throw new StopRun("not signed in");
		return response;
	}

	async function askEngine(ask: Ask): Promise<unknown> {
		const path =
			ask.read === "board"
				? `/api/engine/deals?${new URLSearchParams({ workspace: ask.workspace })}`
				: `/api/engine/deals/${encodeURIComponent(ask.deal)}`;
		const response = await send(path, {
			headers: { accept: "application/json" },
		});
		if (response.status === 200) return response.json();
		if (REFUSALS.has(response.status))
			return refusal(ask, await response.json());
		throw new Error("engine read failed");
	}

	let rpcId = 0;
	async function askOld(ask: Ask): Promise<unknown> {
		const params =
			ask.read === "board"
				? { name: "deal-room-board", arguments: { workspace: ask.workspace } }
				: { name: "get-deal-room", arguments: { deal: ask.deal } };
		const response = await send("/mcp", {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				origin: app.origin,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: ++rpcId,
				method: "tools/call",
				params,
			}),
		});
		if (response.status !== 200) throw new Error("old read failed");
		const text = await response.text();
		const stream = response.headers
			.get("content-type")
			?.includes("text/event-stream");
		const { result } = JSON.parse(stream ? lastData(text) : text);
		const body = JSON.parse(result.content[0].text);
		return result.isError === true ? refusal(ask, body) : body;
	}

	return { askEngine, askOld };
}
