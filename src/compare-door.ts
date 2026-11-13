import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { isOneOf, PARTNERS } from "./clients/read.ts";
import { failureKind } from "./failure.ts";
import { isArguments } from "./save-door.ts";
import type { SessionEnv } from "./session.ts";

export type CompareEnv = SessionEnv & {
	Bindings: {
		// The Access team's issuer, such as https://example.cloudflareaccess.com.
		ACCESS_TEAM_DOMAIN?: string;
		ACCESS_AUD?: string;
		CARR_READS: { read(partner: string, request: Request): Promise<Response> };
	};
};

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function keysOf(team: string) {
	let keys = keySets.get(team);
	if (!keys) {
		keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", team));
		keySets.set(team, keys);
	}
	return keys;
}

// A request that skips Access, such as one to a workers.dev or preview URL,
// still reaches this door, so it checks the token itself.
export const compareDoor = createMiddleware<CompareEnv>(async (c, next) => {
	c.header("Cache-Control", "no-store");
	const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience } = c.env;
	if (!team || URL.parse(team)?.protocol !== "https:" || !audience)
		return c.json({ error: "compare_unconfigured" }, 503);
	try {
		await jwtVerify(
			c.req.header("Cf-Access-Jwt-Assertion") ?? "",
			keysOf(team),
			{
				issuer: team,
				audience,
				algorithms: ["RS256"],
				requiredClaims: ["exp"],
			},
		);
	} catch (error) {
		console.warn("compare door refused a token:", failureKind(error));
		return c.json({ error: "unauthorized" }, 401);
	}
	if (c.req.method !== "GET")
		return c.json({ error: "method_not_allowed" }, 405);
	const slug = new URL(c.req.url).pathname.split("/")[2] ?? "";
	if (!isOneOf(PARTNERS, slug))
		return c.json({ error: "unknown_partner" }, 400);
	c.set("partner", { slug, display: slug });
	await next();
	c.header("Cache-Control", "no-store");
});

// A fresh request, so no browser header such as Origin reaches the old door.
const askOld = (c: Context<CompareEnv>, path: string, init?: RequestInit) =>
	c.env.CARR_READS.read(
		c.get("partner").slug,
		new Request(new URL(path, c.req.url), init),
	);

export const oldReads = new Hono<CompareEnv>();

// The old door serves its tools only as JSON-RPC calls.
oldReads.get("/mcp/:tool", async (c) => {
	let args: unknown;
	try {
		args = JSON.parse(c.req.query("arguments") ?? "{}");
	} catch {}
	if (!isArguments(args)) return c.json({ error: "invalid_arguments" }, 400);
	return askOld(c, "/mcp", {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: c.req.param("tool"), arguments: args },
		}),
	});
});

// The old door's own address, with the query as sent.
const relay = (c: Context<CompareEnv>) => {
	const { pathname, search } = new URL(c.req.url);
	const prefix = `/compare/${c.get("partner").slug}/old`;
	return askOld(c, pathname.slice(prefix.length) + search);
};
oldReads.get("/pipeline/changes", relay);
oldReads.get("/api/v1/business/*", relay);
