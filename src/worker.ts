import { Hono } from "hono";

import { connection } from "./connection.ts";
import { requireSession, type SessionEnv } from "./session.ts";

type WorkerEnv = SessionEnv & {
	Bindings: { CF_VERSION_METADATA: { id: string } };
};

const app = new Hono<WorkerEnv>();

app.get("/health", (c) =>
	c.json({ ok: true, version: c.env.CF_VERSION_METADATA.id }),
);

app.use("/api/engine/*", requireSession);
app.get("/api/engine/whoami", (c) => c.json(c.get("partner")));
app.route("/api/engine", connection);

export default app;
