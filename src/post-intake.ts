import { type Context, Hono } from "hono";
import pg from "pg";
import { storeMedia } from "./post-media.ts";
import { DATABASE_UNAVAILABLE } from "./reader.ts";
import { UUID } from "./uuid.ts";

export type IntakeEnv = {
	Bindings: {
		NEXT_DATABASE?: { connectionString: string };
		POST_MEDIA: R2Bucket;
	};
};

type NewPost = {
	id: string;
	social_account_id: string;
	format: string;
	scheduled_at: string;
	text: string;
	media: string[];
};

// What each database refusal means to the batch.
const REFUSALS: Record<string, string> = {
	post_pkey: "post_exists",
	post_engine_publishes_from: "before_engine_publishes_from",
	post_platform_format_fkey: "format_not_offered",
	post_text_body_check: "blank_text",
	post_media_fits_format: "media_do_not_fit_format",
	post_media_position_check: "media_do_not_fit_format",
	post_media_type_fits_format: "media_type_does_not_fit_format",
};

const POST = `select jsonb_build_object(
	'id', p.id, 'social_account_id', p.social_account_id, 'platform', p.platform, 'format', p.format,
	'scheduled_at', p.scheduled_at, 'status', p.status, 'reason', p.reason,
	'platform_post_id', p.platform_post_id, 'published_at', p.published_at,
	'text', (select jsonb_build_object('version', t.version, 'body', t.body)
		from post_text t where t.post_id = p.id order by t.version desc limit 1),
	'media', coalesce((select jsonb_agg(jsonb_build_object('position', m.position,
		'document_id', m.document_id, 'content_type', m.content_type) order by m.position)
		from post_media m where m.post_id = p.id), '[]')
) as post from post p`;

const isUuid = (value: unknown): value is string =>
	typeof value === "string" && UUID.test(value);
const isInstant = (value: unknown): value is string =>
	typeof value === "string" &&
	/(Z|[+-]\d\d:\d\d)$/.test(value) &&
	!Number.isNaN(Date.parse(value));

function parsePost(body: unknown): NewPost | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const { id, social_account_id, format, scheduled_at, text, media, ...rest } =
		body as Record<string, unknown>;
	if (
		Object.keys(rest).length > 0 ||
		!isUuid(id) ||
		!isUuid(social_account_id) ||
		typeof format !== "string" ||
		!isInstant(scheduled_at) ||
		typeof text !== "string" ||
		!Array.isArray(media) ||
		!media.every(isUuid) ||
		// A text post carries no file, and every other post at least one.
		(format === "text") !== (media.length === 0)
	)
		return undefined;
	return { id, social_account_id, format, scheduled_at, text, media };
}

// The batch's weeks start on Monday in Central time.
function isMonday(week: string | undefined): week is string {
	if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) return false;
	const day = new Date(`${week}T00:00:00Z`);
	return (
		!Number.isNaN(day.getTime()) &&
		day.toISOString().startsWith(week) &&
		day.getUTCDay() === 1
	);
}

// A refusal that undoes the whole save.
class Refused extends Error {}

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
		const refusal =
			error instanceof Refused
				? error.message
				: error instanceof pg.DatabaseError && REFUSALS[error.constraint ?? ""];
		if (!refusal) throw error;
		return c.json({ error: refusal }, refusal === "post_exists" ? 409 : 422);
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
			delete: (key) => c.env.POST_MEDIA.delete(key),
		},
		id,
		body,
		length,
	);
	if ("refused" in stored) return c.json({ error: stored.refused }, 422);
	// Stored before its row, so a document never names a missing file.
	try {
		return await inTransaction(c, async (db) => {
			await db.query(
				"insert into document (id, name, r2_key, content_type) values ($1, $2, $3, $4)",
				[id, name, stored.key, stored.type],
			);
			return c.json({ document_id: id, content_type: stored.type }, 201);
		});
	} catch (error) {
		// Best effort: a file no row names is never read, only kept.
		await c.env.POST_MEDIA.delete(stored.key).catch(() => {});
		throw error;
	}
});

intake.post("/posts", async (c) => {
	const post = parsePost(await c.req.json().catch(() => undefined));
	if (!post) return c.json({ error: "invalid_post" }, 400);
	return inTransaction(c, async (db) => {
		const created = await db.query(
			`insert into post (id, social_account_id, platform, format, scheduled_at)
			select $1, id, platform, $3, $4 from social_account where id = $2`,
			[post.id, post.social_account_id, post.format, post.scheduled_at],
		);
		if (created.rowCount === 0) throw new Refused("unknown_account");
		await db.query(
			"insert into post_text (post_id, version, body) values ($1, 1, $2)",
			[post.id, post.text],
		);
		const media = await db.query(
			`insert into post_media (post_id, format, position, document_id, content_type)
			select $1, $2, m.position, d.id, d.content_type
			from unnest($3::uuid[]) with ordinality m (document_id, position)
			join document d on d.id = m.document_id`,
			[post.id, post.format, post.media],
		);
		if (media.rowCount !== post.media.length)
			throw new Refused("unknown_document");
		const { rows } = await db.query(`${POST} where p.id = $1`, [post.id]);
		return c.json(rows[0].post, 201);
	});
});

intake.get("/posts", async (c) => {
	const week = c.req.query("week");
	if (!isMonday(week)) return c.json({ error: "invalid_week" }, 400);
	return inTransaction(c, async (db) => {
		const { rows } = await db.query(
			`${POST} where p.scheduled_at >= $1::date::timestamp at time zone 'America/Chicago'
				and p.scheduled_at < ($1::date + 7)::timestamp at time zone 'America/Chicago'
			order by p.scheduled_at, p.id`,
			[week],
		);
		return c.json({ posts: rows.map((row) => row.post) });
	});
});

intake.get("/posts/:id", async (c) => {
	const id = c.req.param("id");
	if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
	return inTransaction(c, async (db) => {
		const { rows } = await db.query(`${POST} where p.id = $1`, [id]);
		return rows[0] ? c.json(rows[0].post) : c.json({ error: "not_found" }, 404);
	});
});
