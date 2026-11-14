import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { signedMediaUrl, storeMedia } from "./post-media.ts";

const DOCUMENT = "00000000-0000-4000-8000-000000000001";
const MB = 1_000_000;
const SIGNER = {
	R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
	R2_ACCESS_KEY_ID: "EXAMPLEACCESSKEY",
	R2_SECRET_ACCESS_KEY: "example-secret-access-key",
	POST_MEDIA_BUCKET: "example-post-media",
};

function bucket() {
	const stored = new Map<string, string>();
	return {
		stored,
		async put(
			key: string,
			value: ReadableStream<Uint8Array>,
			options: {
				httpMetadata: { contentType: string };
				onlyIf: { etagDoesNotMatch: string };
			},
		) {
			if (options.onlyIf.etagDoesNotMatch === "*" && stored.has(key))
				return null;
			await new Response(value).arrayBuffer();
			stored.set(key, options.httpMetadata.contentType);
			return {};
		},
	};
}

const PIECE = 64 * 1024;
// A file arriving in pieces, as a request body does.
function arriving(file: Uint8Array) {
	let pulled = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (pulled >= file.length) return controller.close();
			controller.enqueue(file.subarray(pulled, pulled + PIECE));
			pulled += PIECE;
		},
	});
	return { body, pulled: () => pulled };
}
const store = (
	media: ReturnType<typeof bucket>,
	file: Uint8Array,
	id = DOCUMENT,
) => storeMedia(media, id, arriving(file).body, file.length);

const bytes = (size: number, ...parts: (string | number[])[]) => {
	const file = new Uint8Array(size);
	file.set(
		parts.flatMap((part) =>
			typeof part === "string" ? [...Buffer.from(part)] : part,
		),
	);
	return file;
};
const u16 = (value: number) => [value >> 8, value & 0xff];
const u32 = (value: number) => [...u16(value >>> 16), ...u16(value & 0xffff)];

const jpeg = (width: number, height: number, size = 1000) =>
	bytes(
		size,
		[0xff, 0xd8, 0xff, 0xe0, ...u16(16)],
		"JFIF\0",
		Array(9).fill(0),
		[0xff, 0xc0, ...u16(17), 8, ...u16(height), ...u16(width), 3],
	);
const png = (width: number, height: number) =>
	bytes(
		100,
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13)],
		"IHDR",
		[...u32(width), ...u32(height)],
	);
const mp4 = (brand: string, size: number) =>
	bytes(size, u32(24), `ftyp${brand}`);

function pdf(pageAt: number[], size = 3 * MB) {
	const file = bytes(size, "%PDF-1.4\n");
	for (const at of pageAt) file.set(Buffer.from("/Type /Page\n"), at);
	return file;
}
const pagesAt = (count: number) =>
	Array.from({ length: count }, (_, page) => 100 + page * 9_000);

test("a file's own bytes decide its type, and other files are refused", async () => {
	for (const [file, type] of [
		[jpeg(1080, 1350), "image/jpeg"],
		[png(1080, 1350), "image/png"],
		[mp4("isom", 200_000), "video/mp4"],
		[pdf(pagesAt(8)), "application/pdf"],
	] as const) {
		const media = bucket();
		assert.deepEqual(await store(media, file), {
			key: DOCUMENT,
			type,
		});
		assert.equal(media.stored.get(DOCUMENT), type);
	}
	const media = bucket();
	for (const file of [
		bytes(1000, "an example caption, not a picture"),
		bytes(1000, "GIF89a"),
		mp4("heic", 200_000),
		bytes(1000, [0xff, 0xd8, 0xff, 0xd9]),
	]) {
		assert.deepEqual(await store(media, file), {
			refused: "unsupported_file",
		});
	}
	assert.equal(media.stored.size, 0);
});

test("a file outside its type's size limits is refused", async () => {
	const media = bucket();
	for (const [file, refused] of [
		[pdf([100], 100 * MB + 1), "too_large"],
		[jpeg(1080, 1350, 8 * MB + 1), "too_large"],
		[mp4("mp42", 300 * MB + 1), "too_large"],
		[mp4("mp42", 76_799), "too_small"],
	] as const) {
		assert.deepEqual(await store(media, file), { refused });
	}
	assert.equal(media.stored.size, 0);
	assert.ok("key" in (await store(media, pdf([100], 100 * MB))));
});

test("an image over 36 million pixels is refused", async () => {
	const media = bucket();
	assert.ok("key" in (await store(media, png(6000, 6000))));
	assert.deepEqual(await store(media, png(6000, 6001)), {
		refused: "too_many_pixels",
	});
	assert.deepEqual(await store(media, jpeg(6001, 6000)), {
		refused: "too_many_pixels",
	});
});

test("an image's size is read when its frame comes after the first piece", async () => {
	// Two large metadata segments, as a phone's EXIF and XMP can be.
	const photo = (width: number, height: number) => {
		const file = bytes(200_000, [0xff, 0xd8]);
		for (const at of [2, 60_004]) file.set([0xff, 0xe1, ...u16(60_000)], at);
		file.set(
			[0xff, 0xc0, ...u16(17), 8, ...u16(height), ...u16(width)],
			120_006,
		);
		return file;
	};
	assert.ok("key" in (await store(bucket(), photo(1080, 1350))));
	assert.deepEqual(await store(bucket(), photo(6001, 6000)), {
		refused: "too_many_pixels",
	});
});

test("a PDF over 300 pages is refused, wherever its pages sit", async () => {
	const straddling = 40 * PIECE - 5;
	assert.ok("key" in (await store(bucket(), pdf(pagesAt(300)))));
	for (const last of [straddling, 3 * MB - 12])
		assert.deepEqual(await store(bucket(), pdf([...pagesAt(300), last])), {
			refused: "too_many_pages",
		});
});

test("a PDF is refused as soon as it passes 300 pages, and nothing is kept", async () => {
	const media = bucket();
	const file = arriving(pdf(pagesAt(301), 100 * MB));
	assert.deepEqual(await storeMedia(media, DOCUMENT, file.body, 100 * MB), {
		refused: "too_many_pages",
	});
	assert.ok(file.pulled() < 10 * MB);
	assert.equal(media.stored.size, 0);
});

test("a stored file is keyed and linked by its document id alone", async () => {
	const name = "example-clinic-flyer.jpg";
	await assert.rejects(store(bucket(), jpeg(10, 10), name));
	await assert.rejects(signedMediaUrl(SIGNER, name));
});

test("a stored file is never replaced", async () => {
	const media = bucket();
	assert.ok("key" in (await store(media, jpeg(10, 10))));
	assert.deepEqual(await store(media, png(10, 10)), {
		refused: "already_stored",
	});
	assert.equal(media.stored.get(DOCUMENT), "image/jpeg");
});

// An independent check of an AWS version 4 query signature, as R2 makes it.
function verifies(signed: string, now: Date) {
	const url = new URL(signed);
	const query = url.searchParams;
	const amzDate = query.get("X-Amz-Date") ?? "";
	const issued = Date.parse(
		amzDate.replace(
			/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/,
			"$1-$2-$3T$4:$5:$6Z",
		),
	);
	if (now.getTime() > issued + Number(query.get("X-Amz-Expires")) * 1000)
		return false;
	const [accessKey, ...scope] = (query.get("X-Amz-Credential") ?? "").split(
		"/",
	);
	if (accessKey !== SIGNER.R2_ACCESS_KEY_ID) return false;
	const canonicalQuery = [...query]
		.filter(([name]) => name !== "X-Amz-Signature")
		.map(
			([name, value]) =>
				`${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
		)
		.sort()
		.join("&");
	const request = [
		"GET",
		url.pathname,
		canonicalQuery,
		`host:${url.host}\n`,
		"host",
		"UNSIGNED-PAYLOAD",
	];
	const digest = createHash("sha256").update(request.join("\n")).digest("hex");
	const toSign = ["AWS4-HMAC-SHA256", amzDate, scope.join("/"), digest].join(
		"\n",
	);
	const key = scope.reduce<Buffer>(
		(secret, part) => createHmac("sha256", secret).update(part).digest(),
		Buffer.from(`AWS4${SIGNER.R2_SECRET_ACCESS_KEY}`),
	);
	return (
		createHmac("sha256", key).update(toSign).digest("hex") ===
		query.get("X-Amz-Signature")
	);
}

test("a signed link verifies for 24 hours and no longer, and only unchanged", async () => {
	const issued = new Date("2026-11-13T12:00:00Z");
	const signed = await signedMediaUrl(SIGNER, DOCUMENT, issued);
	const url = new URL(signed);
	assert.equal(url.host, `${SIGNER.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
	assert.equal(url.pathname, `/${SIGNER.POST_MEDIA_BUCKET}/${DOCUMENT}`);
	assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
	assert.equal(
		url.searchParams.get("X-Amz-Credential"),
		`${SIGNER.R2_ACCESS_KEY_ID}/20261113/auto/s3/aws4_request`,
	);
	assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
	assert.equal(verifies(signed, issued), true);
	assert.equal(verifies(signed, new Date("2026-11-14T12:00:00Z")), true);
	assert.equal(verifies(signed, new Date("2026-11-14T12:00:01Z")), false);
	const other = "00000000-0000-4000-8000-000000000002";
	assert.equal(verifies(signed.replace(DOCUMENT, other), issued), false);
	url.searchParams.set("X-Amz-Expires", "604800");
	assert.equal(verifies(url.href, new Date("2026-11-15T12:00:00Z")), false);
});
