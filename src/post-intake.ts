import { type Context, Hono } from "hono";
import pg from "pg";
import { storeMedia } from "./post-media.ts";
import { DATABASE_UNAVAILABLE } from "./reader.ts";

export type IntakeEnv = {
	Bindings: {
		NEXT_DATABASE?: { connectionString: string };
		POST_MEDIA: R2Bucket;
	};
};

async function inTransaction<T>(
	c: Context<IntakeEnv>,
	run: (db: pg.Client) => Promise<T>,
): Promise<T | Response> {
	const database = c.env.NEXT_DATABASE;
	if (!database) return c.json(DATABASE_UNAVAILABLE, 503);
	const db = new pg.Client({ connectionString: database.connectionString });
	db.on("error", () => {});
	await db.connect();
	try {
		await db.query("begin; set local time zone 'UTC'");
		const result = await run(db);
		await db.query("commit");
		return result;
	} catch (error) {
		await db.query("rollback");
		throw error;
	} finally {
		await db.end();
	}
}

export const intake = new Hono<IntakeEnv>();

intake.post("/media", async (c) => {
	const length = Number(c.req.header("content-length"));
	const body = c.req.raw.body;
	if (!body || !Number.isSafeInteger(length) || length <= 0)
		return c.json({ error: "length_required" }, 411);
	const name = c.req.query("name")?.trim();
	if (!name) return c.json({ error: "name_required" }, 400);
	if (!c.env.NEXT_DATABASE) return c.json(DATABASE_UNAVAILABLE, 503);
	const id = crypto.randomUUID();
	const stored = await storeMedia(
		{
			put: (key, file, options) =>
				c.env.POST_MEDIA.put(
					key,
					file.pipeThrough(new FixedLengthStream(length)),
					options,
				),
		},
		id,
		body,
		length,
	);
	if ("refused" in stored) return c.json({ error: stored.refused }, 422);
	// Stored before its row, so a document never names a missing file.
	return inTransaction(c, async (db) => {
		await db.query(
			"insert into document (id, name, r2_key, content_type) values ($1, $2, $3, $4)",
			[id, name, stored.key, stored.type],
		);
		return c.json({ document_id: id, content_type: stored.type }, 201);
	});
});
