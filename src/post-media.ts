import { Buffer } from "node:buffer";
import { AwsClient } from "aws4fetch";
import { UUID } from "./uuid.ts";

type MediaType = "image/jpeg" | "image/png" | "video/mp4" | "application/pdf";
type Refusal =
	| "unsupported_file"
	| "too_small"
	| "too_large"
	| "too_many_pixels"
	| "too_many_pages"
	| "already_stored";
type Rule = {
	is(head: Uint8Array): boolean;
	minBytes?: number;
	maxBytes: number;
	refuses?(head: Uint8Array): Refusal | undefined;
	watch?(): Watch;
};
// Sees every byte on its way to storage, and stops the upload on a refusal.
type Watch = {
	stream: TransformStream<Uint8Array, Uint8Array>;
	refused(): Refusal | undefined;
};

// Decimal megabytes, the stricter reading of each platform's limit.
const MB = 1_000_000;
const MAX_PIXELS = 36_000_000;
const MAX_PAGES = 300;
// Version 4 signatures allow up to 7 days. Meta fetches a Reel's file while
// it processes, and its container lasts 24 hours.
const URL_LIFETIME_SECONDS = 24 * 60 * 60;

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
	prefix.every((byte, at) => bytes[at] === byte);
const ascii = (bytes: Uint8Array, from: number, to: number) =>
	String.fromCharCode(...bytes.subarray(from, to));
const view = (bytes: Uint8Array) =>
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// A phone's HEIC photo opens with an ftyp box too, so only video brands count.
const MP4_BRANDS = new Set([
	"isom",
	"iso2",
	"iso4",
	"iso5",
	"iso6",
	"mp41",
	"mp42",
	"avc1",
	"M4V ",
]);

function pngPixels(bytes: Uint8Array) {
	if (bytes.length < 24 || ascii(bytes, 12, 16) !== "IHDR") return undefined;
	return view(bytes).getUint32(16) * view(bytes).getUint32(20);
}

// Start-of-frame markers, which carry the size; C4, C8 and CC are not frames.
const isFrame = (marker: number) =>
	marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

function jpegPixels(bytes: Uint8Array) {
	const data = view(bytes);
	let at = 2;
	while (at + 9 <= bytes.length && bytes[at] === 0xff) {
		const marker = data.getUint8(at + 1);
		if (isFrame(marker)) return data.getUint16(at + 5) * data.getUint16(at + 7);
		at += 2 + data.getUint16(at + 2);
	}
	return undefined;
}

function refusesPixels(pixels: number | undefined): Refusal | undefined {
	if (pixels === undefined) return "unsupported_file";
	return pixels > MAX_PIXELS ? "too_many_pixels" : undefined;
}

const PAGE = /\/Type\s*\/Page(?![A-Za-z])/g;
// A page marker that starts this close to a piece's end may run into the next.
const OVERLAP = 64;
const latin1 = new TextDecoder("latin1");

// This finds the page objects Chrome's print-to-PDF writes; pages packed in
// compressed object streams are not seen, and LinkedIn judges those itself.
function pageWatch(): Watch {
	let pages = 0;
	let carry = "";
	const refused = (): Refusal | undefined =>
		pages > MAX_PAGES ? "too_many_pages" : undefined;
	const count = (text: string, until: number) => {
		for (const match of text.matchAll(PAGE)) if (match.index < until) pages++;
	};
	return {
		refused,
		stream: new TransformStream({
			transform(piece, controller) {
				const text = carry + latin1.decode(piece);
				const until = Math.max(0, text.length - OVERLAP);
				carry = text.slice(until);
				count(text, until);
				if (refused()) controller.error(new Error("too_many_pages"));
				else controller.enqueue(piece);
			},
			flush(controller) {
				count(carry, carry.length);
				if (refused()) controller.error(new Error("too_many_pages"));
			},
		}),
	};
}

// Each type's limits are the strictest of the platforms that take it:
// Instagram takes JPEG to 8 MB and Reels to 300 MB, Facebook photos to 10 MB,
// LinkedIn images under 36 million pixels, videos from 75 KB and PDFs to
// 100 MB and 300 pages.
const MEDIA: Record<MediaType, Rule> = {
	"image/jpeg": {
		is: (head) => startsWith(head, [0xff, 0xd8, 0xff]),
		maxBytes: 8 * MB,
		refuses: (head) => refusesPixels(jpegPixels(head)),
	},
	"image/png": {
		is: (head) =>
			startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		maxBytes: 10 * MB,
		refuses: (head) => refusesPixels(pngPixels(head)),
	},
	"video/mp4": {
		is: (head) =>
			ascii(head, 4, 8) === "ftyp" && MP4_BRANDS.has(ascii(head, 8, 12)),
		minBytes: 76_800,
		maxBytes: 300 * MB,
	},
	"application/pdf": {
		is: (head) => ascii(head, 0, 5) === "%PDF-",
		maxBytes: 100 * MB,
		watch: pageWatch,
	},
};

function judge(
	head: Uint8Array,
	length: number,
): { type: MediaType } | { refused: Refusal } {
	const type = (Object.keys(MEDIA) as MediaType[]).find((candidate) =>
		MEDIA[candidate].is(head),
	);
	if (type === undefined) return { refused: "unsupported_file" };
	const rule = MEDIA[type];
	if (length < (rule.minBytes ?? 0)) return { refused: "too_small" };
	if (length > rule.maxBytes) return { refused: "too_large" };
	const refused = rule.refuses?.(head);
	return refused ? { refused } : { type };
}

function mediaKey(documentId: string) {
	if (!UUID.test(documentId)) throw new Error("a media key is a document id");
	return documentId;
}

// Enough for the type and an image's size, whose markers come first.
const HEAD = 1 << 20;

async function readHead(reader: ReadableStreamDefaultReader<Uint8Array>) {
	const pieces: Uint8Array[] = [];
	let size = 0;
	while (size < HEAD) {
		const { done, value } = await reader.read();
		if (done) break;
		pieces.push(value);
		size += value.length;
	}
	return Buffer.concat(pieces);
}

const rejoined = (
	head: Uint8Array,
	reader: ReadableStreamDefaultReader<Uint8Array>,
) =>
	new ReadableStream<Uint8Array>({
		start: (controller) => controller.enqueue(head),
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel: (reason) => reader.cancel(reason),
	});

// The file's own bytes decide its type; a name or extension is never trusted.
// The file streams to storage, so a large one is never held whole. The caller
// holds the body to its declared length.
export async function storeMedia(
	bucket: {
		put(
			key: string,
			value: ReadableStream<Uint8Array>,
			options: {
				httpMetadata: { contentType: MediaType };
				onlyIf: { etagDoesNotMatch: "*" };
			},
		): Promise<object | null>;
		delete(key: string): Promise<void>;
	},
	documentId: string,
	body: ReadableStream<Uint8Array>,
	length: number,
): Promise<{ key: string; type: MediaType } | { refused: Refusal }> {
	const key = mediaKey(documentId);
	const reader = body.getReader();
	const head = await readHead(reader);
	const judged = judge(head, length);
	if ("refused" in judged) return judged;
	const { type } = judged;
	const watch = MEDIA[type].watch?.();
	const file = rejoined(head, reader);
	try {
		// R2 answers null when the precondition fails, so a file is never replaced.
		const stored = await bucket.put(
			key,
			watch ? file.pipeThrough(watch.stream) : file,
			{
				httpMetadata: { contentType: type },
				onlyIf: { etagDoesNotMatch: "*" },
			},
		);
		if (stored === null) return { refused: "already_stored" };
		// The last pages are counted only after every byte has gone to R2.
		const refused = watch?.refused();
		if (!refused) return { key, type };
		await bucket.delete(key);
		return { refused };
	} catch (error) {
		const refused = watch?.refused();
		if (refused) return { refused };
		throw error;
	}
}

export type MediaSigner = {
	R2_ACCOUNT_ID: string;
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	POST_MEDIA_BUCKET: string;
};

// The R2 binding cannot sign, so this signs with the bucket's S3 API key.
export async function signedMediaUrl(
	env: MediaSigner,
	key: string,
	now = new Date(),
): Promise<string> {
	const client = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: "s3",
		region: "auto",
	});
	const url = new URL(
		`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.POST_MEDIA_BUCKET}/${mediaKey(key)}`,
	);
	url.searchParams.set("X-Amz-Expires", String(URL_LIFETIME_SECONDS));
	const signed = await client.sign(url, {
		aws: {
			signQuery: true,
			datetime: now.toISOString().replace(/[:-]|\.\d{3}/g, ""),
		},
	});
	return signed.url;
}
