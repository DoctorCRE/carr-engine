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
	is(bytes: Uint8Array): boolean;
	minBytes?: number;
	maxBytes: number;
	refuses?(bytes: Uint8Array): Refusal | undefined;
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
const WINDOW = 1 << 20;
const latin1 = new TextDecoder("latin1");

// Read in windows so a 100 MB file is never one string. This finds the page
// objects Chrome's print-to-PDF writes; pages packed in compressed object
// streams are not seen, and LinkedIn judges those itself.
function pdfPages(bytes: Uint8Array) {
	let pages = 0;
	for (let at = 0; at < bytes.length; at += WINDOW) {
		const text = latin1.decode(bytes.subarray(at, at + WINDOW + 64));
		for (const match of text.matchAll(PAGE)) if (match.index < WINDOW) pages++;
	}
	return pages;
}

// Each type's limits are the strictest of the platforms that take it:
// Instagram takes JPEG to 8 MB and Reels to 300 MB, Facebook photos to 10 MB,
// LinkedIn images under 36 million pixels, videos from 75 KB and PDFs to
// 100 MB and 300 pages.
const MEDIA: Record<MediaType, Rule> = {
	"image/jpeg": {
		is: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
		maxBytes: 8 * MB,
		refuses: (bytes) => refusesPixels(jpegPixels(bytes)),
	},
	"image/png": {
		is: (bytes) =>
			startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		maxBytes: 10 * MB,
		refuses: (bytes) => refusesPixels(pngPixels(bytes)),
	},
	"video/mp4": {
		is: (bytes) =>
			ascii(bytes, 4, 8) === "ftyp" && MP4_BRANDS.has(ascii(bytes, 8, 12)),
		minBytes: 76_800,
		maxBytes: 300 * MB,
	},
	"application/pdf": {
		is: (bytes) => ascii(bytes, 0, 5) === "%PDF-",
		maxBytes: 100 * MB,
		refuses: (bytes) =>
			pdfPages(bytes) > MAX_PAGES ? "too_many_pages" : undefined,
	},
};

function refusal(type: MediaType, bytes: Uint8Array): Refusal | undefined {
	const rule = MEDIA[type];
	if (bytes.length < (rule.minBytes ?? 0)) return "too_small";
	if (bytes.length > rule.maxBytes) return "too_large";
	return rule.refuses?.(bytes);
}

function mediaKey(documentId: string) {
	if (!UUID.test(documentId)) throw new Error("a media key is a document id");
	return documentId;
}

// The file's own bytes decide its type; a name or extension is never trusted.
export async function storeMedia(
	bucket: {
		put(
			key: string,
			value: Uint8Array,
			options: {
				httpMetadata: { contentType: MediaType };
				onlyIf: { etagDoesNotMatch: "*" };
			},
		): Promise<object | null>;
	},
	documentId: string,
	bytes: Uint8Array,
): Promise<{ key: string; type: MediaType } | { refused: Refusal }> {
	const key = mediaKey(documentId);
	const type = (Object.keys(MEDIA) as MediaType[]).find((candidate) =>
		MEDIA[candidate].is(bytes),
	);
	if (type === undefined) return { refused: "unsupported_file" };
	const refused = refusal(type, bytes);
	if (refused) return { refused };
	// R2 answers null when the precondition fails, so a file is never replaced.
	const stored = await bucket.put(key, bytes, {
		httpMetadata: { contentType: type },
		onlyIf: { etagDoesNotMatch: "*" },
	});
	return stored === null ? { refused: "already_stored" } : { key, type };
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
