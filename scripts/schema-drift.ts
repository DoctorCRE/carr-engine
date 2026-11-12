import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import madeUpValues from "../schema/made-up-literals.json" with {
	type: "json",
};
import { withSnapshot } from "./test-database.ts";

const target = process.env.SCHEMA_DATABASE_URL;
if (!target)
	throw new Error("Set SCHEMA_DATABASE_URL for the catalog to compare");
const sql = await readFile(new URL("./catalog.sql", import.meta.url), "utf8");
// The snapshot replaced real values with these, so production may differ there.
const madeUp = new Set(
	madeUpValues.map((value) => `'${value.replaceAll("'", "''")}'`),
);
const literal = /('(?:''|[^'])*')/;

async function catalog(connectionString: string) {
	const db = new pg.Client({
		connectionString,
		options: "-c default_transaction_read_only=on -c statement_timeout=15000",
	});
	try {
		await db.connect();
		await db.query("BEGIN READ ONLY");
		await db.query("SET LOCAL search_path TO pg_catalog");
		const result = await db.query<{ name: string; definition: string }>(sql);
		await db.query("ROLLBACK");
		return new Map(result.rows.map((row) => [row.name, row.definition]));
	} finally {
		await db.end();
	}
}

// Splitting on a capture group puts every quoted literal at an odd index.
function drifted(saved: string, found: string) {
	const savedParts = saved.split(literal);
	const foundParts = found.split(literal);
	return (
		savedParts.length !== foundParts.length ||
		savedParts.some(
			(part, index) =>
				part !== foundParts[index] && !(index % 2 === 1 && madeUp.has(part)),
		)
	);
}

try {
	await withSnapshot(async (url) => {
		const expected = await catalog(url);
		const actual = await catalog(target);
		for (const [name, definition] of expected) {
			const found = actual.get(name);
			if (found === undefined || drifted(definition, found)) {
				console.log(name);
				process.exitCode = 1;
			}
		}
	});
} catch {
	console.error("Catalog comparison failed");
	process.exitCode = 2;
}
