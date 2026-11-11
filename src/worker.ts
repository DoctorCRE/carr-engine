import { Hono } from "hono";

import { requireSession, type SessionEnv } from "./session.ts";

const app = new Hono<SessionEnv>();

app.get("/health", (c) => c.json({ ok: true }));

app.use("/api/engine/*", requireSession);
app.get("/api/engine/whoami", (c) => c.json(c.get("partner")));

export default app;
