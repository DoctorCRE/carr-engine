import { Hono } from "hono";

import { activity } from "./activity/routes.ts";
import { directory } from "./clients/routes.ts";
import { connection } from "./connection.ts";
import { deals } from "./deals/routes.ts";
import { leads } from "./leads/routes.ts";
import { presence } from "./presence.ts";
import { relationships } from "./relationships/routes.ts";
import type { WriterEnv } from "./save.ts";
import { search } from "./search/routes.ts";
import { requireSession } from "./session.ts";
import { vendorMarkets } from "./vendors/market-routes.ts";

type WorkerEnv = WriterEnv & {
	Bindings: { CF_VERSION_METADATA: { id: string } };
};

const app = new Hono<WorkerEnv>();

app.get("/health", (c) =>
	c.json({ ok: true, version: c.env.CF_VERSION_METADATA.id }),
);

app.use("/api/engine/*", requireSession);
app.get("/api/engine/whoami", (c) => c.json(c.get("partner")));
app.route("/api/engine", activity);
app.route("/api/engine", directory);
app.route("/api/engine", connection);
app.route("/api/engine", deals);
app.route("/api/engine", leads);
app.route("/api/engine", presence);
app.route("/api/engine", relationships);
app.route("/api/engine", search);
app.route("/api/engine", vendorMarkets);

export default app;
