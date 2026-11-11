import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { withSnapshot } from "./test-database.ts";

const target = process.env.SCHEMA_DATABASE_URL;
if (!target)
	throw new Error("Set SCHEMA_DATABASE_URL for the catalog to compare");
const sql = await readFile(new URL("./catalog.sql", import.meta.url), "utf8");
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
try {
	await withSnapshot(async (url) => {
		const expected = await catalog(url);
		const actual = await catalog(target);
		for (const [name, definition] of expected) {
			if (actual.get(name) !== definition) {
				console.log(name);
				process.exitCode = 1;
			}
		}
	});
} catch {
	console.error("Catalog comparison failed");
	process.exitCode = 2;
}
