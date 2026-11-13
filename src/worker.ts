import { Hono } from "hono";

import { activity } from "./activity/routes.ts";
import { calendar } from "./calendar/routes.ts";
import { directory } from "./clients/routes.ts";
import { type CompareEnv, compareDoor, oldReads } from "./compare-door.ts";
import { connection } from "./connection.ts";
import { deals } from "./deals/routes.ts";
import { invoices } from "./invoices.ts";
import { leads } from "./leads/routes.ts";
import { presence } from "./presence.ts";
import { relationships } from "./relationships/routes.ts";
import type { WriterEnv } from "./save.ts";
import { search } from "./search/routes.ts";
import { requireSession } from "./session.ts";
import { today } from "./today/routes.ts";
import { vendorMarkets } from "./vendors/market-routes.ts";
import { vendorMeetings } from "./vendors/meeting-routes.ts";

type WorkerEnv = WriterEnv &
	CompareEnv & {
		Bindings: { CF_VERSION_METADATA: { id: string } };
	};

// Routes match the raw path as the old door did, but still decode their values.
const app = new Hono<WorkerEnv>({
	getPath: (request) => new URL(request.url).pathname,
});
app.notFound((c) => c.json({ error: "not_found" }, 404));

app.get("/health", (c) =>
	c.json({ ok: true, version: c.env.CF_VERSION_METADATA.id }),
);

const engine = new Hono<WorkerEnv>()
	.get("/whoami", (c) => c.json(c.get("partner")))
	.route("/", activity)
	.route("/", calendar)
	.route("/", directory)
	.route("/", connection)
	.route("/", deals)
	.route("/", invoices)
	.route("/", leads)
	.route("/", presence)
	.route("/", relationships)
	.route("/", search)
	.route("/", today)
	.route("/", vendorMarkets)
	.route("/", vendorMeetings);

app.use("/api/engine/*", requireSession);
app.route("/api/engine", engine);

// The app forwards only /api/engine/*, so this door is reached directly.
app.use("/compare/*", compareDoor);
app.route("/compare/:partner/engine", engine);
app.route("/compare/:partner/old", oldReads);

export default app;
