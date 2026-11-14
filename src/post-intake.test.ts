import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { intake } from "./post-intake.ts";
import app from "./worker.ts";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PARTNER = id(1);
const LINKEDIN = id(2);
const INSTAGRAM = id(3);
const FACEBOOK = id(4);
// Monday 12/21 at midnight in Central time.
const ENGINE_FROM = "2026-12-21T06:00:00+00:00";
const WEEK = "2026-12-28";

// The Workers runtime's stream that holds a body to its length.
Object.assign(globalThis, {
	FixedLengthStream: class extends TransformStream {
		constructor(_length: number) {
			super();
		}
	},
});

const url = process.env.TEST_DATABASE_URL;
if (!url)
	throw new Error("Run npm run check to restore the test database first");
const name = `engine_intake_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Client({ connectionString: url });
const target = new URL(url);
target.pathname = `/${name}`;

before(async () => {
	await admin.connect();
	await admin.query(`create database "${name}" template template0`);
	const owner = new pg.Client({ connectionString: target.href });
	await owner.connect();
	await owner.query(`create schema next; set search_path = next;
		${await readFile(new URL("../schema/next.sql", import.meta.url), "utf8")}
		insert into party (id, kind, name) values ('${PARTNER}', 'person', 'Jordan Example');
		insert into social_account (id, platform, owner_party_id, handle, engine_publishes_from) values
			('${LINKEDIN}', 'linkedin', '${PARTNER}', 'jordan-example', '${ENGINE_FROM}'),
			('${INSTAGRAM}', 'instagram', '${PARTNER}', 'jordan.example', '${ENGINE_FROM}'),
			('${FACEBOOK}', 'facebook', '${PARTNER}', 'jordan-example-page', null);`);
	await owner.end();
	target.searchParams.set("options", "-c search_path=next -c role=engine");
});

after(async () => {
	await admin.query(`drop database "${name}" with (force)`);
	await admin.end();
});

const stored = new Map<string, string>();
const env = () => ({
	NEXT_DATABASE: { connectionString: target.href },
	POST_MEDIA: {
		async put(
			key: string,
			file: ReadableStream<Uint8Array>,
			options: { httpMetadata: { contentType: string } },
		) {
			await new Response(file).arrayBuffer();
			stored.set(key, options.httpMetadata.contentType);
			return {};
		},
	},
});

const jpeg = new Uint8Array(1000);
jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
jpeg.set([0xff, 0xc0, 0, 17, 8, 0x05, 0x46, 0x04, 0x38, 3], 20);

const upload = (
	file: Uint8Array,
	length = file.length,
	query = "?name=x",
	bindings: object = env(),
) =>
	intake.request(
		`/media${query}`,
		{
			method: "POST",
			body: file,
			headers: { "content-length": String(length) },
		},
		bindings,
	);
const uploaded = async () =>
	((await (await upload(jpeg)).json()) as { document_id: string }).document_id;

const create = (post: Record<string, unknown>) =>
	intake.request(
		"/posts",
		{ method: "POST", body: JSON.stringify(post) },
		env(),
	);
const photoPost = (n: number, media: string[], fields = {}) => ({
	id: id(n),
	social_account_id: LINKEDIN,
	format: "photo",
	scheduled_at: "2026-12-29T15:00:00Z",
	text: "Five example lease questions",
	media,
	...fields,
});
const read = (path: string) => intake.request(path, {}, env());
const refusal = async (answer: Response) => [
	answer.status,
	((await answer.json()) as { error: string }).error,
];

const documents = async () => {
	const db = new pg.Client({ connectionString: target.href });
	await db.connect();
	const { rows } = await db.query(
		"select id, name, r2_key, content_type from document order by name",
	);
	await db.end();
	return rows;
};

test("a file is stored under a new document id and recorded with its type", async () => {
	const answer = await upload(jpeg, jpeg.length, "?name=Example%20card.jpg");
	assert.equal(answer.status, 201);
	const { document_id, content_type } = (await answer.json()) as {
		document_id: string;
		content_type: string;
	};
	assert.equal(content_type, "image/jpeg");
	assert.equal(stored.get(document_id), "image/jpeg");
	assert.deepEqual(await documents(), [
		{
			id: document_id,
			name: "Example card.jpg",
			r2_key: document_id,
			content_type: "image/jpeg",
		},
	]);
});

test("a post goes in with its text and picture, and reads back alone and in its week", async () => {
	const upload1 = await upload(jpeg);
	assert.equal(upload1.status, 201);
	const { document_id, content_type } = (await upload1.json()) as {
		document_id: string;
		content_type: string;
	};
	assert.equal(content_type, "image/jpeg");
	assert.equal(stored.get(document_id), "image/jpeg");
	const expected = {
		id: id(10),
		social_account_id: LINKEDIN,
		platform: "linkedin",
		format: "photo",
		scheduled_at: "2026-12-29T15:00:00+00:00",
		status: "scheduled",
		reason: null,
		platform_post_id: null,
		published_at: null,
		text: { version: 1, body: "Five example lease questions" },
		media: [{ position: 1, document_id, content_type: "image/jpeg" }],
	};
	const created = await create(photoPost(10, [document_id]));
	assert.equal(created.status, 201);
	assert.deepEqual(await created.json(), expected);
	assert.deepEqual(await (await read(`/posts/${id(10)}`)).json(), expected);
	const partner = new pg.Client({ connectionString: target.href });
	await partner.connect();
	await partner.query(
		`insert into post_text (post_id, version, body, author_party_id)
		values ($1, 2, 'Six example lease questions', $2)`,
		[id(10), PARTNER],
	);
	await partner.end();
	assert.deepEqual(await (await read(`/posts/${id(10)}`)).json(), {
		...expected,
		text: { version: 2, body: "Six example lease questions" },
	});

	// Central time's Sunday night and the next Monday fall outside the week.
	for (const [n, scheduled_at] of [
		[11, "2026-12-28T05:59:00Z"],
		[12, "2026-12-28T06:00:00Z"],
		[13, "2027-01-04T05:59:00Z"],
		[14, "2027-01-04T06:00:00Z"],
	] as const)
		await create({ ...photoPost(n, []), format: "text", scheduled_at });
	const week = (await (await read(`/posts?week=${WEEK}`)).json()) as {
		posts: { id: string }[];
	};
	assert.deepEqual(
		week.posts.map((post) => post.id),
		[id(12), id(10), id(13)],
	);
	assert.deepEqual(await refusal(await read(`/posts/${id(99)}`)), [
		404,
		"not_found",
	]);
	assert.deepEqual(await refusal(await read("/posts?week=2026-12-29")), [
		400,
		"invalid_week",
	]);
});

test("a post timed before its account's engine_publishes_from is refused, and nothing is kept", async () => {
	for (const [n, fields] of [
		[20, { scheduled_at: "2026-12-21T05:59:00Z" }],
		[21, { social_account_id: FACEBOOK }],
	] as const) {
		const post = photoPost(n, [await uploaded()], fields);
		assert.deepEqual(await refusal(await create(post)), [
			422,
			"before_engine_publishes_from",
		]);
		assert.equal((await read(`/posts/${id(n)}`)).status, 404);
	}
	const ready = await create(
		photoPost(22, [await uploaded()], { scheduled_at: ENGINE_FROM }),
	);
	assert.equal(ready.status, 201);
});

test("a post whose format or files do not fit is refused, and nothing is kept", async () => {
	const photo = await uploaded();
	for (const [n, fields, refused] of [
		[30, { format: "video" }, [422, "media_type_does_not_fit_format"]],
		[31, { media: [photo, photo] }, [422, "media_do_not_fit_format"]],
		[
			32,
			{ social_account_id: INSTAGRAM, format: "text", media: [] },
			[422, "format_not_offered"],
		],
		[33, { media: [id(99)] }, [422, "unknown_document"]],
		[34, { social_account_id: id(99) }, [422, "unknown_account"]],
		[35, { text: " " }, [422, "blank_text"]],
		[36, { media: [] }, [400, "invalid_post"]],
		[37, { format: "text" }, [400, "invalid_post"]],
		[38, { scheduled_at: "2026-12-29T15:00:00" }, [400, "invalid_post"]],
		[39, { alt_text: "Example" }, [400, "invalid_post"]],
	] as const) {
		const post = photoPost(n, [photo], fields);
		assert.deepEqual(await refusal(await create(post)), refused);
		assert.equal((await read(`/posts/${id(n)}`)).status, 404);
	}
	assert.equal((await create(photoPost(40, [photo]))).status, 201);
	assert.deepEqual(await refusal(await create(photoPost(40, [photo]))), [
		409,
		"post_exists",
	]);
});

test("a file of the wrong type or size, or one the database cannot record, is refused, and nothing is stored", async () => {
	const [files, rows] = [stored.size, (await documents()).length];
	for (const [answer, refused] of [
		[
			upload(new TextEncoder().encode("an example caption")),
			[422, "unsupported_file"],
		],
		[upload(jpeg, 8_000_001), [422, "too_large"]],
		[upload(jpeg, 0), [411, "length_required"]],
		[upload(jpeg, jpeg.length, ""), [400, "name_required"]],
		[
			upload(jpeg, jpeg.length, "?name=x", { POST_MEDIA: env().POST_MEDIA }),
			[503, "database_unavailable"],
		],
	] as const)
		assert.deepEqual(await refusal(await answer), refused);
	assert.equal(stored.size, files);
	assert.equal((await documents()).length, rows);
});

test("intake answers only through its own Access application", async () => {
	const ask = (bindings: object) =>
		app.request(
			"/intake/media?name=x",
			{ method: "POST", body: jpeg },
			{ ...env(), ...bindings },
		);
	assert.deepEqual(await refusal(await ask({})), [503, "intake_unconfigured"]);
	const team = "https://example.cloudflareaccess.com";
	assert.deepEqual(
		await refusal(
			await ask({ ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: "made-up-compare" }),
		),
		[503, "intake_unconfigured"],
	);
	assert.deepEqual(
		await refusal(
			await ask({ ACCESS_TEAM_DOMAIN: team, INTAKE_ACCESS_AUD: "made-up" }),
		),
		[401, "unauthorized"],
	);
});
