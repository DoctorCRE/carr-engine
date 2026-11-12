import { Hono } from "hono";

import { connection } from "./connection.ts";
import { deals } from "./deals/routes.ts";
import { invoices } from "./invoices.ts";
import type { DatabaseEnv } from "./reader.ts";
import { requireSession } from "./session.ts";

type WorkerEnv = DatabaseEnv & {
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
app.route("/api/engine", invoices);

export default app;
