import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { DB } from "./database.d.ts";
import type { SessionEnv } from "./session.ts";

export type Reader = Transaction<DB>;
export type DatabaseEnv = SessionEnv & {
	Bindings: { DATABASE?: { connectionString: string } };
};
export const DATABASE_UNAVAILABLE = { error: "database_unavailable" };

// pg.types.builtins names no array types.
const TEXT_ARRAY = 1009;
const TIMESTAMP_ARRAY = 1115;
const DATE_ARRAY = 1182;
const TIMESTAMPTZ_ARRAY = 1185;
const NUMERIC_ARRAY = 1231;

const text = (value: string) => value;
const textArray = pg.types.getTypeParser(
	TEXT_ARRAY as Parameters<typeof pg.types.getTypeParser>[0],
);
// pg turns these into JavaScript Dates, which drop microseconds and shift
// with the machine's zone, or into floats, which lose digits.
const textParsers = new Map<number, (value: string) => unknown>([
	[pg.types.builtins.DATE, text],
	[pg.types.builtins.TIMESTAMP, text],
	[pg.types.builtins.TIMESTAMPTZ, text],
	[DATE_ARRAY, textArray],
	[TIMESTAMP_ARRAY, textArray],
	[TIMESTAMPTZ_ARRAY, textArray],
	[NUMERIC_ARRAY, textArray],
]);
const types = {
	getTypeParser: ((oid: number, format?: "text" | "binary") =>
		textParsers.get(oid) ??
		pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

export async function readSnapshot<T>(
	connectionString: string,
	read: (db: Reader) => Promise<T>,
): Promise<T> {
	const pool = new pg.Pool({ connectionString, max: 1, types });
	// A dropped pooled connection must not crash the Worker; the read's own
	// promise reports the failure.
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
