import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { DB } from "./database.d.ts";

export type Reader = Transaction<DB>;

const text = (value: string) => value;
const textArray = pg.types.getTypeParser(
	1009 as Parameters<typeof pg.types.getTypeParser>[0],
);
// pg turns these into JavaScript Dates, which drop microseconds and shift
// with the machine's zone, or into floats, which lose digits.
const asText = new Map<number, (value: string) => unknown>([
	[pg.types.builtins.DATE, text],
	[pg.types.builtins.TIMESTAMP, text],
	[pg.types.builtins.TIMESTAMPTZ, text],
	[1182, textArray],
	[1115, textArray],
	[1185, textArray],
	[1231, textArray],
]);
const types = {
	getTypeParser: ((oid: number, format?: "text" | "binary") =>
		asText.get(oid) ??
		pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

export async function readSnapshot<T>(
	connectionString: string,
	read: (db: Reader) => Promise<T>,
): Promise<T> {
	const pool = new pg.Pool({ connectionString, max: 1, types });
	pool.on("error", () => {});
	pool.on("connect", (client) => client.on("error", () => {}));
	const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
	try {
		return await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute(async (tx) => {
				// A query, unlike SET, takes the snapshot, so the caller can no
				// longer switch the transaction to read write.
				await sql`select set_config('TimeZone', 'UTC', true)`.execute(tx);
				return read(tx);
			});
	} finally {
		await db.destroy();
	}
}
