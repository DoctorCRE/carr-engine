import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { URL } from "node:url";
import pg from "pg";
import { intake } from "./post-intake.ts";
import app from "./worker.ts";

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
		${await readFile(new URL("../schema/next.sql", import.meta.url), "utf8")}`);
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
