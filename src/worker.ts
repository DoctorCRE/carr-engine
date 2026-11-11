import { Hono } from "hono";

import { connection } from "./connection.ts";
import { type DealsEnv, deals } from "./deals/routes.ts";
import { requireSession } from "./session.ts";

type WorkerEnv = DealsEnv & {
	Bindings: { CF_VERSION_METADATA: { id: string } };
};

const app = new Hono<WorkerEnv>();

app.get("/health", (c) =>
	c.json({ ok: true, version: c.env.CF_VERSION_METADATA.id }),
);

app.use("/api/engine/*", requireSession);
app.get("/api/engine/whoami", (c) => c.json(c.get("partner")));
app.route("/api/engine", connection);
app.route("/api/engine", deals);

export default app;
