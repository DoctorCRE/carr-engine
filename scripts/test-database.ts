import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";

export class NoDatabase extends Error {}

export async function withSnapshot(run: (url: string) => Promise<void>) {
	const url = new URL(
		process.env.TEST_DATABASE_URL ??
			"postgres://postgres@127.0.0.1:5432/postgres",
	);
	if (
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		url.search
	) {
		throw new Error(
			"TEST_DATABASE_URL must identify a local throwaway PostgreSQL server without query parameters",
		);
	}
	const admin = new pg.Client({ connectionString: url.href });
	await admin.connect().catch((error: unknown) => {
		if (!(error instanceof Error && "code" in error)) throw error;
		if (error.code !== "ECONNREFUSED") throw error;
		const port = url.port || "5432";
		throw new NoDatabase(
			`No PostgreSQL server answered at ${url.host}. Start one with: docker run --rm -p 127.0.0.1:${port}:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18`,
		);
	});
	const name = `engine_test_${randomUUID().replaceAll("-", "")}`;
	try {
		await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
		url.pathname = `/${name}`;
		const db = new pg.Client({ connectionString: url.href });
		await db.connect();
		try {
			await db.query(
				await readFile(
					new URL("../schema/business.sql", import.meta.url),
					"utf8",
				),
			);
		} finally {
			await db.end();
		}
		await run(url.href);
	} finally {
		await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
		await admin.end();
	}
}
