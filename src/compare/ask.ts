import { type Ask, StopRun } from "./run.ts";

type Fetch = (url: URL, init: RequestInit) => Promise<Response>;
type ToolAsk = Exclude<Ask, { read: "feed" }>;
type FeedPage = { events: unknown[]; cursor: string };

const FEED_PAGE = 200;
// A cursor that never advances would otherwise page forever.
const FEED_PAGES = 25;

const REFUSALS = new Set([400, 404, 409, 422]);

// The old system allows a session 60 calls a minute, and each ask makes one.
export const pause = () =>
	new Promise<void>((resolve) => setTimeout(resolve, 1500));

function refusal(ask: ToolAsk, body: unknown) {
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

const isFeedPage = (body: unknown): body is FeedPage =>
	typeof body === "object" &&
	body !== null &&
	"events" in body &&
	Array.isArray(body.events) &&
	"cursor" in body &&
	typeof body.cursor === "string";

function enginePath(ask: ToolAsk) {
	switch (ask.read) {
		case "board":
			return `/api/engine/deals?${new URLSearchParams({ workspace: ask.workspace })}`;
		case "deal":
			return `/api/engine/deals/${encodeURIComponent(ask.deal)}`;
		case "client fit":
			return "/api/engine/client-fit";
		case "capture queue":
			return "/api/engine/capture-queue";
	}
}

function oldCall(ask: ToolAsk) {
	switch (ask.read) {
		case "board":
			return {
				name: "deal-room-board",
				arguments: { workspace: ask.workspace },
			};
		case "deal":
			return { name: "get-deal-room", arguments: { deal: ask.deal } };
		// The app's first ask, with no filters.
		case "client fit":
			return { name: "ideal-client-profile", arguments: {} };
		case "capture queue":
			return { name: "capture-queue", arguments: {} };
	}
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

	// Presence and capture sessions change between any two requests, so only events and cursors are kept.
	async function readFeed(path: string, start: string) {
		const events: unknown[] = [];
		const cursors: string[] = [];
		let cursor = start;
		for (let page = 0; page < FEED_PAGES; page++) {
			const response = await send(
				`${path}?${new URLSearchParams({ cursor })}`,
				{
					headers: { accept: "application/json" },
				},
			);
			if (response.status !== 200) throw new Error("feed read failed");
			const body: unknown = await response.json();
			if (!isFeedPage(body)) throw new Error("feed page without events");
			events.push(...body.events);
			cursors.push(body.cursor);
			if (body.events.length < FEED_PAGE) return { events, cursors };
			cursor = body.cursor;
		}
		throw new Error("feed did not end");
	}

	async function askEngine(ask: Ask): Promise<unknown> {
		if (ask.read === "feed")
			return readFeed("/api/engine/pipeline/changes", ask.start);
		const response = await send(enginePath(ask), {
			headers: { accept: "application/json" },
		});
		if (response.status === 200) return response.json();
		if (REFUSALS.has(response.status))
			return refusal(ask, await response.json());
		throw new Error("engine read failed");
	}

	let rpcId = 0;
	async function askOld(ask: Ask): Promise<unknown> {
		if (ask.read === "feed") return readFeed("/pipeline/changes", ask.start);
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
				params: oldCall(ask),
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
