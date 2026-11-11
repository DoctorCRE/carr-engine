import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { DB } from "./database.d.ts";

export type Reader = Transaction<DB>;

// The old system returns calendar dates as their PostgreSQL text and leaves
// every other type on the driver's defaults.
const types = {
	getTypeParser: ((oid: number, format?: "text" | "binary") =>
		oid === pg.types.builtins.DATE
			? (value: string) => value
			: pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

export async function readSnapshot<T>(
	connectionString: string,
	read: (db: Reader) => Promise<T>,
): Promise<T> {
	const db = new Kysely<DB>({
		dialect: new PostgresDialect({
			pool: new pg.Pool({ connectionString, max: 1, types }),
		}),
	});
	try {
		return await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute(async (tx) => {
				// The old reader sets no zone, so it reads in Neon's UTC default.
				await sql`set local time zone 'UTC'`.execute(tx);
				return read(tx);
			});
	} finally {
		await db.destroy();
	}
}
