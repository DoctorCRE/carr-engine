import { timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";

const SESSION_COOKIE = "__Host-dealroom_session";
type Partner = { slug: string; display: string };
type Session = { actor: Partner; csrf_token: string };
export type SessionEnv = {
	Bindings: { CARR: { fetch(request: Request): Promise<Response> } };
	Variables: { partner: Partner };
};

function parseSession(value: unknown): Session {
	if (
		typeof value !== "object" ||
		value === null ||
		!("actor" in value) ||
		typeof value.actor !== "object" ||
		value.actor === null ||
		!("slug" in value.actor) ||
		typeof value.actor.slug !== "string" ||
		!value.actor.slug.trim() ||
		!("display" in value.actor) ||
		typeof value.actor.display !== "string" ||
		!value.actor.display.trim() ||
		!("csrf_token" in value) ||
		typeof value.csrf_token !== "string" ||
		!value.csrf_token.trim()
	)
		throw new Error("Invalid session response");
	return {
		actor: { slug: value.actor.slug, display: value.actor.display },
		csrf_token: value.csrf_token,
	};
}

async function equalTokens(
	expected: string,
	received: string,
): Promise<boolean> {
	const encoder = new TextEncoder();
	const [left, right] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
		crypto.subtle.digest("SHA-256", encoder.encode(received)),
	]);
	return timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}

export const requireSession = createMiddleware<SessionEnv>(async (c, next) => {
	c.header("Cache-Control", "no-store");
	let renewed: string[] = [];
	const protect = () => {
		c.header("Cache-Control", "no-store");
		for (const value of renewed)
			c.header("Set-Cookie", value, { append: true });
	};
	const refuse = (error: string, status: 401 | 403 | 503) => {
		protect();
		return c.json({ error }, status);
	};
	const unavailable = (kind: string) => {
		console.warn("sign-in check unavailable:", kind);
		return refuse("sign_in_unavailable", 503);
	};
	const cookie = c.req
		.header("Cookie")
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${SESSION_COOKIE}=`));
	if (!cookie || cookie === `${SESSION_COOKIE}=`)
		return refuse("unauthorized", 401);

	const url = new URL(c.req.url);
	const browserOrigin = url.origin;
	url.pathname = "/auth/session";
	url.search = "";
	const headers = new Headers({ Cookie: cookie, Host: url.host });
	const origin = c.req.header("Origin");
	if (origin !== undefined) headers.set("Origin", origin);
	let response: Response;
	try {
		response = await c.env.CARR.fetch(
			new Request(url, {
				method: "GET",
				headers,
				redirect: "manual",
				signal: AbortSignal.timeout(3000),
			}),
		);
		renewed = response.headers.getSetCookie();
	} catch (error) {
		return unavailable(
			error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name)
				? error.name
				: "unknown",
		);
	}
	if (response.status === 401) return refuse("unauthorized", 401);
	if (response.status !== 200) return unavailable(`status ${response.status}`);
	let session: Session;
	try {
		session = parseSession(await response.json());
	} catch (error) {
		return unavailable(
			error instanceof Error && error.name === "TimeoutError"
				? "TimeoutError"
				: "malformed",
		);
	}

	if (c.req.method !== "GET" && c.req.method !== "HEAD") {
		const token = c.req.header("x-carr-csrf");
		if (
			origin !== browserOrigin ||
			c.req.header("Sec-Fetch-Site") !== "same-origin" ||
			!token ||
			!(await equalTokens(session.csrf_token, token))
		)
			return refuse("forbidden", 403);
	}
	c.set("partner", session.actor);
	await next();
	protect();
});
