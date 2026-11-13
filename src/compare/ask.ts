import { isRecord } from "./answers.ts";
import { type Ask, StopRun } from "./run.ts";

type Fetch = (url: URL, init: RequestInit) => Promise<Response>;
type ToolAsk = Exclude<Ask, { read: "feed" }>;
type FeedPage = { events: unknown[]; cursor: string };
// The old system serves each read as a tool `call`, or over HTTP at `oldPath`.
type Request = { path: string } & (
	| { call: { name: string; arguments: Record<string, unknown> } }
	| { oldPath: string }
);

const FEED_PAGE = 200;
// A cursor that never advances would otherwise page forever.
const PAGES = 25;
const REASONS_PAGES = 100;
// Only the first pages of a long queue are compared.
const TODAY_PAGES = 5;

const REFUSALS = new Set([400, 404, 409, 422]);

// The old system allows a session 60 tool calls a minute; each tool ask makes one.
export const pause = () =>
	new Promise<void>((resolve) => setTimeout(resolve, 1500));

// A board for a listed workspace, the invoices, the directory lists, today's
// reminders and meeting prep have no refusal to compare. Comparing one would
// match two empty answers, and an empty board or list samples no records.
const UNREFUSED = new Set<Ask["read"]>([
	"board",
	"invoices",
	"client list",
	"vendor list",
	"today's reminders",
	"meeting prep",
]);

function refusal(ask: ToolAsk, body: unknown) {
	if (UNREFUSED.has(ask.read)) throw new Error("read refused");
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

// Engine reads take the old tool's arguments as query text, an object as its JSON.
function mirrored(
	path: string,
	name: string,
	args: Record<string, unknown> = {},
): Request {
	const query = new URLSearchParams(
		Object.entries(args).map(([key, value]) => [
			key,
			typeof value === "string" ? value : JSON.stringify(value),
		]),
	).toString();
	return {
		path: query ? `${path}?${query}` : path,
		call: { name, arguments: args },
	};
}

// The old door served the directory and the Relationships map over HTTP.
const business = (path: string): Request => ({
	path: `/api/engine${path}`,
	oldPath: `/api/v1/business${path}`,
});
const DIRECTORY = "contract=vendor-directory.v1";

const leadPage = (cursor: Record<string, unknown> = {}) =>
	mirrored("/api/engine/leads", "lead-board", {
		workspace: "leads",
		...cursor,
	});

// The app's first page of reasons and each "more" after it.
const reasonsPage = (before_id?: string) =>
	mirrored(
		"/api/engine/reasons-to-reach-out",
		"list-practice-origination",
		before_id === undefined ? { limit: 25 } : { limit: 25, before_id },
	);

const todayPage = (
	{ owners }: Extract<Ask, { read: "today's reminders" }>,
	cursor?: string,
) =>
	mirrored("/api/engine/today-triage", "today-triage", {
		...(owners && { owners }),
		...(cursor !== undefined && { cursor }),
	});

function requestOf(
	ask: Exclude<ToolAsk, { read: "lead" | "today's reminders" }>,
): Request {
	switch (ask.read) {
		case "board":
			return mirrored("/api/engine/deals", "deal-room-board", {
				workspace: ask.workspace,
			});
		case "deal":
			return {
				path: `/api/engine/deals/${encodeURIComponent(ask.deal)}`,
				call: { name: "get-deal-room", arguments: { deal: ask.deal } },
			};
		// The app's first ask, with no filters.
		case "client fit":
			return mirrored("/api/engine/client-fit", "ideal-client-profile");
		case "capture queue":
			return mirrored("/api/engine/capture-queue", "capture-queue");
		case "find":
			return mirrored("/api/engine/find", "find", { query: ask.query });
		case "lead board":
			return leadPage();
		case "quiet follow-ups":
			return mirrored("/api/engine/quiet-follow-ups", "quiet-follow-ups");
		case "territory":
			return mirrored(
				"/api/engine/territory-state-board",
				"territory-state-board",
			);
		case "reasons to reach out":
			return reasonsPage();
		case "invoices":
			return mirrored("/api/engine/invoices", "read-invoice-tracker");
		case "client list":
			return business(`/clients?${DIRECTORY}`);
		case "client":
			return business(
				`/clients/${encodeURIComponent(ask.client)}?${DIRECTORY}`,
			);
		case "vendor list":
			return business(`/vendors?${DIRECTORY}`);
		// The app asks for people only on a vendor's details.
		case "vendor":
			return business(
				`/vendors/${encodeURIComponent(ask.vendor)}?contract=vendor-directory.v2`,
			);
		case "vendor markets":
			return mirrored("/api/engine/vendor-markets", "read-vendor-markets-v1");
		case "relationships":
			return business("/relationships?contract=relationship-network.v1");
		case "recent activity":
			return mirrored("/api/engine/recent-activity", "find-and-catch-up", {
				query: ask.name,
				limit: 10,
			});
		case "meeting prep":
			return mirrored(
				"/api/engine/calendar-meeting-prep",
				"calendar-meeting-prep",
			);
	}
}

function olderHistory(page: unknown, kind: "correspondence" | "stage_history") {
	const detail = isRecord(page) ? page.detail : undefined;
	const info = isRecord(detail) ? detail[`${kind}_page`] : undefined;
	return isRecord(info) && info.has_more === true
		? info.next_cursor
		: undefined;
}

const olderMail = (page: unknown) => {
	const cursor = olderHistory(page, "correspondence");
	return isRecord(cursor) ? cursor : undefined;
};
const olderStages = (page: unknown) => {
	const cursor = olderHistory(page, "stage_history");
	return typeof cursor === "string" ? cursor : undefined;
};
const nextCursor = (page: unknown) =>
	isRecord(page) && typeof page.next_cursor === "string"
		? page.next_cursor
		: undefined;

// Each side follows the cursors its own answers hand back.
async function answerOf(
	ask: ToolAsk,
	read: (request: Request) => Promise<unknown>,
	beforePage: () => Promise<void>,
) {
	async function follow<Cursor>(
		page: unknown,
		next: (page: unknown) => Cursor | undefined,
		request: (cursor: Cursor) => Request,
		limit: number,
	) {
		const pages: unknown[] = [];
		for (let cursor = next(page); cursor !== undefined; cursor = next(page)) {
			if (pages.length === limit) throw new Error("pages did not end");
			await beforePage();
			page = await read(request(cursor));
			pages.push(page);
		}
		return pages;
	}

	if (ask.read === "lead") {
		const lead_id = ask.lead;
		const opened = await read(leadPage({ lead_id }));
		return {
			opened,
			older_correspondence: await follow(
				opened,
				olderMail,
				(correspondence_cursor) => leadPage({ lead_id, correspondence_cursor }),
				PAGES,
			),
			older_stage_history: await follow(
				opened,
				olderStages,
				(stage_history_cursor) => leadPage({ lead_id, stage_history_cursor }),
				PAGES,
			),
		};
	}
	if (ask.read === "today's reminders") {
		const pages = [await read(todayPage(ask))];
		let cursor = nextCursor(pages[0]);
		while (cursor !== undefined && pages.length < TODAY_PAGES) {
			await beforePage();
			const page = await read(todayPage(ask, cursor));
			pages.push(page);
			cursor = nextCursor(page);
		}
		return { pages };
	}
	const first = await read(requestOf(ask));
	// Two unavailable calendars would match while comparing no meetings.
	if (
		ask.read === "meeting prep" &&
		isRecord(first) &&
		first.state === "unavailable"
	)
		throw new Error("meeting prep unavailable");
	if (ask.read !== "reasons to reach out") return first;
	return {
		pages: [
			first,
			...(await follow(first, nextCursor, reasonsPage, REASONS_PAGES)),
		],
	};
}

export function askers(app: URL, session: string, fetch: Fetch, wait = pause) {
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
		for (let page = 0; page < PAGES; page++) {
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

	async function readHttp(ask: ToolAsk, path: string) {
		const response = await send(path, {
			headers: { accept: "application/json" },
		});
		if (response.status === 200) return response.json();
		if (REFUSALS.has(response.status))
			return refusal(ask, await response.json());
		throw new Error("read failed");
	}

	async function askEngine(ask: Ask): Promise<unknown> {
		if (ask.read === "feed")
			return readFeed("/api/engine/pipeline/changes", ask.start);
		return answerOf(
			ask,
			({ path }) => readHttp(ask, path),
			async () => {},
		);
	}

	let rpcId = 0;
	async function askOld(ask: Ask): Promise<unknown> {
		if (ask.read === "feed") return readFeed("/pipeline/changes", ask.start);
		return answerOf(
			ask,
			async (request) => {
				if ("oldPath" in request) return readHttp(ask, request.oldPath);
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
						params: request.call,
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
			},
			wait,
		);
	}

	return { askEngine, askOld };
}
